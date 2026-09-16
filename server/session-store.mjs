import {mkdir,readFile,open,rename,readdir,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {storeOf,projectState} from './task-state.mjs';
export const messageText=m=>typeof m?.content==='string'?m.content:Array.isArray(m?.content)?m.content.filter(p=>['input_text','output_text','text'].includes(p.type)).map(p=>p.text||'').join('\n'):'';
export class SessionStore{
 constructor(directory,{renameFile=rename}={}){this.directory=directory;this.renameFile=renameFile;this.writes=new Map();this.summaryCache=new Map();}
 path(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('会话 ID 无效');return join(this.directory,id+'.json');}
 async load(id,{recover=true}={}){const state=JSON.parse(await readFile(this.path(id),'utf8'));const store=storeOf(state);
  if(recover){
   const at=new Date().toISOString();
   for(const execution of Object.values(store.executions))if(execution.status==='pending'){execution.status='unknown';execution.error='进程中断时没有持久化提交回执，禁止自动重提';execution.finishedAt=at;}
   for(const call of Object.values(store.toolCalls||{}))if(call.status==='running'){call.status='unknown';call.error='进程中断，执行结果未知';call.finishedAt=at;}
   for(const call of state.modelCalls||[])if(!call.finishedAt){call.status='interrupted';call.error='进程中断，没有完整模型响应';call.finishedAt=at;}
   for(const turn of state.turns||[])if(!turn.finishedAt){turn.status='interrupted';turn.finishedAt=at;turn.error='进程中断，本轮未正常收尾';}
  }
  projectState(state);return state;
 }
 async save(state){
  const path=this.path(state.id);projectState(state);state.storageRevision=(state.storageRevision||0)+1;
  const bytes=JSON.stringify(state),previous=this.writes.get(state.id)||Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{await mkdir(this.directory,{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}for(let attempt=0;;attempt++){try{await this.renameFile(temporary,path);break;}catch(error){if(attempt>=5||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await delay(50*2**attempt);}}});
  this.writes.set(state.id,next);try{await next;}finally{if(this.writes.get(state.id)===next)this.writes.delete(state.id);}
 }
 async ids(){return(await readdir(this.directory)).filter(p=>/^[a-f0-9-]{36}\.json$/.test(p)).map(p=>p.slice(0,-5));}
 async list({query='',offset=0,limit=50}={}){
  const ids=await this.ids(),entries=[];
  for(const id of ids){try{
   const info=await stat(this.path(id)),key=info.mtimeMs+':'+info.size;let cached=this.summaryCache.get(id);
   if(cached?.key!==key){
    // Listing is read-only: do not recover runs or rewrite any task state.
    const state=JSON.parse(await readFile(this.path(id),'utf8')),messages=(state.messages||[]).filter(m=>['user','assistant'].includes(m.role)),users=messages.filter(m=>m.role==='user');
    const turns=state.turns||[],dates=turns.flatMap(t=>[t.createdAt,t.finishedAt]).filter(d=>Number.isFinite(Date.parse(d)));
    const updatedAt=dates.length?new Date(Math.max(...dates.map(Date.parse))).toISOString():info.mtime.toISOString();
    const compact=s=>s.replace(/\s+/g,' ').trim();
    const summary=users.length?{id,title:compact(messageText(users[0])).slice(0,80)||'未命名对话',preview:compact(messageText(messages.at(-1))).slice(0,120),updatedAt,turnCount:users.length,status:state.status||'unknown'}:null;
    cached={key,summary};this.summaryCache.set(id,cached);
   }
   if(cached.summary)entries.push(cached.summary);
  }catch{/* A missing or damaged session does not hide the rest of the history. */}}
  for(const id of this.summaryCache.keys())if(!ids.includes(id))this.summaryCache.delete(id);
  const needle=query.trim().toLocaleLowerCase(),matches=entries.filter(s=>!needle||(s.title+' '+s.preview).toLocaleLowerCase().includes(needle)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  return {sessions:matches.slice(offset,offset+limit),total:matches.length,hasMore:offset+limit<matches.length};
 }
}
