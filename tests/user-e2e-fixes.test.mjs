import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rename,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {SessionStore} from '../server/session-store.mjs';
import {clientStatus} from '../server/task-state.mjs';
import {understandGoal} from './intake-compat.mjs';
import {loadCatalog} from '../server/catalog.mjs';
test('a transient Windows rename failure retries without discarding the last checkpoint',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'e2e-persistence-'));let attempts=0;
 try{const store=new SessionStore(directory,{renameFile:async(from,to)=>{if(++attempts<3)throw Object.assign(new Error('temporary file lock'),{code:'EPERM'});return rename(from,to);}});const state={id:'11111111-1111-4111-8111-111111111111',messages:[],events:[]};await store.save(state);assert.equal(attempts,3);assert.equal((await store.load(state.id)).id,state.id);
 const previous=await readFile(store.path(state.id),'utf8');store.renameFile=async()=>{throw Object.assign(new Error('invalid'),{code:'EINVAL'});};await assert.rejects(store.save({...state,messages:[{role:'user',content:'new'}]}),/invalid/);assert.equal(await readFile(store.path(state.id),'utf8'),previous);
 }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('e2e-persistence-'));await rm(directory,{recursive:true,force:true});}
});
test('background verification reports running while truly orphaned work reports interrupted',()=>{
 assert.equal(clientStatus({status:'running'},{monitoring:true}),'running');assert.equal(clientStatus({status:'running'}),'interrupted');assert.equal(clientStatus({status:'completed'},{monitoring:true}),'completed');assert.equal(clientStatus({status:'waiting'}),'waiting');
});
test('an unaccepted extra proposal can be corrected to the one actual user obligation',async()=>{
 const catalog=await loadCatalog(),delivery={description:'咖啡海报',kind:'image',count:1,action:'create',purpose:'marketing',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'一张咖啡海报'};
 const semantic={summary:'咖啡海报',deliverables:[delivery,{...delivery,dependsOn:[0]}],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:true,reason:'确认后生成'},continuation:{mode:'new',taskId:''}};let calls=0;
 const outputs=[semantic,{...semantic,deliverables:[delivery]},{required:true,evidence:'确认后再生成'},{image:1,video:0,audio:0,reason:'只有一张最终图'},{consistent:true,issues:[]},{...semantic,deliverables:[delivery]},{consistent:true,issues:[]},{routes:[{deliverableIndex:0,operation:'generate_image',skills:[]}]}];
 const brain={respond:async()=>[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(outputs[calls++])}]}]};
 const goal=await understandGoal(brain,catalog,{query:'先给我一张咖啡海报的方案，确认后再生成',strictControl:true},new AbortController().signal);
 assert.equal(goal.intentSnapshot.deliverables.length,1);assert.equal(goal.tasks[0].count,1);assert.equal(goal.semantic.approval.required,true);assert.equal(calls,3);
 assert.equal(goal.intakeTrace[0].ok,false);assert.equal(goal.intakeTrace[1].ok,true);
});
