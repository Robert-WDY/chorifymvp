import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request} from 'node:http';
import {aggregateRun,stateDiff,redactDebug,DebugTraceStore} from '../server/debug-trace.mjs';
import {createDebugServer} from '../server/debug-server.mjs';

const start='2026-09-14T10:00:00.000Z',finish='2026-09-14T10:00:05.000Z';
function fixture(){return {id:'session-1',turns:[{runId:'run-1',rawInput:'测试 Query',createdAt:start,finishedAt:finish,status:'completed',taskId:'task-1',decision:{semantic:{turnOperation:{kind:'create'},deliverables:[]}}}],events:[{eventId:'state-1',runId:'run-1',type:'task_state',occurredAt:finish,taskId:'task-1',task:{id:'task-1',items:[],contract:{},verification:{status:'passed'}}},{eventId:'final-1',runId:'run-1',type:'final',occurredAt:finish,text:'已完成',status:'completed',artifacts:[]}],modelCalls:[],taskStore:{tasks:{'task-1':{id:'task-1',items:[]}},artifacts:{},executions:{},toolCalls:{}}};}
const currentTask=s=>s.events[0].task;
test('redacts nested credentials, string JSON, headers and signed URL without losing business authorization',()=>{
 const x=redactDebug({runId:'run',artifactId:'artifact',version:2,authorization:{scope:'image',approved:true},DEEPSEEK_API_KEY:'non-sk-secret',headers:{Authorization:'Bearer abc',Cookie:'sid=foo'},body:JSON.stringify({access_token:'secret-value',reference:'https://example.com/a?signature=secret'}),raw:'Cookie: sid=foo\nAuthorization: Bearer abc\nhttps://user:password@example.com/x?sig=foo'});
 assert.deepEqual(x.authorization,{scope:'image',approved:true});assert.equal(x.artifactId,'artifact');assert.equal(x.version,2);
 for(const secret of ['non-sk-secret','secret-value','signature=secret','sid=foo','Bearer abc','user:password','sig=foo'])assert.ok(!JSON.stringify(x).includes(secret),secret);
});
test('Case 1: image selector origin shown in raw draft before normalization',()=>{
 const s=fixture();s.turns[0].rawInput='第一张图片换背景';const raw={deliverables:[{kind:'image',action:'modify',spec:{selectedDirectionIndex:1}}]};
 s.modelCalls=[{id:'call-1',runId:'run-1',output:[{content:[{text:JSON.stringify(raw)}]}],validations:[{phase:'understand',parsed:{deliverables:[{kind:'image',action:'modify',spec:{}}]},accepted:true}]}];
 const r=aggregateRun(s,'run-1');assert.equal(r.fieldOrigins[0].stage,'MODEL DRAFT');assert.match(r.fieldOrigins[0].path,/selectedDirectionIndex/);assert.ok(r.stateDiffs.some(d=>d.changes.some(c=>c.field.endsWith('selectedDirectionIndex')&&c.change==='removed')));
});
test('Case 2: Skill selection without actual execution is missing evidence',()=>{
 const s=fixture();currentTask(s).items=[{id:'item',requiredMethods:['product-understanding'],methods:[{skillId:'product-understanding',status:'selected'}]}];const r=aggregateRun(s,'run-1');assert.equal(r.skills[0].status,'MISSING_EXECUTION_EVIDENCE');assert.equal(r.skills[0].executed,false);
});
test('Case 3: completed run with 1/3 coverage stays visibly incomplete',()=>{
 const s=fixture();currentTask(s).items=[{id:'item',requirementCoverage:[1,2,3].map(i=>({requirementId:'shot'+i,expected:{unitId:i},actual:i===1?[i]:[],status:i===1?'completed':'pending'}))}];const r=aggregateRun(s,'run-1');assert.equal(r.status,'completed');assert.equal(r.coverageSummary.completed,1);assert.equal(r.coverageSummary.total,3);assert.equal(r.diagnostics.find(d=>d.category==='coverage_gap').severity,'error');
});
test('Case 4: present retains existing image references and zero new artifacts',()=>{
 const s=fixture();s.turns[0].decision.semantic={turnOperation:{kind:'present'},deliverables:[{kind:'image',action:'present',references:['image-1']}]};s.taskStore.artifacts['image-1']={id:'image-1',type:'image',version:1,createdAt:'2026-09-13T00:00:00Z'};const r=aggregateRun(s,'run-1');assert.equal(r.delivery.operation.kind,'present');assert.equal(r.delivery.newArtifacts,0);assert.equal(r.artifacts[0].id,'image-1');assert.equal(r.tools.length,0);
});
test('Case 5: previous/current state comparison uses recorded snapshots, not latest task',()=>{
 const s=fixture();s.turns.unshift({runId:'previous',decision:{semantic:{deliverables:[]}}});s.events.unshift({eventId:'prev-state',runId:'previous',type:'task_state',task:{id:'task-1',items:[],spec:{ratio:'16:9'}}});s.events[1].task.spec={ratio:'9:16'};s.taskStore.tasks['task-1'].spec={ratio:'1:1'};
 const r=aggregateRun(s,'run-1');const d=r.stateDiffs.find(d=>d.kind==='cross_turn_recorded_task');assert.ok(d.changes.some(c=>c.field==='/spec/ratio'&&c.old==='16:9'&&c.new==='9:16'));assert.equal(r.previousTurn.runId,'previous');
});
test('diff provenance unknown must not imply unauthorized; explicit origins preserve categories',()=>{
 const d=stateDiff({}, {ratio:'9:16',extra:'x',status:'done'},{origins:{'/ratio':{origin:'user_explicit'}}});assert.equal(d.find(x=>x.field==='/ratio').classification,'explicit_user_change');assert.equal(d.find(x=>x.field==='/extra').classification,'unattributed');assert.equal(d.find(x=>x.field==='/status').classification,'internal_state');
});
test('actual model input stays exact; no full history reconstruction or fabricated semantic loss',()=>{
 const s=fixture();s.messages=[{role:'user',content:'NOT ACTUALLY SENT'}];s.turns[0].decision.semantic.globalConstraints=['保持背景'];s.modelCalls=[{id:'c',runId:'run-1',input:[{content:'before transport'}],normalizedRequest:{input:[{content:'change color'}],model:'recorded'},output:[]}];const r=aggregateRun(s,'run-1');assert.deepEqual(r.contextSnapshots[0].actualRequest,s.modelCalls[0].normalizedRequest);assert.equal(r.contextSnapshots[0].availableContext,null);assert.equal(r.contextSnapshots[0].contextLoss.context_loss,null);assert.equal(r.contextSnapshots[0].contextLoss.hints.length,1);
});
test('no task snapshot and no final event do not get replaced with latest ledger/history',()=>{
 const s=fixture();s.events=[];s.messages=[{role:'assistant',content:'Some later answer'}];s.taskStore.tasks['task-1'].verification={status:'passed'};const r=aggregateRun(s,'run-1');assert.equal(r.finalResponse.text,null);assert.equal(r.stateSnapshots.filter(s=>s.scope.startsWith('task:')).length,0);assert.deepEqual(r.verification.business,[]);
});
test('tool success does not fabricate four validator PASS results',()=>{
 const s=fixture();s.taskStore.toolCalls.c={id:'c',runId:'run-1',name:'edit_image',args:{referenceImages:['missing']},status:'completed',result:{ok:true}};const r=aggregateRun(s,'run-1');for(const v of Object.values(r.tools[0].validation))assert.equal(v.status,'unrecorded');
});
test('run association excludes other turns model/tool calls and unrelated artifacts',()=>{
 const s=fixture();s.modelCalls=[{id:'foreign',runId:'run-2'}];s.taskStore.toolCalls.foreign={id:'foreign',runId:'run-2'};s.taskStore.artifacts.foreign={id:'foreign',runId:'run-2'};const r=aggregateRun(s,'run-1');assert.equal(r.contextSnapshots.length,0);assert.equal(r.tools.length,0);assert.equal(r.artifacts.length,0);
});
test('lineage retains typed references and execution edges without conflating parent with revision',()=>{
 const s=fixture();s.turns[0].decision.semantic.deliverables=[{references:['a2']}];s.taskStore.artifacts={a1:{id:'a1',version:1},a2:{id:'a2',version:2,parentId:'a1',sourceExecutionId:'exec',relationships:[{artifactId:'ref',relation:'references',version:3}]}};const r=aggregateRun(s,'run-1');assert.deepEqual(new Set(r.artifactGraph.edges.map(e=>e.type)),new Set(['references','parent_unspecified','created_from']));
});
test('Stage A acceptance sentinel is evaluation cutoff, not business failure',()=>{
 const s=fixture();s.turns[0].status='failed';s.turns[0].error='STAGE_A_ACCEPTANCE_BOUNDARY_STOP';const r=aggregateRun(s,'run-1');assert.equal(r.evaluation.cutoff,true);assert.ok(r.diagnostics.some(d=>d.category==='evaluation_cutoff'));assert.ok(!r.diagnostics.some(d=>d.category==='recorded_error'));
});
test('pure aggregator never mutates stored business state',()=>{
 const s=fixture(),before=JSON.stringify(s);aggregateRun(s,'run-1');assert.equal(JSON.stringify(s),before);
});
test('required coverage source units without verdict are unknown, never auto passed from count',()=>{
 const s=fixture();currentTask(s).items=[{id:'i',count:1,coverage:{unitIds:['shot1','shot2','shot3']}}];const r=aggregateRun(s,'run-1');assert.equal(r.coverageSummary.total,3);assert.equal(r.coverageSummary.completed,0);assert.ok(r.requirementCoverage.every(c=>c.status==='unknown'));
});
test('execution from previous run does not prove this run Skill executed',()=>{
 const s=fixture();currentTask(s).items=[{id:'i',requiredMethods:['skill'],methods:[{skillId:'skill',contentHash:'hash',modelCallIds:['old'],contractValidated:true,outputArtifactIds:['old-artifact']}]}];s.modelCalls=[{id:'old',runId:'previous',status:'returned'}];assert.equal(aggregateRun(s,'run-1').skills[0].executed,false);
});
test('Skill completion needs both actual call and run-time artifact verification evidence',()=>{
 const s=fixture();currentTask(s).items=[{id:'i',requiredMethods:['skill'],methods:[{skillId:'skill',contentHash:'hash',modelCallIds:['call'],contractValidated:true,outputArtifactIds:['out']}]}];s.modelCalls=[{id:'call',runId:'run-1',status:'returned'}];
 let r=aggregateRun(s,'run-1');assert.equal(r.skills[0].executed,true);assert.equal(r.skills[0].producedArtifact,false);assert.equal(r.skills[0].verified,false);
 currentTask(s).artifacts=[{id:'out',verification:{technical:'passed',semantic:'passed'}}];r=aggregateRun(s,'run-1');assert.equal(r.skills[0].verified,true);
});
test('cutoff with no error string remains explicit in dashboard diagnostics',()=>{
 const r=aggregateRun(fixture(),'run-1',{boundary:{cutoffApplied:true}});assert.ok(r.diagnostics.some(d=>d.category==='evaluation_cutoff'));
});
test('required Skill present only in recorded execution plan remains visible',()=>{
 const s=fixture();s.events=[{eventId:'p',runId:'run-1',type:'execution_plan',plan:{nodes:[{id:'i',requiredMethods:['product-understanding'],skillId:'media-helper'}]}}];const r=aggregateRun(s,'run-1');assert.equal(r.skills.find(s=>s.skillId==='product-understanding').status,'MISSING_EXECUTION_EVIDENCE');assert.equal(r.skills.find(s=>s.skillId==='media-helper').required,false);
});
test('artifact verification uses run snapshot over later ledger state',()=>{
 const s=fixture();s.turns[0].decision.semantic.deliverables=[{references:['a']}];currentTask(s).artifacts=[{id:'a',verification:{technical:'passed',semantic:'not_checked'}}];s.taskStore.artifacts.a={id:'a',verification:{technical:'passed',semantic:'passed'}};
 const r=aggregateRun(s,'run-1');assert.equal(r.verification.artifacts[0].semantic,'not_checked');assert.equal(r.verification.artifacts[0].evidenceScope,'recorded_in_run');
});
test('read receipt references appear in lineage without new artifacts',()=>{
 const s=fixture();currentTask(s).items=[{id:'i',readReceipt:{artifactReferences:[{id:'existing',version:2}]}}];s.taskStore.artifacts.existing={id:'existing',type:'image',version:2};const r=aggregateRun(s,'run-1');assert.equal(r.artifacts.length,1);assert.equal(r.delivery.newArtifacts,0);
});
test('real presentation contract targets and version bindings feed artifact graph',()=>{
 const s=fixture();s.turns[0].decision.semantic={turnOperation:{kind:'present',presentation:{targets:['image'],bindings:[{id:'image',version:2,sourceHash:'hash'}]}},deliverables:[{runtimeQuery:{targets:['image']}}]};s.taskStore.artifacts.image={id:'image',type:'image',version:2};const r=aggregateRun(s,'run-1');assert.equal(r.artifactGraph.nodes[0].id,'image');assert.equal(r.delivery.newArtifacts,0);assert.ok(r.delivery.artifactReferences.some(b=>b.version===2));
});
test('snapshot arrays preserve null vs missing and safely compare changed object types',()=>{
 const d=stateDiff({a:null,x:{ratio:'1:1'}},{x:'text',a:undefined});assert.ok(d.some(c=>c.field==='/a'&&c.oldPresent&&!c.newPresent));assert.ok(d.some(c=>c.field==='/x'&&c.new==='text'));
});
test('API supports pagination, isolation, strict redaction, read-only and localhost access',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chorify-debug-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const s=fixture(),path=join(dir,'session-1.json');s.turns[0].rawInput='sk-abcdefghijklmnop';await writeFile(path,JSON.stringify(s));const before=await readFile(path,'utf8');const other=fixture();other.id='session-2';await writeFile(join(dir,'session-2.json'),JSON.stringify(other));
 const store=new DebugTraceStore([dir]),server=createDebugServer(store);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const listing=await(await fetch(base+'/api/debug/runs?limit=1')).json();assert.equal(listing.total,2);assert.equal(listing.runs.length,1);assert.ok(!JSON.stringify(listing).includes('sk-abcdefgh'));
 assert.equal((await fetch(base+'/api/debug/run/run-1')).status,409);
 const detail=await fetch(base+'/debug/run/run-1?sessionId=session-1&source=source0');assert.equal(detail.status,200);assert.equal((await detail.json()).sessionId,'session-1');
 assert.equal((await fetch(base+'/api/debug/runs?limit=-1')).status,400);
 assert.equal((await fetch(base+'/api/debug/runs',{method:'POST'})).status,405);
 assert.equal((await fetch(base+'/api/debug/runs',{headers:{Origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(base+'/api/debug/runs',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 const status=await new Promise((done,reject)=>{const req=request(base+'/api/debug/runs',{headers:{Host:'evil.test'}},res=>{res.resume();done(res.statusCode);});req.on('error',reject);req.end();});assert.equal(status,403);
 assert.equal((await fetch(base+'/api/debug/run/unknown')).status,404);
 assert.equal((await fetch(base+'/debug')).status,200);
 assert.equal(await readFile(path,'utf8'),before);
 const dashboard=await(await fetch(base+'/api/debug/failures')).json();assert.equal(dashboard.window,2);
});
