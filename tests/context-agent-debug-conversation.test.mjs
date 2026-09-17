import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {debugSnapshot,debugDetail,inputBlocks} from '../server/context-agent/debug-view.mjs';

async function page(data){
 class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.classList={toggle(){}};this.value='all';}append(...x){this.children.push(...x);}replaceChildren(...x){this.children=x;}set innerHTML(v){throw Error('Unsafe HTML');}}
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);};
 const sandbox=vm.createContext({document:{getElementById:get,createElement:t=>new Element(t)},location:{search:''},localStorage:{getItem:()=>null},URLSearchParams,history:{replaceState(){}},setInterval(){},fetch:async()=>({ok:true,json:async()=>data})});
 const source=await readFile(new URL('../server/context-agent/web/debug.js',import.meta.url),'utf8');vm.runInContext(source.slice(0,source.indexOf('await sessions().catch')),sandbox);
 const text=n=>n.className==='evidence'?'':(n.textContent||'')+n.children.map(text).join(' ');
 return {sandbox,get,text};
}
test('input stage groups system instructions and hides later output and repeated tool blocks',async()=>{
 const input=[{role:'system',content:'规则一\n\n规则二'},{role:'user',content:'请继续上一版'},{type:'function_call_output',call_id:'c',output:'{"content":"历史工具返回正文"}'}];
 const data={record:{id:'request',event:'model_request',input},blocks:inputBlocks(input),tools:[{description:'工具定义重复内容'}],response:{output:[{type:'message',content:'此后的Agent回复'}]},labels:{},sources:[],references:[]};
 const original=JSON.stringify(data),p=await page(data);p.sandbox.fixture={nodes:[{id:'context-request',recordId:'request',module:'context',title:'组装本次决策输入',summary:'输入已组装'},{id:'request',module:'agent',title:'Agent第1次决策',summary:'已返回'}],issues:[]};
 vm.runInContext("session='s';journey=fixture;snapshot={turns:[]};",p.sandbox);
 await vm.runInContext("detail('context-request')",p.sandbox);let visible=p.text(p.get('detail'));
 assert.equal((visible.match(/系统指令（合并展示）/g)||[]).length,1);assert.match(visible,/规则一.*规则二/s);assert.doesNotMatch(visible,/此后的Agent回复|历史工具返回正文|工具定义重复内容|Agent 返回了什么/);
 await vm.runInContext("detail('request')",p.sandbox);visible=p.text(p.get('detail'));assert.match(visible,/此后的Agent回复/);assert.equal(JSON.stringify(data),original);
});
test('multi-turn overview preserves earlier context and opens full original without merging rounds',async()=>{
 const s=createSession();const first=appendRecord(s,{kind:'message',turnId:'one',role:'user',content:'产品白管30元，先写一版。'});appendRecord(s,{kind:'message',turnId:'one',role:'assistant',content:'第一版脚本。'});appendRecord(s,{kind:'message',turnId:'two',role:'user',content:'在刚才的基础上展开。'});appendRecord(s,{kind:'message',turnId:'two',role:'assistant',content:'沿用上一轮资料，下面是展开版。'});
 const snapshot=debugSnapshot(s),p=await page({});p.sandbox.fixture=snapshot;vm.runInContext("snapshot=fixture;turnId='two';renderConversation();",p.sandbox);
 const visible=p.text(p.get('conversation'));assert.match(visible,/第 1 轮/);assert.match(visible,/第 2 轮 · 当前查看/);assert.match(visible,/产品白管30元/);assert.match(visible,/第一版脚本/);assert.match(visible,/在刚才的基础上展开/);assert.match(visible,/沿用上一轮资料/);
 assert.equal(snapshot.turns[0].conversation[0].id,first.id);assert.equal((await debugDetail(s,first.id,()=>{})).record.content,first.content);assert.equal(snapshot.turns.length,2);
 vm.runInContext("session='s';turnId=undefined;snapshot=undefined;get=async path=>path.includes('/turn/')?{nodes:[],labels:{},issues:[],modules:[],query:'第一轮',decisions:0}:fixture;",p.sandbox);await vm.runInContext('refresh()',p.sandbox);assert.equal(vm.runInContext('turnId',p.sandbox),'one');
});
