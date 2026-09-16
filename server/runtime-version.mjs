import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function sourceFingerprint(root){
 const hash=createHash('sha256');
 async function walk(relative){
  const entries=(await readdir(join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
  for(const e of entries){const path=relative+'/'+e.name;if(e.isDirectory())await walk(path);else if(e.isFile()){hash.update(path+'\0');hash.update(await readFile(join(root,path)));hash.update('\0');}}
 }
 for(const path of ['server','dist','skills'])await walk(path);
 for(const path of ['package.json','package-lock.json']){hash.update(path+'\0');hash.update(await readFile(join(root,path)));}
 return hash.digest('hex');
}
export async function runtimeVersion(root){
 const loaded=await sourceFingerprint(root),startedAt=new Date().toISOString();
 return {loaded,startedAt,async inspect(){const current=await sourceFingerprint(root);return {loaded,current,startedAt,matches:loaded===current};}};
}
