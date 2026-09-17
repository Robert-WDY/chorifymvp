import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {HistoryStore} from '../../server/context-agent/history.mjs';
import {importLegacySession} from '../../server/context-agent/legacy-import.mjs';
const store=new HistoryStore('data/isolated-local'),base='http://127.0.0.1:3217';
let legacy=0,messages=0,assets=0;
for(const file of(await readdir('data/legacy-archive')).filter(f=>!f.startsWith('manifest-'))){
 const raw=await readFile('data/legacy-archive/'+file,'utf8'),old=JSON.parse(raw);if(!old.messages)continue;
 const hash=createHash('sha256').update(raw).digest('hex'),expected=importLegacySession(old,hash),saved=await store.exportSession(old.id);
 assert.equal(saved.records.find(r=>r.event==='legacy_import').sourceHash,hash);
 assert.deepEqual(saved.records.filter(r=>r.kind==='message').slice(0,expected.records.filter(r=>r.kind==='message').length).map(r=>({id:r.id,role:r.role,content:r.content})),expected.records.filter(r=>r.kind==='message').map(r=>({id:r.id,role:r.role,content:r.content})));
 for(const [id,asset]of Object.entries(expected.assets))assert.deepEqual(saved.assets[id],asset);
 assert.deepEqual(saved.approvals,{});legacy++;messages+=expected.records.filter(r=>r.kind==='message').length;assets+=Object.keys(expected.assets).length;
}
const page=await(await fetch(base+'/api/sessions?limit=100')).json();assert.equal(page.unavailable,0);assert.ok(page.total>=legacy);
const oldId='070436d3-9ae4-4c15-b2ab-a6cd849ad12a',exported=await(await fetch(base+'/api/session/'+oldId+'/export')).json();assert.deepEqual(exported.legacyArchive,JSON.parse(await readFile('data/legacy-archive/'+oldId+'.json','utf8')));
const recent=await(await fetch(base+'/api/session/19d0951a-e6f3-4724-a978-4002fa1f8b0c')).json();assert.equal(recent.messages.filter(m=>m.role==='user').length,8);
const sha=b=>createHash('sha256').update(b).digest('hex');const served=await(await fetch(base+'/app.js')).text();assert.equal(sha(served),sha(await readFile('server/context-agent/web/app.js','utf8')));
const result={at:new Date().toISOString(),legacySessions:legacy,messages,assets,legacyHashesVerified:true,legacyMessageAndAssetBodiesVerified:true,oldApprovalReplay:false,totalSessions:page.total,unavailable:page.unavailable,recentConversationPreserved:true,oldArchiveHttpExportMatches:true,frontendMatches:true,realModelCalls:0,realMediaCalls:0};
await writeFile(new URL('verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
