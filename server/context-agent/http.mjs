import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {debugJourney} from './debug-journey.mjs';
import {debugSnapshot,debugDetail} from './debug-view.mjs';
import {historyRows,historyPage} from './history-view.mjs';
import {HistoryStore,appendRecord} from './history.mjs';
import {ContextAgent} from './loop.mjs';
import {publicEvents,resultSummary,safeText} from './public-events.mjs';
import {interactions,answerText} from './interactions.mjs';
import {displayedProposals,proposalDisplay} from './confirmation.mjs';

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function readBody(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>256*1024)throw new Error('请求超过 256 KiB');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
const publicAsset=a=>Object.fromEntries(['id','type','name','title','version','parentId','sourceIds','url','content','simulated'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));

/** Independent localhost service; the old HTTP entry and its sessions are never imported. */
export function createContextServer({brain,tools,catalog={skills:[]},directory,store=new HistoryStore(directory),ownerId='local',modelEnabled=false,mode='simulation',agentOptions={}}={}) {
  const secret=randomBytes(32).toString('hex'),active=new Map(),liveStates=new Map();
  const load=async id=>liveStates.get(id)||await store.load(id,ownerId);
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
      if(req.method==='GET'&&url.pathname==='/api/sessions'){
        const page=await store.list(ownerId,{query:url.searchParams.get('query')||'',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||30)});
        return json(res,200,{...page,sessions:page.sessions.map(s=>({...s,running:active.has(s.id)}))});
      }
      const journey=url.pathname.match(/^\/api\/debug\/([^/]+)\/turn\/([^/]+)$/);
      if(req.method==='GET'&&journey){const state=await load(journey[1]);return json(res,200,await debugJourney(state,journey[2],id=>store.readTrace(state.id,ownerId,id),{running:active.has(state.id)}));}
      const debug=url.pathname.match(/^\/api\/debug\/([^/]+)(?:\/record\/([^/]+))?$/);
      if(req.method==='GET'&&debug){
        const state=await load(debug[1]);
        return json(res,200,debug[2]?await debugDetail(state,debug[2],id=>store.readTrace(state.id,ownerId,id)):debugSnapshot(state,{running:active.has(state.id)}));
      }
      const exported=url.pathname.match(/^\/api\/session\/([^/]+)\/export$/);
      const history=url.pathname.match(/^\/api\/session\/([^/]+)\/history$/);
      if(req.method==='GET'&&history){
        const state=await load(history[1]),source=url.searchParams.get('source')||'records';
        let legacy;
        if(source.startsWith('legacy')&&state.records.some(r=>r.event==='legacy_import'))legacy=JSON.parse(await readFile(resolve(directory,'..','legacy-archive',state.id+'.json'),'utf8'));
        const rows=historyRows(state,source,legacy);
        if(url.searchParams.has('index')){const index=Number(url.searchParams.get('index'));if(!Number.isInteger(index)||index<0||index>=rows.length)throw new Error('History index out of range');const row=rows[index];return json(res,200,{source,index,record:row.traceRef?await store.readTrace(state.id,ownerId,row.id):row});}
        return json(res,200,{source,...historyPage(rows,Number(url.searchParams.get('offset')||0),Number(url.searchParams.get('limit')||30))});
      }
      if(req.method==='GET'&&exported){
        const state=await store.exportSession(exported[1],ownerId);
        let legacyArchive;
        if(state.records.some(r=>r.event==='legacy_import'))legacyArchive=JSON.parse(await readFile(resolve(directory,'..','legacy-archive',state.id+'.json'),'utf8'));
        res.setHeader('Content-Disposition','attachment; filename="'+state.id+'.json"');
        return json(res,200,{...state,...(legacyArchive?{legacyArchive}:{})});
      }
      if(req.method==='GET'&&url.pathname==='/api/config')return json(res,200,{engine:'context-agent',csrf:secret,modelEnabled,mediaMode:mode,model:brain.config?.model||'未配置',tools:tools.definitions.map(t=>t.name),limits:{maxSteps:agent.maxSteps,maxModelCalls:agent.maxModelCalls,maxToolCalls:agent.maxToolCalls,maxMediaCalls:agent.maxMediaCalls},summary:agent.memory});
      if(req.method==='GET'&&url.pathname.startsWith('/api/session/')){
        const state=await load(url.pathname.slice('/api/session/'.length));
        return json(res,200,{id:state.id,engine:state.engine,running:active.has(state.id),messages:state.records.filter(r=>r.kind==='message').map(r=>({id:r.id,role:r.role,content:r.content,attachments:r.attachments})),assets:Object.values(state.assets).map(publicAsset),proposals:Object.fromEntries(Object.entries(state.approvals).map(([id,p])=>[id,p.kind==='proposal'?{kind:p.kind,proposalId:p.proposalId,turnId:p.turnId,name:p.name,args:p.args,replacesProposalId:p.replacesProposalId,...proposalDisplay(state,id)}:{kind:p.kind,approvalId:p.approvalId,proposalIds:p.proposalIds}])),observations:state.records.filter(r=>r.kind==='system_observation').map(r=>({id:r.id,name:r.name,...resultSummary(JSON.parse(r.output))})),interactions:interactions(state),...publicEvents(state)});
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/events/')){
        const state=await load(url.pathname.slice('/api/events/'.length)),after=Number(url.searchParams.get('after')??-1);
        if(!Number.isInteger(after)||after< -1||after>state.records.length)throw new Error('事件游标无效');
        return json(res,200,{...publicEvents(state,after),running:active.has(state.id)});
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
        if(url.pathname==='/api/proposals/rendered'){
          const state=await load(data.sessionId),published=displayedProposals(state);
          if(!Array.isArray(data.proposalIds)||!data.proposalIds.length||data.proposalIds.length>20||data.proposalIds.some(id=>!published.includes(id)))throw new Error('只能确认当前会话已发布的方案卡渲染');
          const ids=data.proposalIds.filter(id=>!proposalDisplay(state,id).clientRendered);
          if(ids.length){appendRecord(state,{kind:'run_event',event:'proposal_client_rendered',proposalIds:ids});await store.save(state,ownerId);}
          return json(res,200,{ok:true,note:'客户端报告渲染，不代表用户已阅读或批准'});
        }
        if(url.pathname==='/api/chat'||url.pathname==='/api/approve'||url.pathname==='/api/answer'){
          if(!modelEnabled)return json(res,403,{error:'真实模型调用默认关闭。请先核对模型配置与预算，再显式设置 CONTEXT_AGENT_ALLOW_MODEL=1。'});
          const state=await store.load(data.sessionId,ownerId);
          if(active.has(state.id))return json(res,409,{error:'会话正在运行；可先取消当前运行'});
          const controller=new AbortController();active.set(state.id,controller);liveStates.set(state.id,state);
          // Disconnected pages recover persisted events; only explicit cancel stops the run.
          try{
            let message=data.message;
            if(url.pathname==='/api/approve'){
              if(!Array.isArray(data.proposalIds)||!data.proposalIds.length)throw new Error('请选定已展示的具体调用');
              message='通过按钮确认以下已展示的方案：'+JSON.stringify(data.proposalIds);
            }
            if(url.pathname==='/api/answer')message=answerText(state,data.interactionResponse);
            if(typeof message!=='string'||!message.trim())throw new Error('请输入正文');
            if(res.destroyed||controller.signal.aborted)return;
            res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'});
            const heartbeat=setInterval(()=>{if(!res.destroyed)res.write('\n');},15000);
            try{await agent.run(state,message,event=>{if(!res.destroyed){
              const visible=event.type==='tool_result'?{type:event.type,callId:event.callId,name:event.name,turnId:event.turnId,result:{...resultSummary(event.result),status:event.result.status,proposalId:event.result.proposalId,...(event.result.status==='approval_required'?{args:event.result.args,name:event.result.name}: {})}}:event.type==='system_observation'?{type:event.type,name:event.name,recordId:event.recordId,turnId:event.turnId,...resultSummary(event.result)}:event.type==='end'?{...event,...(event.message?{message:safeText(event.message)}:{})}:event;
              res.write(JSON.stringify(visible)+'\n');
            }},controller.signal,{inputs:data.inputs||[],requestId:data.requestId,selectedAssetIds:data.selectedAssetIds||[],...(url.pathname==='/api/answer'?{interactionResponse:data.interactionResponse}:{}),...(url.pathname==='/api/approve'?{confirmation:{proposalIds:data.proposalIds}}:{})});}
            catch(error){if(!res.destroyed&&!res.writableEnded)res.write(JSON.stringify({type:'end',status:'error',code:error.code||'invalid_request',message:safeText(error.message)})+'\n');}
            finally{clearInterval(heartbeat);res.end();}
          }finally{active.delete(state.id);liveStates.delete(state.id);}
          return;
        }
      }
      const files={'/debug':['debug.html','text/html'],'/debug.js':['debug.js','text/javascript'],'/debug.css':['debug.css','text/css'],'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&files[url.pathname]){
        const [file,type]=files[url.pathname];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(await readFile(new URL('./web/'+file,import.meta.url)));return;
      }
      return json(res,404,{error:'不存在的接口'});
    }catch(error){if(!res.headersSent)json(res,error.code==='SESSION_ACCESS_DENIED'?403:['ENOENT','SESSION_NOT_FOUND'].includes(error.code)?404:400,{error:safeText(error.message),code:error.code});else if(!res.writableEnded){if(!res.destroyed)res.write(JSON.stringify({type:'end',status:'error',message:safeText(error.message)})+'\n');res.end();}}
  });
  return {server,agent,store,active};
}
