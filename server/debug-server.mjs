import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DebugTraceStore} from './debug-trace.mjs';
import {DebugLiveBridge,readDebugBody} from './debug-live.mjs';

const assets=new Map([['/',['index.html','text/html']],['/debug',['index.html','text/html']],['/debug/',['index.html','text/html']],['/debug/app.js',['app.js','text/javascript']],['/debug/style.css',['style.css','text/css']]]);
assets.set('/debug/live.js',['live.js','text/javascript']);
assets.set('/debug/readable.mjs',['readable.mjs','text/javascript']);
assets.set('/debug/readable-view.js',['readable-view.js','text/javascript']);
assets.set('/debug/model-evidence.mjs',['model-evidence.mjs','text/javascript']);
assets.set('/debug/focus-view.mjs',['focus-view.mjs','text/javascript']);
assets.set('/debug/focus-style.css',['focus-style.css','text/css']);
export function createDebugServer(store,{live=null}={}){
 const csrf=randomBytes(32).toString('hex');
 return createServer(async(req,res)=>{
  const port=req.socket.localPort,hosts=['127.0.0.1:'+port,'localhost:'+port];
  const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src https: data:; media-src https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!hosts.includes(req.headers.host))return json(403,{error:'调试台仅允许 localhost 访问'});
  if(req.headers.origin&&!hosts.some(h=>req.headers.origin==='http://'+h)||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'拒绝跨站读取'});
  try{
   const url=new URL(req.url,'http://'+req.headers.host),p=url.searchParams;
   if(req.method==='GET'&&url.pathname==='/api/debug/live/config'){
    if(!live)return json(200,{enabled:false,available:false});
    try{return json(200,{...await live.publicConfig(),csrf});}catch(e){return json(200,{enabled:true,available:false,error:e.message,source:live.source.id});}
   }
   if(req.method==='GET'&&url.pathname==='/api/debug/live/sessions'){
    if(!live)return json(404,{error:'未开启实时指令入口'});return json(200,await live.sessions());
   }
   if(req.method==='POST'&&['/api/debug/live/chat','/api/debug/live/cancel'].includes(url.pathname)){
    if(!live)return json(405,{error:'当前仅开启只读调试'});
    if(req.headers['x-debug-token']!==csrf)return json(403,{error:'调试令牌失效，请重新连接后台'});
    return await live.submit(req,res,await readDebugBody(req),{cancel:url.pathname.endsWith('/cancel')});
   }
   if(req.method!=='GET')return json(405,{error:'该调试接口仅支持 GET'});
   if(url.pathname==='/api/debug/runs'){
    const offset=Number(p.get('offset')||0),limit=Number(p.get('limit')||50),q=p.get('q')||'';
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||q.length>200) return json(400,{error:'分页或查询参数无效'});
    return json(200,await store.list({q,status:p.get('status')||'',source:p.get('source')||'',offset,limit}));
   }
   if(url.pathname==='/api/debug/failures')return json(200,await store.failures({source:p.get('source')||''}));
   const match=url.pathname.match(/^\/(?:api\/)?debug\/run\/([\w-]{1,160})$/);
   if(match)return json(200,await store.run(match[1],{sessionId:p.get('sessionId'),source:p.get('source')}));
   const asset=assets.get(url.pathname);
   if(asset){res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});res.end(await readFile(new URL('../dist/debug/'+asset[0],import.meta.url)));return;}
   return json(404,{error:'不存在的 Debug 接口'});
  }catch(e){json(e.status||500,{error:e.status?e.message:'读取 Trace 失败；请检查配置的数据目录和文件格式'});}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2),directories=[];let port=3214,boundaryDirectory=null,backendUrl=null,liveDirectory=null;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--data'&&args[i+1])directories.push(args[++i]);
  else if(args[i]==='--boundaries'&&args[i+1])boundaryDirectory=args[++i];
  else if(args[i]==='--port'&&args[i+1])port=Number(args[++i]);
  else if(args[i]==='--backend'&&args[i+1])backendUrl=args[++i];
  else if(args[i]==='--live-data'&&args[i+1])liveDirectory=resolve(args[++i]);
  else throw new Error('用法: node server/debug-server.mjs [--data <directory>]... [--boundaries <directory>] [--port 3214]');
 }
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口无效');
 if(!directories.length)directories.push(fileURLToPath(new URL('../data',import.meta.url)));
 if(!!backendUrl!==!!liveDirectory)throw new Error('--backend 和 --live-data 必须同时指定');
 if(liveDirectory&&!directories.some(d=>resolve(d)===liveDirectory))directories.push(liveDirectory);
 const store=new DebugTraceStore(directories,{boundaryDirectory});
 const live=backendUrl?new DebugLiveBridge({backendUrl,source:store.sources.find(s=>s.directory===liveDirectory)}):null;
 const server=createDebugServer(store,{live});
 server.listen(port,'127.0.0.1',()=>console.log('Chorify Debug ('+(live?'live + trace':'read-only')+'): http://127.0.0.1:'+port));
}
