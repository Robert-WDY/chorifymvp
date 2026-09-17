// Offline request construction only. Loads the fixed historical baseline without
// changing the checkout or calling a model. No tools are executed.
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createSession,appendRecord} from '../../server/context-agent/history.mjs';
import {createTools} from '../../server/context-agent/tools.mjs';
import {buildContext} from '../../server/context-agent/context.mjs';
const root=new URL('../../',import.meta.url),baseline='0cf6401c196ce742d734ee08e10b8ec357d63ceb';
const historical=path=>execFileSync('git',['show',baseline+':'+path],{cwd:fileURLToPath(root),encoding:'utf8',maxBuffer:1024*1024});
async function loadBaseline(path){
 const source=historical(path).replace(/from\s+'([^']+)'/g,(_,name)=>'from '+JSON.stringify(name.startsWith('.')?new URL(name,new URL(path,root)).href:import.meta.resolve(name)));
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
const s=createSession({id:'incremental-context-fixture',ownerId:'offline-evaluation'});
const original=appendRecord(s,{kind:'message',role:'assistant',content:'原长稿：\n'+ '保留原稿事实与结构。'.repeat(200)+'\n价格20元。'});
for(let i=0;i<12;i++)appendRecord(s,{kind:'message',role:i%2?'user':'assistant',content:'讨论其他措辞，第'+i+'轮。'});
appendRecord(s,{kind:'message',role:'user',content:'把最早那篇长稿价格改成18元，其他不动，保存新版本。'});
const oldContext=await loadBaseline('server/context-agent/context.mjs'),oldTools=await loadBaseline('server/context-agent/tools.mjs');
const versions={before:{build:oldContext.buildContext,tools:oldTools.createTools().definitions,prompt:historical('server/context-agent/prompt.md')},after:{build:buildContext,tools:createTools().definitions,prompt:await readFile(new URL('server/context-agent/prompt.md',root),'utf8')}};
for(const [name,v]of Object.entries(versions)){
 const result=v.build(s,{systemPrompt:v.prompt,toolDefinitions:v.tools,tokenBudget:24000,reservedTokens:6500});
 const originalIndex=result.input.find(m=>typeof m.content==='string'&&m.content.includes('"originalMessages":'));
 const ids=originalIndex?JSON.parse(originalIndex.content.slice(originalIndex.content.indexOf('\n')+1)).originalMessages:[];
 const finding={originalBodyPresent:result.input.some(m=>m.content===original.content),originalIdPresent:ids.some(r=>r.messageId===original.id),retainedIdentities:ids.length,omittedRecords:result.metrics.omittedRecords};
 assert.equal(finding.originalBodyPresent,true);assert.equal(finding.originalIdPresent,name==='after');assert.equal(finding.omittedRecords,0);
 const output={validation:'offline request projection; zero model or media calls',baseline,originalMessageId:original.id,finding,...result,tools:v.tools};
 await writeFile(new URL('context-'+name+'.json',import.meta.url),JSON.stringify(output,null,2)+'\n');console.log(name,JSON.stringify(finding));
}
