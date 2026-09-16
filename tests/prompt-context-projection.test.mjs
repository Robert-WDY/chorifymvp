import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadCatalog} from '../server/catalog.mjs';
import {methodBoundary,mediaInstructions} from '../server/prompt-text.mjs';
import {renderMethod,projectModelInput,repairInput,viewHash,compactIntakePayload} from '../server/model-context.mjs';
import {observationQuestion,observeImages,imageObservationInputs} from '../server/observation-contract.mjs';
import {selectStageSources,renderStage,executeTextStage} from '../server/text-stage.mjs';
import {createTask} from '../server/task-state.mjs';
import {acceptRevision} from '../server/task-contract.mjs';
import {composeFinalResponse,responseContext,projectResponseInput} from '../server/final-response.mjs';
import {structuredOutput} from '../server/goal-compiler.mjs';
import {isSchemaEcho} from '../server/structured-codec.mjs';
import {understandGoal,intakeExamples} from '../server/intent.mjs';
import {bindRequestEvidence} from '../server/request-input.mjs';
import {tracedBrain,withTrace,transportTrace} from '../server/trace-context.mjs';
import {buildActionContext} from '../server/action-context.mjs';
import {loadInspection} from '../server/runtime-facts.mjs';
import {ReferenceCatalog} from '../server/reference-catalog.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=value=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}];
const img=id=>({id,type:'image',version:1,url:'https://test.invalid/'+id+'.png'});
const makeGoal=items=>({summary:'离线输入核对',mode:'create',tasks:items.map(i=>({description:'商品理解',operation:'answer',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none',spec:{},...i})),skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow'},semantic:{deliverables:items.map(i=>({description:i.description||'商品理解'})),facts:['白色泵头瓶'],globalConstraints:['不补性能','无字'],approval:{required:false},continuation:{mode:'new'}}});
test('B: actual text request renders one boundary and hash; stored method still has full contract',async()=>{
 const state={id:'offline',messages:[],events:[]},task=createTask(state,makeGoal([{requiredMethods:['product-understanding-zh-v1']}]),'白色泵头瓶，容量未知');let captured;
 acceptRevision(task,'offline');const before=JSON.stringify(task.contract);
 const brain=tracedBrain({respond:async input=>{captured=structuredClone(input);return reply({content:'白色泵头瓶；容量未知',structure:{facts:['白色泵头瓶'],assumptions:['容量未知'],sellingPoints:[]}});}});
 const out=await withTrace(state,async()=>{},()=>executeTextStage({state,catalog,brain,save:async()=>{}},task.items[0],signal()));
 const p=JSON.parse(captured[1].content),record=out.methodRecords[0];
 assert.equal(JSON.stringify(p).split(JSON.stringify(methodBoundary).slice(1,-1)).length-1,1);
 assert.equal(p.methods[0].contract,undefined);assert.ok(record.input.methods[0].contract.outputSchema);
 assert.equal(record.renderedContentHash,viewHash(p.methods[0].content));assert.equal(record.contentHash,viewHash(record.input.methods[0].content));assert.equal(record.removedRanges.length,1);
 assert.deepEqual(p.facts,['白色泵头瓶']);assert.equal(p.evidenceContext.facts,undefined);assert.equal(p.evidenceContext.valueSources.facts,'/facts');
 assert.equal(JSON.stringify(task.contract),before);assert.equal(state.modelCalls[0].modelView.version,'prompt-context-v1');assert.ok(state.modelCalls[0].modelView.inputHash);
});
test('B: all 15 source methods remain independent and professional bodies / license survive rendering',async()=>{
 assert.equal(catalog.skills.length,15);
 for(const skill of catalog.skills){const content=await readFile(new URL('../skills/'+skill.slug+'/instructions.md',import.meta.url),'utf8'),rendered=renderMethod({slug:skill.slug,content});
  assert.equal(content.split(methodBoundary).length,2);assert.ok(!rendered.content.includes(methodBoundary));assert.equal(rendered.renderedContentHash,viewHash(rendered.content));
  assert.equal(rendered.content,content.slice(rendered.removedRanges[0].end));
 }
 const gallery=await readFile(new URL('../skills/image-prompt-gallery-director-v2/instructions.md',import.meta.url),'utf8');
 for(const text of ['人物','产品与机构','精确文字','UI、图表与多面板','MIT License','未知产品事实省略','不主动排入品牌'])assert.ok(gallery.includes(text),text);
 const rewrite=await readFile(new URL('../skills/creative-prompt-rewrite/instructions.md',import.meta.url),'utf8');
 for(const text of ['连续变化','身份锚点','对白','强反差','静态画面','仅在本轮启用该模块时适用'])assert.ok(rewrite.includes(text),text);
 assert.ok(!rewrite.includes('8/10以上'));
});
function observationFixture(){
 const a=img('a'),b=img('b'),brief={id:'brief',type:'text',version:1,content:'用户资料：容量未知；标签原文“净享”。'};
 const state={id:'s',taskStore:{activeTaskId:'t',tasks:{t:{id:'t',revision:1,query:'比较两张白色泵头瓶，容量未知',contract:{facts:['白色泵头瓶'],globalConstraints:['不补性能']},goal:{semantic:{gaps:[{level:'factual',description:'容量未知'}]}}}},inputs:{a,b,brief},artifacts:{}}};
 const item={id:'i',description:'比较外观',requiredEvidence:'image',references:['a','b'],supportingSources:['brief'],dependsOn:[],constraints:['不猜材质']},calls=[];
 const executor={state,runtime:{execute:async(name,args)=>{calls.push(structuredClone(args));return {text:'联合观察正文'};}},save:async()=>{},record:async()=>{}};
 return {state,item,calls,executor,a,b,brief};
}
test('B: observations carry real facts, unknown original evidence, bound support and ordered image associations',async()=>{
 const f=observationFixture(),result=await observeImages(f.executor,f.item,signal());
 assert.deepEqual(f.calls[0].urls,[f.a.url,f.b.url]);const q=JSON.parse(f.calls[0].question);
 assert.deepEqual(q.providedFacts,['白色泵头瓶']);assert.deepEqual(q.unknownFacts,['容量未知']);assert.ok(q.sourceExcerpts.some(s=>s.id==='brief'&&s.version===1&&s.text.includes('净享')));
 assert.equal(result.length,2);assert.equal(result[0].result.text,'联合观察正文');assert.equal(result[1].result,undefined);assert.equal(result[1].resultRef,result[0].resultId);assert.equal(result[1].inputIndex,2);
 delete f.state.taskStore.tasks.t.goal.semantic.gaps;assert.ok(observationQuestion(f.item,[],f.state).includes('容量未知'));
 const empty=JSON.parse(observationQuestion({description:'看图'},[]));assert.deepEqual(empty,{question:'看图'});
});
test('B: cache invalidates on question / facts / support / image identity and order, not log time',async()=>{
 const f=observationFixture();await observeImages(f.executor,f.item,signal());await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,1);
 f.state.taskStore.tasks.t.updatedAt='irrelevant';await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,1);
 f.state.taskStore.tasks.t.contract.facts.push('瓶身高12厘米');await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,2);
 f.item.description='比较标签';await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,3);
 f.brief.content+='噪音未知';await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,4);
 f.item.references.reverse();await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,5);assert.deepEqual(f.calls.at(-1).urls,[f.b.url,f.a.url]);
 f.b.version++;await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,6);
 f.b.url='https://test.invalid/new.png';await observeImages(f.executor,f.item,signal());assert.equal(f.calls.length,7);
 assert.throws(()=>imageObservationInputs(f.item,[f.a],f.state),/当前图片版本/);
});
test('B: readonly observation receives current original and bound text, never unrelated active-task facts',async()=>{
 const f=observationFixture();Object.assign(f.state,{currentRunId:'read',turns:[{runId:'read',rawInput:'看这张图，容量未知'}]});
 Object.assign(f.state.taskStore.tasks.t,{items:[],requirements:[],contract:{facts:['无关旧商品秘密参数']}});f.state.taskStore.executions={};
 const references=new ReferenceCatalog([f.a,f.brief],{scope:'s'}),query={type:'artifact_inventory',sourceBindings:[references.bind('a',{purpose:'history'}),references.bind('brief',{purpose:'history'})],observations:[{sourceId:'a',kind:'image',question:'可见什么'}]};
 const facts=await loadInspection({...f.executor,catalog}, {runtimeQuery:query},signal());
 assert.equal(facts.observations[0].status,'observed');assert.ok(f.calls[0].question.includes('容量未知'));assert.ok(f.calls[0].question.includes('净享'));assert.ok(!f.calls[0].question.includes('无关旧商品秘密参数'));
});
test('B: selecting direction two retains unique sections, exact words and bound version without full collection',()=>{
 const structure={directions:[{id:'d1',content:'第一方向专属'},{id:'d2',content:'第二方向：无字静物'}],sections:[{content:'容量未知；不可承诺疗效'}]};
 const source={id:'directions',type:'text',version:3,structure,content:renderStage(structure)};
 const selected=selectStageSources([source],{selectionRole:'consumer',spec:{selectedDirectionIndex:2}})[0];
 assert.equal(selected.selectedDirection.artifactId,'directions');assert.equal(selected.selectedDirection.version,3);assert.equal(selected.selectedDirection.id,'d2');assert.ok(!JSON.stringify(selected).includes('第一方向专属'));assert.ok(JSON.stringify(selected).includes('不可承诺疗效'));
});
test('B: source projection removes only exact rendered duplicates and retains delta original once',()=>{
 const structure={shots:[{content:'镜头无字幕',durationSeconds:5}],sections:[{content:'独有说明'}]},content=renderStage(structure),source={id:'s',version:2,content,structure};
 const input={sources:[source],facts:['未知'],globalConstraints:['禁止文字'],evidenceContext:{facts:['未知'],globalConstraints:['禁止文字']},authorization:{required:true,status:'pending',revision:2}};
 const before=structuredClone(input),v=projectModelInput(input,renderStage);assert.equal(v.sources[0].content,undefined);assert.equal(v.sources[0].structure.sections[0].content,'独有说明');assert.deepEqual(v.authorization,input.authorization);assert.deepEqual(input,before);
 assert.equal(projectModelInput({...input,sources:[{...source,content:content+'\n独有原文'}]},renderStage).sources[0].content,content+'\n独有原文');
 const delta=projectModelInput({...input,changeContract:{source:{id:'s',version:2},original:content,change:['时长'],preserve:['字幕不变']},sourceDocument:source},renderStage);
 assert.equal(delta.changeContract.original,content);assert.equal(delta.sources[0].contentRef,'/changeContract/original');assert.equal(delta.sourceDocumentRef,'/sources/0');assert.deepEqual(delta.changeContract.preserve,['字幕不变']);
});
test('B: intake exact-message pointers survive native mapping and never point to removed bodies',()=>{
 const payload={query:'继续',conversation:{recentMessages:[{messageId:'m1',role:'assistant',content:'唯一正文'},{messageId:'m2',role:'assistant',content:'唯一正文'}],recentAttempts:[{input:'独有失败请求'}],messageIndex:[]},referenceCatalog:{entries:[]},sourceDocuments:[{id:'a',version:1,content:'唯一正文'}]};
 compactIntakePayload(payload);const view=buildActionContext(payload),messages=view.relevantEvidence.conversation.recentMessages,doc=view.relevantEvidence.sourceDocuments[0];
 assert.equal(messages.find(m=>m.messageId===doc.contentMessageId).content,'唯一正文');assert.equal(view.relevantEvidence.conversation.recentAttempts[0].input,'独有失败请求');
});
test('B: selected old pending plan contains exact parameters and one copy despite another active task',async()=>{
 const old={id:'old',revision:2,query:'旧杯子方案',goal:{summary:'旧方案'},items:[],requirements:[],approval:{required:true,status:'pending',planHash:'old-hash',payload:{items:[{prompt:'旧杯子无字',ratio:'9:16',duration:5}]}}};
 const newer={...old,id:'new',revision:4,approval:{...old.approval,planHash:'new-hash',payload:{items:[{prompt:'无关新方案'}]}}};
 const state={messages:[],taskStore:{activeTaskId:'new',tasks:{old,new:newer},artifacts:{},executions:{}}};
 const turn={rawInput:'查看旧方案',queryReceipt:{facts:{query:{type:'task_plan',taskIds:['old'],answerContract:{scope:'task'}},tasks:[{id:'old',revision:2,summary:'旧方案',approval:old.approval,batches:{b:{items:old.approval.payload.items}}}]}}};
 const context=responseContext(state,turn,{status:'completed',artifacts:[],text:'重复方案'}),view=projectResponseInput(context);
 assert.equal(view.savedPlans[0].taskId,'old');assert.equal(view.savedPlans[0].revision,2);assert.equal(view.savedPlans[0].parameters[0].ratio,'9:16');assert.equal(view.savedPlans[0].approval.planHash,'old-hash');assert.equal(JSON.stringify(view).split('旧杯子无字').length,2);assert.equal(view.state.sessionMedia,undefined);assert.ok(!JSON.stringify(view).includes('无关新方案'));
 let request;await composeFinalResponse({respond:async input=>{request=JSON.parse(input[1].content);return reply('已保存待确认');}},state,turn,{status:'completed',artifacts:[]},signal());assert.equal(request.savedPlans[0].parameters[0].duration,5);
});
test('B: protected delivery remains zero-call and summary input retains the full selected document',async()=>{
 const a={id:'a',taskId:'t',version:1,type:'text',purpose:'deliverable',content:'完整正文：容量未知',publication:'current',verification:{technical:'passed',semantic:'passed'}};
 const t={id:'t',items:[],requirements:[],goal:{},query:'正文'},state={taskStore:{activeTaskId:'t',tasks:{t},artifacts:{a},executions:{}}};let calls=0;
 const output=await composeFinalResponse({respond:async()=>{calls++;throw Error('forbidden');}},state,{taskId:'t',rawInput:'只要正文',decision:{status:'accepted'}},{taskId:'t',status:'completed',artifacts:[a]},signal());assert.equal(calls,0);assert.equal(output,a.content);
 const context=responseContext(state,{rawInput:'总结这份文档',queryReceipt:{facts:{query:{type:'history'},sources:[a]}}},{status:'completed',artifacts:[]});assert.equal(projectResponseInput(context).selectedSources[0].content,a.content);
});
test('B: field and reference repairs keep one draft and specific candidates, excluding recursive history',()=>{
 const payload={query:'只改背景',conversation:{recentMessages:[]},skillDirectory:[{slug:'real'}],taskIndex:[{id:'old'}],referenceCatalog:{entries:[img('a')]},sourceDocuments:[{content:'无关全文'}]},draft={deliverables:[{kind:'image',references:['a'],changeContract:{change:['背景'],preserve:['主体']}}]};
 const field=repairInput(payload,draft,{paths:['/summary'],keys:{'/summary':'summary'}}),ref=repairInput(payload,draft,{indices:[0],field:'references',candidates:[img('a')]},{reference:true});
 for(const v of [field,ref]){assert.equal(v.original,undefined);assert.equal(v.intentSnapshot,undefined);assert.equal(v.sourceDocuments,undefined);assert.deepEqual(v.lockedDraft,draft);assert.equal(v.query,payload.query);}
 assert.equal(field.skillDirectory,undefined);assert.equal(field.referenceCatalog,undefined);assert.equal(ref.candidates[0].id,'a');assert.equal(ref.field,'references');
 const version=repairInput(payload,draft,{paths:['/businessActions/0/target/version'],keys:{}});assert.equal(version.referenceCatalog.entries[0].version,1);
});
test('B: root schema echoes never become assistant business drafts, but schema discussion remains valid',async()=>{
 for(const echo of [{oneOf:[{type:'object'}]},{anyOf:[{type:'string'}]},{$defs:{x:{type:'number'}}},{type:'object',properties:{content:{type:'string'}}}]){
  assert.ok(isSchemaEcho(echo));let calls=0;
  const result=await structuredOutput({respond:async input=>{if(++calls===1)return reply(echo);assert.ok(!input.some(m=>m.role==='assistant'));return reply({content:'讨论oneOf/properties'});}},'正文',{query:'解释Schema'},{type:'object',required:['content'],additionalProperties:false,properties:{content:{type:'string'}}},signal());assert.equal(result.content,'讨论oneOf/properties');
 }
 assert.equal(isSchemaEcho({content:'oneOf',structure:{properties:'说明'}}),false);
 let calls=0;const valid=intakeExamples({nativeMode:false})[0];
 const goal=await understandGoal({respond:async input=>{if(++calls===1)return reply({oneOf:[{type:'object'}]});assert.ok(!input.some(m=>m.role==='assistant'));return reply(valid);}},catalog,{query:valid.deliverables[0].requestEvidence,actionMode:'shadow'},signal());assert.equal(calls,2);assert.equal(goal.tasks[0].output,'text');
});
test('B: evidence spans retain UTF-16 positions for Chinese, newline and emoji',()=>{
 const content='中文🙂\n请保持“净享”原文',quote='🙂\n请保持“净享”',semantic={continuation:{mode:'new'},deliverables:[{requestEvidence:quote}]};
 bindRequestEvidence(semantic,{query:content,currentMessage:{messageId:'m',role:'user',content}});
 const d=semantic.deliverables[0],span=d.requestEvidenceSpans[0];assert.equal(span.start,2);assert.equal(span.end,2+quote.length);assert.equal(content.slice(span.start,span.end),quote);assert.equal(d.evidenceSegments[0].text,quote);
});
test('B: trace records raw actual projection and normalized transport metrics separately',async()=>{
 const state={currentRunId:'offline',taskStore:{tasks:{}},turns:[]},brain=tracedBrain({respond:async input=>{transportTrace({model:'fake',input});return reply({content:'正文'});}});
 const input=[{role:'system',content:'精确文字“净享”'}, {role:'user',content:'合法幻想；无字；容量未知'}];
 await withTrace(state,async()=>{},()=>brain.respond(input,[],signal(),{tracePhase:'text_generation',traceAttempt:1}));
 const call=state.modelCalls[0];assert.equal(call.attempt,1);assert.equal(call.modelView.characters,JSON.stringify(input).length);assert.ok(call.normalizedRequestMetrics.hash);assert.notEqual(call.modelView.inputHash,call.normalizedRequestMetrics.hash);assert.deepEqual(call.input,input);
 assert.ok(!mediaInstructions('edit_image').includes('强反差'));
});
