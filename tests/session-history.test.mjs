import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionStore,messageText} from '../server/session-store.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'chorify-history-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new SessionStore(dir);
 const write=async(state)=>{await writeFile(store.path(state.id),JSON.stringify(state));return state.id;};
 return {dir,store,write};
}
test('history sorts, searches and paginates concise user-visible summaries',async t=>{
 const {store,write}=await fixture(t);
 const first=await write({id:randomUUID(),status:'completed',messages:[{role:'user',content:'咖啡海报'},{role:'assistant',content:'第一版'}],turns:[{createdAt:'2026-09-01T00:00:00Z'}],modelCalls:[{secret:'private-trace'}]});
 const second=await write({id:randomUUID(),status:'waiting',messages:[{role:'user',content:[{type:'input_text',text:'旅行 脚本'}]},{role:'user',content:'增加雪山镜头'},{role:'assistant',content:[{type:'output_text',text:'雪山宣传片'}]}],turns:[{createdAt:'2026-09-02T00:00:00Z',finishedAt:'2026-09-03T00:00:00Z'}]});
 const page=await store.list({limit:1});
 assert.equal(page.total,2);assert.equal(page.hasMore,true);assert.equal(page.sessions[0].id,second);assert.equal(page.sessions[0].turnCount,2);
 assert.equal(page.sessions[0].preview,'雪山宣传片');
 assert.deepEqual(Object.keys(page.sessions[0]).sort(),['id','preview','status','title','turnCount','updatedAt'].sort());
 assert.equal((await store.list({offset:1,limit:1})).sessions[0].id,first);
 assert.equal((await store.list({query:'雪山'})).sessions[0].id,second);
 assert.equal((await store.list({query:'不存在'})).total,0);
 assert.ok(!JSON.stringify(await store.list()).includes('private-trace'));
});
test('history ignores corrupt and non-session files without recovering or mutating saved runs',async t=>{
 const {dir,store,write}=await fixture(t);
 const id=await write({id:randomUUID(),status:'running',messages:[{role:'user',content:'尚在执行'}],turns:[{status:'running'}]});
 const original=await readFile(store.path(id),'utf8');
 await writeFile(store.path(randomUUID()),'{invalid');
 await writeFile(join(dir,'config.json'),'{"private":"configuration"}');
 await write({id:randomUUID(),messages:[]});
 store.load=()=>{throw new Error('Listing must not recover state');};
 const result=await store.list();assert.equal(result.total,1);assert.equal(result.sessions[0].status,'running');
 assert.equal(await readFile(store.path(id),'utf8'),original);
});
test('history invalidates cached summaries when files change or disappear',async t=>{
 const {store,write}=await fixture(t);
 const state={id:randomUUID(),messages:[{role:'user',content:'旧标题'}]};
 await write(state);assert.equal((await store.list()).sessions[0].title,'旧标题');
 state.messages[0].content='更新后的标题';await write(state);
 await utimes(store.path(state.id),new Date(),new Date(Date.now()+1000));
 assert.equal((await store.list()).sessions[0].title,'更新后的标题');
 await rm(store.path(state.id));assert.equal((await store.list()).total,0);assert.equal(store.summaryCache.size,0);
});
test('history extracts visible text from both stored message formats',()=>{
 assert.equal(messageText({content:'原文'}),'原文');
 assert.equal(messageText({content:[{type:'input_text',text:'第一段'},{type:'input_image',image_url:'private-image'},{type:'text',text:'第二段'}]}),'第一段\n第二段');
 assert.equal(messageText({}), '');
});
