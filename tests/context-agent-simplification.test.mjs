import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createSession, appendRecord, HistoryStore } from '../server/context-agent/history.mjs';
import { buildContext } from '../server/context-agent/context.mjs';
import { createTools, approveProposals } from '../server/context-agent/tools.mjs';
import { loadAgentCatalog, readAgentSkill } from '../server/context-agent/skills.mjs';
import { assembleAgentTools } from '../server/context-agent/runtime.mjs';

const say = text => [{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const msg = (state,text,role='user') => appendRecord(state,{kind:'message',role,content:text});
const img = (state,id,extra={}) => state.assets[id]={id,type:'image',version:1,url:`https://example.test/${id}.png`,...extra};
const ctx = state => ({state,ownerId:state.ownerId,turnId:'turn',callId:'call',maxMediaCalls:2,save:async()=>{}});
const blocks = input => input.filter(v=>typeof v.content==='string'&&v.content.startsWith('Context reference data')).map(v=>JSON.parse(v.content.split('\n')[1]));

test('P1 methods: all enabled final method pages and references are direct versioned files without old execution protocols', async()=>{
  const catalog=await loadAgentCatalog();assert.equal(catalog.skills.length,15);
  const forbidden=/compiled|item合同|当前item|当前节点|消费者合同|渲染器|structure\.(shots|prompt|facts|directions|durationSeconds|safeAlternative)|get_skill_script|run_skill_script|find_material|wait_video_task|read_video/;
  const tools=createTools({catalog});const state=createSession();
  for(const skill of catalog.skills){
    let all='',next=0,first;
    do{
      const page=await tools.execute('read_skill',{slug:skill.slug,offset:next},ctx(state));
      assert.equal(page.ok,true);assert.equal(page.version,'context-methods-v1');first ||=page;
      all+=page.content;next=page.nextOffset;
    }while(next!==null);
    const raw=await readFile(new URL(`../server/context-agent/methods/v1/${skill.slug}/method.md`,import.meta.url),'utf8');
    assert.equal(all,raw);assert.doesNotMatch(all,forbidden,skill.slug);
    for(const ref of first.resources){
      let content='',offset=0;
      do{const page=await readAgentSkill(catalog,skill.slug,ref.id,offset);content+=page.content;offset=page.nextOffset;}while(offset!==null);
      assert.doesNotMatch(content,forbidden,`${skill.slug}/${ref.id}`);
    }
  }
});

test('P1 directories: 0/100/200/300/1000 old assets cannot block a short new query and old objects remain searchable',async()=>{
  const tools=createTools({mode:'live'});
  for(const count of [0,100,200,300,1000]){
    const state=createSession();
    for(let i=0;i<count;i++)state.assets['old_'+i]={id:'old_'+i,type:'text',title:'历史文稿标题'.repeat(20),content:'原始正文-'+i,version:i+1,sourceIds:Array(50).fill('source')};
    msg(state,'你好');const before=JSON.stringify(state);
    const view=buildContext(state,{tokenBudget:24000,reservedTokens:6000});
    assert.ok(view.metrics.estimatedInputTokens<6000);assert.equal(JSON.stringify(state),before);
    const directory=blocks(view.input).find(b=>b.assetDirectory)?.assetDirectory||[];assert.ok(directory.length<=24);
    if(count){
      const found=await tools.execute('list_assets',{query:'old_0'},ctx(state));assert.equal(found.assets[0].id,'old_0');
      const read=await tools.execute('read_asset',{id:'old_0'},ctx(state));assert.equal(read.asset.content,'原始正文-0');
      msg(state,'修改 old_0，其他保持不变');
      assert.equal(blocks(buildContext(state).input).find(b=>b.assetDirectory).assetDirectory[0].id,'old_0');
    }
  }
});

test('P1 approval directory: hundreds of full parameter receipts stay out of default context and remain accessible by ID',async()=>{
  const state=createSession(),tools=createTools();
  for(let i=0;i<200;i++){
    state.approvals['p'+i]={kind:'proposal',proposalId:'p'+i,ownerId:state.ownerId,sessionId:state.id,name:'generate_image',args:{prompt:'完整批准参数'.repeat(2000),size:'1K'},digest:'d'+i};
    state.approvals['a'+i]={kind:'approval',approvalId:'a'+i,ownerId:state.ownerId,sessionId:state.id,proposalIds:['p'+i],digests:{['p'+i]:'d'+i}};
  }
  msg(state,'你好');const view=buildContext(state,{tokenBudget:24000,reservedTokens:6000});
  assert.ok(view.metrics.estimatedInputTokens<3000);assert.ok(!JSON.stringify(view.input).includes('完整批准参数'));
  const exact=await tools.execute('read_approval',{proposalId:'p0',approvalId:'a0'},ctx(state));
  assert.equal(exact.proposal.args.prompt,state.approvals.p0.args.prompt);
});

test('P1 omitted Skill pointers are deduplicated and bounded without removing raw history',()=>{
  const state=createSession();
  for(let i=0;i<100;i++){
    appendRecord(state,{kind:'tool_call',name:'read_skill',callId:'s'+i,arguments:JSON.stringify({slug:'method-'+i%12}),groupId:'g'+i});
    appendRecord(state,{kind:'tool_result',callId:'s'+i,output:'old method'.repeat(1800),groupId:'g'+i});
  }
  msg(state,'当前请求');const view=buildContext(state,{tokenBudget:6000});
  const notice=blocks(view.input).find(b=>b.historyWindow);
  assert.ok(notice.historyWindow.omittedSkillReads.length<=6);
  assert.equal(state.records.length,201);assert.ok(view.metrics.estimatedInputTokens<=6000);
});

test('P1 shared assembly: explicit vision flag controls actual input_image wire; provider calls share runtime budget wrapper',async()=>{
  let input,wrapped=0;
  const brain={respond:async messages=>{input=messages;return say('尺寸与结构无法确认');}};
  const catalog=await loadAgentCatalog();
  const disabled=assembleAgentTools({catalog,mode:'simulation'});
  assert.ok(!disabled.definitions.some(t=>t.name==='analyze_image'));
  const enabled=assembleAgentTools({catalog,mode:'simulation',visionEnabled:true,visionBrain:brain});
  const state=createSession();img(state,'real');
  const result=await enabled.execute('analyze_image',{imageIds:['real'],question:'外观？'},{...ctx(state),modelRespond:async(adapter,messages,defs,meta)=>{wrapped++;assert.equal(meta.phase,'image_observation');assert.deepEqual(defs,[]);return adapter.respond(messages);}});
  assert.equal(result.ok,true);assert.equal(wrapped,1);
  assert.ok(input[1].content.some(p=>p.type==='input_image'&&p.image_url.endsWith('/real.png')));
  for(const file of ['../server/context-agent/index.mjs','../evals/context-agent-evaluate.mjs'])assert.match(await readFile(new URL(file,import.meta.url),'utf8'),/assembleAgentTools/);
});

test('P2 observation: single image OCR does not load a missing parent or unrelated source',async()=>{
  let received;
  const tools=createTools({observeImages:async value=>{received=value;return {text:'标签可见'};}}),state=createSession();
  img(state,'result',{parentId:'missing-parent',sourceIds:['missing-document']});
  const result=await tools.execute('analyze_image',{imageIds:['result'],question:'读标签'},ctx(state));
  assert.equal(result.ok,true);assert.deepEqual(received.images.map(i=>i.id),['result']);assert.deepEqual(received.materials,[]);
  const comparison=await tools.execute('compare_images',{sourceImageId:'missing-parent',resultImageId:'result',question:'保持？'},ctx(state));
  assert.equal(comparison.error.code,'asset_not_found');
});

test('P2 observation: stored material size is budgeted before provider I/O; explicit source excerpt is attributable',async()=>{
  let calls=0,received;
  const tools=createTools({observationTokenBudget:6000,observeImages:async value=>{calls++;received=value;return {text:'不能确认'};}}),state=createSession();
  img(state,'image');state.assets.facts={id:'facts',type:'text',version:1,content:'未知项。'.repeat(30000)};
  const base={imageIds:['image'],question:'事实边界',materials:[{sourceId:'facts'}]};
  const rejected=await tools.execute('analyze_image',base,ctx(state));
  assert.equal(rejected.error.code,'observation_budget_exceeded');assert.equal(calls,0);
  assert.equal(rejected.materials[0].totalLength,120000);
  const accepted=await tools.execute('analyze_image',{...base,materials:[{sourceId:'facts',offset:4,limit:80}]},ctx(state));
  assert.equal(accepted.ok,true);assert.equal(calls,1);assert.equal(received.materials[0].provenance,'stored_excerpt');
  assert.equal(received.materials[0].offset,4);assert.equal(received.materials[0].content,state.assets.facts.content.slice(4,84));
});

test('P2 document: one call archives exact chat original and revision atomically, including rollback and replay',async()=>{
  const tools=createTools(),state=createSession();const original=msg(state,'原稿保持红杯，原始旁白。','assistant');
  const args={parentMessageId:original.id,content:'15秒红杯旁白。'};
  const failed=await tools.execute('save_document',args,{...ctx(state),save:async()=>{throw new Error('disk failure');}});
  assert.equal(failed.ok,false);assert.equal(Object.keys(state.assets).length,0);assert.equal(Object.keys(state.invocations).length,0);
  let saves=0;const context={...ctx(state),save:async()=>{saves++;}};
  const result=await tools.execute('save_document',args,context);
  const parent=state.assets[result.asset.parentId];
  assert.equal(parent.content,original.content);assert.equal(parent.sourceMessageId,original.id);assert.equal(result.asset.version,2);assert.equal(saves,1);
  assert.equal((await tools.execute('save_document',args,context)).asset.id,result.asset.id);assert.equal(saves,1);
});

test('P2 approved execution: identifiers restore exact parameters; extra args, altered digest and changed mode fail closed',async()=>{
  const state=createSession();let received,calls=0;
  const tools=createTools({mode:'live',media:{image:async args=>{calls++;received=args;return {status:'succeeded',images:[{url:'https://example.test/result.png'}]};}}});
  const context=ctx(state),args={prompt:'准确的方案正文',size:'1024x1024'};
  const proposal=await tools.execute('generate_image',args,context);
  const approval=await approveProposals(state,{proposalIds:[proposal.proposalId],ownerId:state.ownerId},context.save);
  const ids={proposalId:proposal.proposalId,approvalId:approval.approvalId};
  assert.equal((await tools.execute('execute_approved',{...ids,prompt:'偷偷变更'},context)).error.code,'invalid_arguments');
  assert.equal((await createTools().execute('execute_approved',ids,context)).error.code,'approval_parameters_changed');
  const result=await tools.execute('execute_approved',ids,context);
  assert.equal(result.status,'succeeded');assert.equal(received.prompt,args.prompt);assert.equal(calls,1);
  assert.equal((await tools.execute('execute_approved',ids,context)).receiptId,result.receiptId);assert.equal(calls,1);
});

async function storeFixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'context-journal-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new HistoryStore(directory),state=await store.create('owner');
  return {directory,store,state,file:path.join(directory,createHash('sha256').update('owner').digest('hex'),state.id+'.sqlite')};
}

test('P2 storage: full trace is separate; append payload does not rewrite old history, trace or asset body',async t=>{
  const {store,state,file}=await storeFixture(t);
  const record=appendRecord(state,{kind:'run_event',event:'model_request',traceId:'trace1',input:[{role:'user',content:'大段输入'.repeat(20000)}],tools:[]});
  state.assets.document={id:'document',type:'text',version:1,content:'资产正文'.repeat(20000)};
  for(let i=0;i<300;i++)msg(state,'历史-'+i);
  await store.save(state,'owner');
  const loaded=await store.load(state.id,'owner');
  assert.equal(loaded.records[0].input,undefined);assert.equal(loaded.records[0].traceRef.recordId,record.id);
  assert.deepEqual(await loaded.readTrace(record.id),record);
  msg(loaded,'新的短消息');const result=await store.save(loaded,'owner');
  assert.equal(result.appendedRecords,1);assert.ok(result.payloadBytesWritten<1000);
  const db=new DatabaseSync(file,{readOnly:true});
  try{assert.equal(db.prepare('SELECT count(*) AS n FROM traces').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,302);}finally{db.close();}
  const history=await createTools().execute('read_history',{messageId:record.id,offset:0,limit:1000},ctx(loaded));
  assert.equal(history.ok,true);assert.equal(history.pagination.totalLength,JSON.stringify(record).length);
  const exported=await store.exportSession(state.id,'owner');
  assert.deepEqual(exported.records[0],record);assert.equal(exported.records.at(-1).content,'新的短消息');
  assert.equal(exported.assets.document.content,state.assets.document.content);
});

test('P2 storage: legacy JSON migrates without removal; stale object-only updates and history rewrites are blocked',async t=>{
  const {directory,store}=await storeFixture(t),state=createSession({ownerId:'owner'});
  msg(state,'旧会话原文');state.assets.doc={id:'doc',type:'text',content:'原稿',version:1};
  const file=path.join(directory,createHash('sha256').update('owner').digest('hex'),state.id+'.json');
  await mkdir(path.dirname(file),{recursive:true});const original=JSON.stringify(state);await writeFile(file,original);
  const a=await store.load(state.id,'owner'),b=await store.load(state.id,'owner');
  assert.equal(await readFile(file,'utf8'),original);
  a.invocations.receipt={status:'inflight',attempted:true};await store.save(a,'owner');
  b.invocations.receipt={status:'succeeded',attempted:false};await assert.rejects(store.save(b,'owner'),{code:'STALE_SESSION'});
  const altered=await store.load(state.id,'owner');altered.assets.doc={...altered.assets.doc,content:'overwrite'};
  await assert.rejects(store.save(altered,'owner'),{code:'IMMUTABLE_OBJECT'});
  const current=await store.load(state.id,'owner');assert.equal(current.invocations.receipt.attempted,true);
  current.records[0]={...current.records[0],content:'改写历史'};
  await assert.rejects(store.save(current,'owner'),{code:'HISTORY_REWRITE_FORBIDDEN'});
});

test('P2 storage: paid submission persists inflight before provider and survives restart without duplication',async t=>{
  const {store,state}=await storeFixture(t);let calls=0;
  const tools=createTools({mode:'live',media:{image:async()=>{calls++;const durable=await store.load(state.id,'owner');assert.ok(Object.values(durable.invocations).some(i=>i.status==='inflight'&&i.attempted));throw new Error('unknown transport outcome');}}});
  const save=s=>store.save(s,'owner');const context={...ctx(state),save};
  const proposal=await tools.execute('generate_image',{prompt:'只生成一张',size:'1K'},context);
  const approval=await approveProposals(state,{proposalIds:[proposal.proposalId],ownerId:'owner'},save);
  const ids={proposalId:proposal.proposalId,approvalId:approval.approvalId};
  const result=await tools.execute('execute_approved',ids,context);assert.equal(result.status,'unknown');
  const restored=await store.load(state.id,'owner');
  const replay=await tools.execute('execute_approved',ids,{...context,state:restored});assert.equal(replay.status,'unknown');assert.equal(calls,1);
});

test('P2 dependencies: context runtime avoids legacy contract loaders and unused batch execution entry',async()=>{
  const skills=await readFile(new URL('../server/context-agent/skills.mjs',import.meta.url),'utf8');
  const tools=await readFile(new URL('../server/context-agent/tools.mjs',import.meta.url),'utf8');
  const measure=await readFile(new URL('../server/text-measure.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(skills,/catalog\.mjs|skillContract|methods\[|descriptions\[/);
  assert.doesNotMatch(tools,/hard-requirements\.mjs|executeBatch|readConcurrency/);
  assert.doesNotMatch(measure,/import /);
});

test('P1 evaluation: model, vision and paid media authorization gates reject before provider setup',()=>{
  const file=fileURLToPath(new URL('../evals/context-agent-evaluate.mjs',import.meta.url));
  const cases=[
    {args:['--real'],env:{CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED:'0'},error:/Real model disabled/},
    {args:['--real','--vision','--cases=QA_001'],env:{CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED:'1',CHORIFY_CONTEXT_MODEL_MAX_CALLS:'1',CHORIFY_CONTEXT_VISION_AUTHORIZED:'0'},error:/Vision calls require explicit/},
    {args:['--real','--media-live','--cases=QA_001'],env:{CHORIFY_CONTEXT_REAL_MODEL_AUTHORIZED:'1',CHORIFY_CONTEXT_MODEL_MAX_CALLS:'1',CHORIFY_CONTEXT_REAL_MEDIA_AUTHORIZED:'0'},error:/Paid corpus submissions require/},
  ];
  for(const c of cases){const result=spawnSync(process.execPath,[file,...c.args],{encoding:'utf8',env:{...process.env,...c.env},windowsHide:true});assert.notEqual(result.status,0);assert.match(result.stderr,c.error);}
});
