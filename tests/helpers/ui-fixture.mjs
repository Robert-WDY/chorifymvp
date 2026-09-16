// Local UI smoke fixture. No model calls, media requests or real session writes.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../../dist/',import.meta.url);
const state={events:[{type:'start',sessionId:'ui-fixture'},{type:'tool_result',callId:'fixture-tool',name:'fixture',result:{text:'可展开的历史记录'}},{type:'final',status:'completed',text:Array.from({length:60},(_,i)=>'历史段落 '+i+'：用于验证聊天滚动和历史节点保留。').join('\n\n')}],users:['历史测试消息'],status:'completed',pendingTasks:false,task:null,artifacts:[]};
createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json; charset=utf-8');
 if(req.url==='/api/config')return res.end(JSON.stringify({csrf:'fixture',providerName:'UI测试',model:'无模型调用',skills:[],capabilities:{tools:[],services:{}}}));
 if(req.url.startsWith('/api/session/'))return res.end(JSON.stringify(state));
 if(req.url==='/api/chat'){
  let body='';for await(const chunk of req)body+=chunk;const {message}=JSON.parse(body);state.users.push(message);
  const events=[{type:'start',sessionId:'ui-fixture'},{type:'notice',text:'测试接收输入'},{type:'final',status:'completed',text:'UI测试回执：'+message}];state.events.push(...events);
  return res.end(events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 }
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end("sessionStorage.setItem('creative-session','ui-fixture');");}
 const name={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[req.url];if(!name){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8');
 let content=await readFile(new URL(name,root),'utf8');if(name==='index.html')content=content.replace('<script src="/app.js"','<script src="/fixture.js"></script><script src="/app.js"');res.end(content);
}).listen(3211,'127.0.0.1',()=>console.log('UI fixture ready on 3211'));
