// Offline browser regression: real UI, intercepted APIs, no model or media calls.
// PLAYWRIGHT_MODULE points to the locally installed Playwright index.mjs.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createTask,taskSnapshot} from '../server/task-state.mjs';

if(!process.env.PLAYWRIGHT_MODULE)throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{channel:'chrome'})});
const origin='https://recovery-ui.invalid';
const results=[];
try{
  for(const status of ['PLANNING','EXECUTING','VERIFYING','WAIT_CONFIRM']){
    const context=await browser.newContext();
    try{
      const state={id:'11111111-1111-4111-8111-111111111111',messages:[],events:[]};
      const task=createTask(state,{summary:'中断任务恢复',tasks:[{operation:'rewrite',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:'none'}],safety:{disposition:'allow'},semantic:{approval:{required:status==='WAIT_CONFIRM'}},assumptions:[]},'测试恢复');
      task.status=status;
      if(status==='WAIT_CONFIRM')task.approval={required:true,status:'pending',planHash:'frozen-hash',payload:{items:[{prompt:'保存的方案'}]}};
      const errors=[],requests=[];
      await context.addInitScript(({origin,id})=>{if(location.origin===origin)sessionStorage.setItem('creative-session',id);},{origin,id:state.id});
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.origin!==origin)return route.abort();
        const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
        if(files[url.pathname])return route.fulfill({contentType:url.pathname==='/app.js'?'text/javascript':url.pathname==='/style.css'?'text/css':'text/html',body:await readFile(new URL('../dist/'+files[url.pathname],import.meta.url),'utf8')});
        if(url.pathname==='/api/config')return route.fulfill({json:{csrf:'offline-token',model:'offline',skills:[],capabilities:{tools:[],services:{}}}});
        if(url.pathname==='/api/session/'+state.id)return route.fulfill({json:{id:state.id,events:[],users:[],artifacts:[],pendingTasks:false,status:task.status==='COMPLETED'?'completed':status==='WAIT_CONFIRM'?'needs_input':'interrupted',task:taskSnapshot(state)}});
        if(url.pathname==='/api/task/continue'){
          const body=request.postDataJSON();requests.push(body);
          task.status='COMPLETED';
          return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'task_state',task:taskSnapshot(state)})+'\n'+JSON.stringify({type:'final',status:'completed',text:'恢复完成'})+'\n'});
        }
        return route.fulfill({status:404,body:'unexpected request'});
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin);
      const label=status==='WAIT_CONFIRM'?'确认并执行此方案':'继续剩余任务';
      await page.getByRole('button',{name:label,exact:true}).click();
      await page.getByText('交付已齐',{exact:true}).waitFor();
      assert.equal(requests.length,1);assert.equal(requests[0].sessionId,state.id);assert.equal(requests[0].taskId,task.id);
      assert.equal(requests[0].planHash,status==='WAIT_CONFIRM'?'frozen-hash':undefined);assert.deepEqual(errors,[]);
      results.push({status,button:label,passed:true});
    }finally{await context.close();}
  }
}finally{await browser.close();}
const report={mode:'headless Chrome; real UI; offline intercepted APIs',results};
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
