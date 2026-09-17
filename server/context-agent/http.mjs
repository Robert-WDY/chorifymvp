import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {HistoryStore} from './history.mjs';
import {ContextAgent} from './loop.mjs';

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function readBody(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw new Error('请求超过 256 KiB');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
const publicAsset=a=>Object.fromEntries(['id','type','name','title','version','parentId','sourceIds','url','content','simulated'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));

/** Independent localhost service; the old HTTP entry and its sessions are never imported. */
export function createContextServer({brain,tools,catalog={skills:[]},directory,store=new HistoryStore(directory),ownerId='local',modelEnabled=false,mode='simulation',agentOptions={}}={}) {
  const secret=randomBytes(32).toString('hex'),active=new Map();
  const agent=new ContextAgent({brain,tools,catalog,...agentOptions,save:state=>store.save(state,ownerId)});
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https:; media-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const address=server.address(),allowed=[`127.0.0.1:${address?.port}`,`localhost:${address?.port}`];
    if(!allowed.includes(req.headers.host))return json(res,403,{error:'只允许本机访问'});
    if(req.headers.origin&&!allowed.some(host=>req.headers.origin===`http://${host}`))return json(res,403,{error:'不允许跨站请求'});
    try{
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(req.method==='GET'&&url.pathname==='/api/config')return json(res,200,{engine:'context-agent',csrf:secret,modelEnabled,mediaMode:mode,model:brain.config?.model||'未配置',tools:tools.definitions.map(t=>t.name),limits:{maxSteps:agent.maxSteps,maxModelCalls:agent.maxModelCalls,maxToolCalls:agent.maxToolCalls,maxMediaCalls:agent.maxMediaCalls},summary:agent.memory});
      if(req.method==='GET'&&url.pathname.startsWith('/api/session/')){
        const state=await store.load(url.pathname.slice('/api/session/'.length),ownerId);
        return json(res,200,{id:state.id,engine:state.engine,running:active.has(state.id),messages:state.records.filter(r=>r.kind==='message').map(r=>({id:r.id,role:r.role,content:r.content,attachments:r.attachments})),assets:Object.values(state.assets).map(publicAsset),proposals:state.approvals,invocations:state.invocations,observations:state.records.filter(r=>r.kind==='system_observation'),summaries:Object.values(state.summaries||{})});
      }
      if(req.method==='POST'){
        if(req.headers['x-context-token']!==secret)return json(res,403,{error:'请刷新独立 Agent 页面'});
        const data=await readBody(req);
        if(url.pathname==='/api/session'){
          const state=await store.create(ownerId);return json(res,201,{id:state.id,engine:state.engine});
        }
        if(url.pathname==='/api/cancel'){
          await store.load(data.sessionId,ownerId);
          active.get(data.sessionId)?.abort();return json(res,200,{ok:true});
        }
        if(url.pathname==='/api/chat'||url.pathname==='/api/approve'){
          if(!modelEnabled)return json(res,403,{error:'真实模型调用默认关闭。请先核对模型配置与预算，再显式设置 CONTEXT_AGENT_ALLOW_MODEL=1。'});
          const state=await store.load(data.sessionId,ownerId);
          if(active.has(state.id))return json(res,409,{error:'会话正在运行；可先取消当前运行'});
          const controller=new AbortController();active.set(state.id,controller);
          const close=()=>{if(!res.writableEnded)controller.abort();};res.once('close',close);
          try{
            let message=data.message;
            if(url.pathname==='/api/approve'){
              if(!Array.isArray(data.proposalIds)||!data.proposalIds.length)throw new Error('请选定已展示的具体调用');
              message='通过按钮确认以下已展示的方案：'+JSON.stringify(data.proposalIds);
            }
            if(typeof message!=='string'||!message.trim())throw new Error('请输入正文');
            if(res.destroyed||controller.signal.aborted)return;
            res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});
            const heartbeat=setInterval(()=>{if(!res.destroyed)res.write('\n');},15000);
            try{await agent.run(state,message,event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');},controller.signal,{inputs:data.inputs||[],requestId:data.requestId,...(url.pathname==='/api/approve'?{confirmation:{proposalIds:data.proposalIds}}:{})});}
            catch(error){if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify({type:'end',status:'error',code:error.code||'invalid_request',message:error.message})+'\n');}
            finally{clearInterval(heartbeat);res.removeListener('close',close);res.end();}
          }finally{res.removeListener('close',close);active.delete(state.id);}
          return;
        }
      }
      const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&files[url.pathname]){
        const [file,type]=files[url.pathname];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(await readFile(new URL('./web/'+file,import.meta.url)));return;
      }
      return json(res,404,{error:'不存在的接口'});
    }catch(error){if(!res.headersSent)json(res,400,{error:error.message});else if(!res.writableEnded){if(!res.destroyed)res.write(JSON.stringify({type:'end',status:'error',message:error.message})+'\n');res.end();}}
  });
  return {server,agent,store,active};
}
