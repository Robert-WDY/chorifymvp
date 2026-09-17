import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoryStore,appendRecord} from '../server/context-agent/history.mjs';
import {importLegacySession} from '../server/context-agent/legacy-import.mjs';
import {createContextServer} from '../server/context-agent/http.mjs';
const original={id:'old-session',messages:[{role:'user',content:'原来的广告'},{role:'assistant',content:[{type:'output_text',text:'原文18元'}]}],events:[],taskStore:{artifacts:{a:{id:'a',type:'text',content:'原文18元',status:'completed',version:1},b:{id:'b',type:'text',content:'改稿20元',status:'completed',version:2,parentId:'a'}}},approvals:{old:'approved'}};
test('migration keeps original identities, bodies and versions but never replays old approvals',()=>{
 const s=importLegacySession(original,'hash');assert.equal(s.id,original.id);assert.deepEqual(s.records.filter(r=>r.kind==='message').map(r=>r.content),['原来的广告','原文18元']);assert.equal(s.assets.b.parentId,'a');assert.equal(s.assets.b.version,2);assert.deepEqual(s.approvals,{});assert.deepEqual(s.invocations,{});
 const older=importLegacySession({...original,taskStore:undefined,deliverables:[{id:'draft',content:'旧正文'}]},'older');assert.equal(older.assets.draft.content,'旧正文');
});
test('history search, paging and owner isolation survive persistent reload, with damage reported',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mvp-history-'));try{const store=new HistoryStore(root),s=importLegacySession(original,'hash');await store.save(s);const another=await store.create('other');appendRecord(another,{kind:'message',role:'user',content:'其他账号'});await store.save(another,'other');
 const page=await new HistoryStore(root).list('local',{query:'广告',limit:1});assert.equal(page.total,1);assert.equal(page.sessions[0].id,s.id);assert.equal(page.hasMore,false);assert.equal((await store.list('local',{offset:1})).sessions.length,0);assert.equal((await store.list('other')).sessions[0].id,another.id);await assert.rejects(store.list('local',{limit:0}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('one HTTP service lists and continues an imported conversation and exports its full old archive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mvp-http-history-')),directory=join(root,'sessions'),store=new HistoryStore(directory);const s=importLegacySession(original,'hash');await store.save(s);await mkdir(join(root,'legacy-archive'));await writeFile(join(root,'legacy-archive',s.id+'.json'),JSON.stringify(original));let observed;
 const {server}=createContextServer({directory,store,modelEnabled:true,brain:{config:{model:'offline'},respond:async input=>{observed=input;return [{type:'message',role:'assistant',content:[{type:'output_text',text:'继续原来的对话。'}]}];}},tools:{definitions:[],execute:async()=>{throw Error('Unexpected tool');}},agentOptions:{memory:{enabled:false}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const base='http://127.0.0.1:'+server.address().port,config=await(await fetch(base+'/api/config')).json();const list=await(await fetch(base+'/api/sessions')).json();assert.equal(list.sessions[0].id,s.id);
 const response=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','x-context-token':config.csrf},body:JSON.stringify({sessionId:s.id,message:'继续'})});await response.text();assert.ok(JSON.stringify(observed).includes('原文18元'));
 const exported=await(await fetch(base+'/api/session/'+s.id+'/export')).json();assert.deepEqual(exported.legacyArchive,original);assert.equal(exported.id,s.id);assert.equal(exported.records.filter(r=>r.kind==='message').at(-1).content,'继续原来的对话。');assert.equal(exported.assets.b.parentId,'a');
 const history=await(await fetch(base+'/api/session/'+s.id+'/history?limit=100')).json();const request=history.rows.find(r=>r.label.includes('model_request'));assert.ok(request);const detail=await(await fetch(base+'/api/session/'+s.id+'/history?index='+request.index)).json();assert.ok(detail.record.input);assert.equal(detail.record.traceRef,undefined);
 const old=await(await fetch(base+'/api/session/'+s.id+'/history?source=legacyMessages&index=1')).json();assert.deepEqual(old.record,original.messages[1]);assert.equal((await fetch(base+'/api/session/'+s.id+'/history?index=-1')).status,400);

 assert.equal((await fetch(base+'/api/sessions',{headers:{Origin:'http://example.com'}})).status,403);
 }finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
