import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

async function page(){
 const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{value:'',files:[],textContent:''});return elements.get(id);};
 const sent=[],sandbox=vm.createContext({document:{getElementById:get},localStorage:{getItem:()=>null},sent});
 const source=await readFile(new URL('../server/context-agent/web/app.js',import.meta.url),'utf8');
 vm.runInContext(source.replace(/await initialize\(\);\s*$/,''),sandbox);
 vm.runInContext('sessionId="test-session";run=async(path,data)=>{sent.push({path,data});};',sandbox);
 let pending;
 get('chat').requestSubmit=()=>{pending=get('chat').onsubmit({preventDefault(){}});};
 const key=options=>{let prevented=false;get('message').onkeydown({key:'Enter',preventDefault(){prevented=true;},...options});return prevented;};
 return{get,sent,sandbox,key,done:()=>pending};
}
test('Enter and click share submission including attachments',async()=>{
 const p=await page();p.get('message').value='第一行\n第二行';p.get('files').files=[{name:'brief.txt',size:6,text:async()=>'产品原文'}];
 assert.equal(p.key({}),true);await p.done();assert.equal(p.sent.length,1);
 assert.equal(p.sent[0].path,'/api/chat');assert.equal(p.sent[0].data.message,'第一行\n第二行');assert.equal(p.sent[0].data.inputs[0].content,'产品原文');
 p.get('files').files=[];p.get('message').value='点击发送';await p.get('chat').onsubmit({preventDefault(){}});assert.equal(p.sent[1].data.message,'点击发送');
});
test('newline, IME composition and modified keys do not send; held Enter does not repeat',async()=>{
 const p=await page();p.get('message').value='中文';
 for(const options of [{shiftKey:true},{isComposing:true},{keyCode:229},{ctrlKey:true},{altKey:true},{metaKey:true},{key:'a'}])assert.equal(p.key(options),false);
 assert.equal(p.key({repeat:true}),true);assert.equal(p.sent.length,0);
});
test('running or empty composer cannot submit or clear the draft',async()=>{
 const p=await page();p.get('message').value='保留草稿';vm.runInContext('running=true',p.sandbox);p.key({});assert.equal(p.sent.length,0);assert.equal(p.get('message').value,'保留草稿');
 vm.runInContext('running=false',p.sandbox);p.get('message').value=' \n ';p.key({});await p.done();assert.equal(p.sent.length,0);
});
test('attachment read locks submission before awaiting, and failures release the lock',async()=>{
 const p=await page();let release;p.get('message').value='带附件';p.get('files').files=[{name:'a.txt',size:1,text:()=>new Promise(r=>{release=r;})}];
 p.key({});p.key({});await p.get('chat').onsubmit({preventDefault(){}});release('原文');await p.done();assert.equal(p.sent.length,1);
 p.get('message').value='过大';p.get('files').files=[{size:129*1024}];p.key({});await p.done();assert.equal(p.get('message').value,'过大');
 p.get('files').files=[];p.key({});await p.done();assert.equal(p.sent.length,2);
});
