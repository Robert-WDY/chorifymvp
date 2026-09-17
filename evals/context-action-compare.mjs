// Offline input comparison by default. Paid first-decision/protocol probes require --run.
// No model-selected tool is executed, and no media provider is instantiated.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {buildContext} from '../server/context-agent/context.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {loadAgentCatalog} from '../server/context-agent/skills.mjs';
import {createBrain,brainConfig} from '../server/adapters.mjs';
const argv=process.argv.slice(2),baseline='46a80b0a75fccbe01c293fe54aa7b3b76f53e355';
const output=resolve(argv.find(a=>a.startsWith('--out='))?.slice(6)||'evaluation-runs/context-action-compare');
const old=p=>execFileSync('git',['show',baseline+':'+p],{encoding:'utf8'});
async function oldModule(p){
 const code=old(p).replace(/from\s+'([^']+)'/g,(_m,specifier)=>`from '${specifier.startsWith('.')?pathToFileURL(resolve(dirname(p),specifier)).href:import.meta.resolve(specifier)}'`);
 return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}
const priorContext=await oldModule('server/context-agent/context.mjs'),priorTools=await oldModule('server/context-agent/tools.mjs');
const catalog=await loadAgentCatalog(),priorCatalog=JSON.parse(old('server/context-agent/methods/v1/index.json'));
const prompt=await readFile('server/context-agent/prompt.md','utf8'),priorPrompt=old('server/context-agent/prompt.md');
const inputs=[
 {id:'ONE_IMAGE',user:'生成一张白色护肤瓶广告图，纯白背景，1:1。'},
 {id:'TWO_IMAGES',user:'生成两张独立产品广告图。第一张白瓶，第二张红瓶，不要拼图。'},
 {id:'PROMPT_ONLY',user:'只写一条白瓶广告图提示词，不要保存媒体方案，不要生成图片。'},
 {id:'SHORT_FACTS',user:'我是电商运营，帮我做一个产品广告方向。',facts:'{"产品":"白色护肤瓶","价格":"30元","容量":"未知","功效":"未知"}'},
];
await mkdir(output,{recursive:false});
const write=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const projections=[];
for(const sample of inputs){
 const state=createSession({id:'comparison-'+sample.id,ownerId:'synthetic-evaluation'});
 if(sample.facts)state.assets.facts={id:'facts',type:'text',version:1,ownerId:state.ownerId,origin:'user_input',content:sample.facts};
 appendRecord(state,{kind:'message',id:'query-'+sample.id,role:'user',content:sample.user,...(sample.facts?{attachments:[{id:'facts',type:'text',version:1,name:'facts.json'}]}:{})});
 for(const arm of ['baseline','actions','context']){
  // Hold tool schemas, modes and capabilities fixed; actions changes text only.
  const useOld=arm==='baseline',ct=arm==='context'?buildContext:priorContext.buildContext;
  const tools=(useOld?priorTools.createTools:createTools)({catalog:useOld?priorCatalog:catalog,mode:'simulation',observeImages:async()=>{throw new Error('No vision execution in first-decision comparison');}});
  tools.definitions=tools.definitions.filter(t=>t.name!=='generate_video');
  const view=ct(state,{systemPrompt:useOld?priorPrompt:prompt,skillDirectory:arm==='context'?catalog.skills:priorCatalog.skills,toolDefinitions:tools.definitions,reservedTokens:6500});
  const row={caseId:sample.id,arm,input:view.input,tools:tools.definitions,metrics:view.metrics};
  projections.push(row);await write(sample.id+'-'+arm+'.json',row);
 }
}
for(const sample of inputs){
 const arms=projections.filter(p=>p.caseId===sample.id),schemas=p=>p.tools.map(({name,parameters})=>({name,parameters}));
 for(const p of arms){assert.deepEqual(schemas(p),schemas(arms[0]));assert.equal(p.metrics.omittedRecords,0);}
}
await write('manifest.json',{baseline,mode:argv.includes('--run')?'real-first-decision':'offline',cases:inputs,variants:['baseline','actions','context'],projections:projections.map(p=>({caseId:p.caseId,arm:p.arm,metrics:p.metrics,sha256:createHash('sha256').update(JSON.stringify(p)).digest('hex')})),limit:24,note:'First-decision probe only; no tool execution, no actual proposal persistence or media/vision. Synthetic facts case is a fixture, not original external product file.'});
if(!argv.includes('--run')){console.log(JSON.stringify({output,projections:projections.length,realCalls:0}));process.exit(0);}
const envPath=argv.find(a=>a.startsWith('--env='))?.slice(6);if(envPath)process.loadEnvFile(envPath);
const config=brainConfig();if(config.provider!=='deepseek'||config.model!=='deepseek-flash'||!config.key)throw new Error('Expected authorized deepseek-flash');
let calls=0;const wire=[];
const transport=async(url,options)=>{
 if(calls>=24)throw new Error('24-call cap reached');calls++;
 const row={call:calls,request:JSON.parse(options.body),startedAt:new Date().toISOString()};wire.push(row);
 try{const response=await fetch(url,options);row.status=response.status;row.response=await response.clone().json();return response;}
 catch(error){row.error=error.message;throw error;}finally{await write('transport.json',wire);}
};
// Test support without changing persistent configuration; never retry rejected requests automatically.
const supportedBrain=createBrain({...process.env,LLM_PARALLEL_TOOL_CALLS_SUPPORTED:'1'},transport);
const probes=[];
for(let i=0;i<2;i++)try{
 const result=await supportedBrain.respond([{role:'user',content:'请调用read_a和read_b分别读取两份独立资料。'}],['read_a','read_b'].map(name=>({type:'function',name,description:'读取一份独立资料',parameters:{type:'object',properties:{},required:[],additionalProperties:false}})),new AbortController().signal,{singleToolCall:true,maxOutputTokens:300});
 probes.push({output:result,functionCalls:result.filter(x=>x.type==='function_call').length});
}catch(error){probes.push({error:error.message});}
await write('protocol-probe.json',{probes,note:'HTTP acceptance does not prove constraint enforcement for all requests. Inspect response parallel_tool_calls plus actual counts; no automatic configuration change.'});
// Keep protocol and reasoning settings unchanged across text/context comparison arms.
const brain=createBrain({...process.env,LLM_PARALLEL_TOOL_CALLS_SUPPORTED:'0'},transport),results=[];
for(const p of projections){
 try{const result=await brain.respond(p.input,p.tools,new AbortController().signal,{singleToolCall:true});results.push({caseId:p.caseId,arm:p.arm,output:result,usage:brain.lastCall?.usage});}
 catch(error){results.push({caseId:p.caseId,arm:p.arm,error:error.message});}
 await write('decisions.json',results);
}
console.log(JSON.stringify({output,calls,realMediaCalls:0,realVisionCalls:0}));
