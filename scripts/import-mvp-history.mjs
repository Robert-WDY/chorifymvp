// Explicit one-time source directory. Runtime never depends on this source afterward.
import {readdir,readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {HistoryStore} from '../server/context-agent/history.mjs';
import {importLegacySession} from '../server/context-agent/legacy-import.mjs';
const source=resolve(process.argv[2]||''),mode=process.argv[3];
if(!process.argv[2]||!['compiled','context'].includes(mode))throw new Error('Usage: node scripts/import-mvp-history.mjs <source-directory> compiled|context');
const destination=resolve('data/isolated-local'),archive=resolve('data/legacy-archive'),store=new HistoryStore(destination),rows=[];
await mkdir(archive,{recursive:true});
for(const name of await readdir(source)){
 if(!name.endsWith('.json'))continue;
 const raw=await readFile(join(source,name),'utf8');let original;try{original=JSON.parse(raw);}catch{continue;}
 if(!original.id||(mode==='compiled'&&(!Array.isArray(original.messages)||(!original.taskStore&&!Array.isArray(original.events))))||(mode==='context'&&original.engine!=='context-agent'))continue;
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(original.id))throw new Error('Invalid source session ID');
 const hash=createHash('sha256').update(raw).digest('hex');
 const snapshot=join(archive,original.id+'.json');
 try{await writeFile(snapshot,raw,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;if(await readFile(snapshot,'utf8')!==raw)throw new Error('Archive conflict '+original.id);}
 let existing;try{existing=await store.load(original.id);}catch(error){if(error.code!=='SESSION_NOT_FOUND')throw error;}
 if(existing){const imported=existing.records.find(r=>r.event==='legacy_import');if(mode==='compiled'&&imported?.sourceHash!==hash)throw new Error('Session collision '+original.id);rows.push({id:original.id,status:'already_present',sha256:hash});continue;}
 const state=mode==='compiled'?importLegacySession(original,hash):original;
 await store.save(state);
 const restored=await store.exportSession(state.id);
 if(!isDeepStrictEqual(restored.records,state.records)||!isDeepStrictEqual(restored.assets,state.assets))throw new Error('Migration verification failed '+state.id);
 rows.push({id:state.id,status:'imported',sha256:hash,messages:state.records.filter(r=>r.kind==='message').length,assets:Object.keys(state.assets).length,bytes:(await stat(snapshot)).size});
}
await writeFile(join(archive,'manifest-'+mode+'-'+Date.now()+'.json'),JSON.stringify({source,destination,at:new Date().toISOString(),rows},null,2)+'\n');
console.log(JSON.stringify({mode,imported:rows.filter(r=>r.status==='imported').length,alreadyPresent:rows.filter(r=>r.status==='already_present').length,messages:rows.reduce((n,r)=>n+(r.messages||0),0),assets:rows.reduce((n,r)=>n+(r.assets||0),0),archivesVerified:rows.length}));
