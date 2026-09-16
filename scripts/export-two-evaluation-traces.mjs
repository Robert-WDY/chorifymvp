import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

// Offline export only. Does not load credentials, call models, or submit media.
const out='data/evaluation-trace-export-20260911';
await mkdir(out,{recursive:true});
const manifest=[];
async function source(path,json=true){
 const bytes=await readFile(path);
 manifest.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 return json?JSON.parse(bytes.toString('utf8')):bytes.toString('utf8');
}
const first=await source('data/real-media-query-audit-20260911/full-trace.json');
const second=await source('data/procedural-stability-20260911/full-trace.json');
const protocolAB=await source('data/procedural-stability-repeat-20260911/json-mode-ab.json');
const supporting={
 round1Report:await source('data/real-media-query-audit-20260911/report.md',false),
 round1Proofs:await source('data/real-media-query-audit-20260911/deterministic-proofs.json'),
 round2Report:await source('data/procedural-stability-20260911/report.md',false),
 round2InitialScoring:await source('data/procedural-stability-20260911/summary.json'),
 round2RepeatScoring:await source('data/procedural-stability-repeat-20260911/summary.json'),
 round2EvidenceReview:await source('data/procedural-stability-20260911/evidence-review.json'),
 offlineTests:await source('data/procedural-offline-tests.log',false),
 sourceSnapshots:{capturedAt:new Date().toISOString(),note:'导出时的代码快照，不冒充评测时的 Git 提交；当时实际加载的 Skill 和上下文以模型 input 及方法 contentHash 为准。',files:{}},
};
for(const path of ['scripts/eval-real-media-queries.mjs','scripts/eval-procedural-stability.mjs','scripts/check-known-media-findings.mjs','server/trace-context.mjs','server/text-stage.mjs','server/adapters.mjs'])supporting.sourceSnapshots.files[path]=await source(path,false);
const calls=[],rejectedDrafts=[],acceptanceFailures=[],cases=[];
function addCalls(list,base,round,caseId){
 list.forEach((c,i)=>{
  const pointer=base+'/'+i,system=String(c.input?.[0]?.content||'');
  const phase=system.startsWith('执行当前节点的文字阶段合同')?'text_generation':system.startsWith('你是任务交付验证器')?'model_verification':system.startsWith('你是必须执行的媒体Skill')?'media_skill_planning':system.startsWith('补齐需求草稿')?'intake_field_patch':c.validations?.find(v=>v.phase)?.phase||'unclassified';
  const v=c.validations||[];
  calls.push({round,caseId,callId:c.id,runId:c.runId,taskId:c.taskId,nodeId:c.nodeId,methodId:c.methodId,phase,status:c.status,startedAt:c.startedAt,pointer,input:pointer+'/input',providerRequest:pointer+'/normalizedRequest',providerResponse:pointer+'/providerResponse',output:Object.hasOwn(c,'output')?pointer+'/output':null,validations:Object.hasOwn(c,'validations')?pointer+'/validations':null});
  v.forEach((x,n)=>{
   if(x.accepted===false)rejectedDrafts.push({round,caseId,callId:c.id,phase:x.phase||phase,validation:pointer+'/validations/'+n,rawDraft:Object.hasOwn(x,'rejectedDraft')?pointer+'/validations/'+n+'/rejectedDraft':Object.hasOwn(x,'raw')?pointer+'/validations/'+n+'/raw':Object.hasOwn(c,'output')?pointer+'/output':null,error:x.error||x.errors,rawDraftNote:c.status==='failed'?'请求失败，没有模型返回草稿；保留错误，不补造输出。':'缺少专用 rejectedDraft 字段时，定位到同一次模型调用的完整原始输出，不补造草稿。'});
   if(x.verdict?.passed===false||['failed','uncertain'].includes(x.parsed?.outcome))acceptanceFailures.push({round,caseId,callId:c.id,phase:x.phase||phase,validation:pointer+'/validations/'+n,verifierInput:pointer+'/input',verifierOutput:pointer+'/output',outcome:x.parsed?.outcome||x.verdict?.outcome,issues:x.parsed?.issues||x.verdict?.issues});
  });
 });
}
addCalls(first.original747.calls,'/rounds/0/raw/original747/calls','original747','original747');
for(const [r,bundle] of [[0,first],[1,second]])bundle.cases.forEach((c,i)=>{
 const id=c.id||c.case.id,pointer='/rounds/'+r+'/raw/cases/'+i;
 cases.push({round:r+1,caseId:id,query:c.query||c.case.query,pointer,modelCalls:pointer+'/state/modelCalls',tools:pointer+'/tools',state:pointer+'/state',taskStore:c.state.taskStore?pointer+'/state/taskStore':null,events:pointer+'/state/events',turns:pointer+'/state/turns',final:pointer+'/final',originalChecks:c.checks?pointer+'/checks':null,verificationPolicy:r===0?'real_model_verifier':'procedure_only_stub_not_model_quality_verification'});
 addCalls(c.state.modelCalls,pointer+'/state/modelCalls',r+1,id);
});
const all=[...first.original747.calls,...first.cases.flatMap(c=>c.state.modelCalls),...second.cases.flatMap(c=>c.state.modelCalls)];
assert.equal(first.cases.length,14);assert.equal(second.cases.length,43);assert.equal(all.length,287);assert.equal(new Set(all.map(c=>c.id)).size,287);
const sourceCall=all.find(c=>c.id===protocolAB.sourceCallId);assert(sourceCall);
const statistics={round1Cases:14,round1Calls:80,original747Calls:10,round2Cases:43,round2Calls:197,protocolABAttempts:protocolAB.results.length,totalRequestAttempts:all.length+protocolAB.results.length,detailedModelCalls:all.length,returned:all.filter(c=>c.status==='returned').length,failed:all.filter(c=>c.status==='failed').length,recordedFields:Object.fromEntries(['input','normalizedRequest','providerResponse','output','validations'].map(k=>[k,all.filter(c=>Object.hasOwn(c,k)).length])),phases:calls.reduce((a,c)=>(a[c.phase]=(a[c.phase]||0)+1,a),{}),rejectedValidationRecords:rejectedDrafts.length,failedOrUncertainAcceptanceRecords:acceptanceFailures.length,actualImageSubmissions:3,actualVideoSubmissions:0};
assert(!calls.some(c=>c.round===2&&c.phase==='model_verification'));
const bundle={
 formatVersion:'two-evaluation-export-v1',exportedAt:new Date().toISOString(),description:'两轮评测全部现存记录及原始747失败记录；业务输入输出不截断，保留原始打分和人工复核差异。',
 completeness:{statistics,modelIdObserved:[...new Set(all.map(c=>c.model))],notes:[
  '完整是指现存日志完整导出，不表示能补回当时未采集的数据。API密钥及媒体URL查询参数已经在源日志脱敏。',
  '287条调用均有完整input和normalizedRequest；286条有返回output和提供方JSON响应。唯一失败调用仅保存HTTP400与空requestId，原始错误体未记录；对照实验另有实际捕获的错误体，不能等同于原调用响应。',
  'providerResponse是提供方已解析JSON，不是HTTP字节流；请求/响应头和媒体供应商原始HTTP报文未完整采集。工具args/result与媒体receipts按现存记录全量保留。',
  '第二轮质量验收被隔离测试替身取代，只有正文非空、URL存在等程序检查；没有真实模型内容验收请求或输出。状态中的passed/model_checked等字段不能据此解读为真实模型验收通过。',
  'accepted表示JSON解析/合同校验是否接受；验收是否通过看parsed.outcome或verdict。两类拒绝分别建立索引。',
  '原始747独立记录只包含目标turn/task/calls/artifacts，不是该手动会话所有历史轮次。每条模型实际收到的上下文均包含在input。',
  'events、transitions、executionPlan及方法输入保留实际记录；不是每一个内存变更点都有单独状态快照。final保存应用最终响应，不假定存在独立末次回答模型调用。',
  '两次协议A/B仅有结果记录和sourceCallId，没有独立保存完整请求与成功原始providerResponse。仅提供源调用定位及对照修改说明，不冒充捕获的完整HTTP请求。',
 ]},
 readingGuide:{pointerFormat:'RFC 6901 JSON Pointer，从本文件根对象开始定位。',fullRequest:'index.modelCalls[].providerRequest → normalizedRequest，含实际上下文与协议参数。input为适配前上下文。',rejectedDrafts:'index.rejectedDrafts，包括入口与文字结构校验拒绝；index.acceptanceFailures为格式合法但内容验收失败/不确定的调用。',text:'index.modelCalls 中 phase=text_generation；原始content/structure在output及providerResponse，实际提交验收的正文在验收input。',tools:'index.cases[].tools保存真实记录的args/result/error；run_skill_stage等编译阶段另见state.events与taskStore中的methods、executionPlan。',states:'各用例state.taskStore.tasks中的transitions/revisions/executionPlan，结合events、turns、artifacts；多轮用例的previous/seed保留来源。',results:'rounds[1].raw.report.results为复核后打分，各case.summary/checks及supportingEvidence保留原始打分。'},
 rounds:[{name:'图片与视频真实用户请求评测',verification:'real_model_verifier',raw:first},{name:'稳定运行专项测试（31初测+12复测）',verification:'procedure_only_test_stub',raw:second}],
 protocolAB:{recorded:protocolAB,requestEvidence:{sourceCallPointer:calls.find(c=>c.callId===sourceCall.id).pointer,note:'对照操作说明：原组重放源input；变体在首条system.content末尾追加换行与“仅输出合法JSON对象。”；tools=[]、options.json=true。此说明不是独立捕获的请求体。',appendedText:'\n仅输出合法JSON对象。',captureGaps:['A/B独立请求体未保存','成功A/B只保存适配器output，没有完整providerResponse','独立调用时间、usage与完整HTTP响应头未保存']}},
 index:{cases,modelCalls:calls,rejectedDrafts,acceptanceFailures},supportingEvidence:supporting,sourceManifest:manifest,
};
const serialized=JSON.stringify(bundle,null,2);
// Scan without printing any possible sensitive value.
assert(!/\bsk-[a-zA-Z0-9_-]{12,}\b/.test(serialized),'Unredacted API key detected; export stopped');
await writeFile(out+'/complete-trace.json',serialized);
const reread=JSON.parse(await readFile(out+'/complete-trace.json','utf8'));
assert.deepEqual(reread.rounds[0].raw,first);assert.deepEqual(reread.rounds[1].raw,second);
function resolve(p){return p.split('/').slice(1).reduce((v,k)=>v[k.replace(/~1/g,'/').replace(/~0/g,'~')],reread);}
for(const c of calls){assert.equal(resolve(c.pointer).id,c.callId);assert(resolve(c.input));assert(resolve(c.providerRequest));}
for(const r of rejectedDrafts){assert(resolve(r.validation));if(r.rawDraft!==null)assert.notEqual(resolve(r.rawDraft),undefined);}
for(const r of acceptanceFailures){assert(resolve(r.validation));assert(resolve(r.verifierInput));assert(resolve(r.verifierOutput));}
const verification={...statistics,sourceBundlesDeepEqual:true,uniqueCallIds:true,allCallAndDraftPointersResolve:true,containsUnredactedApiKey:false,traceBytes:Buffer.byteLength(serialized),traceSha256:createHash('sha256').update(serialized).digest('hex')};
await writeFile(out+'/export-verification.json',JSON.stringify(verification,null,2));
console.log(JSON.stringify(verification,null,2));
