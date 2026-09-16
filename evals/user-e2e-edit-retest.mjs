import {mkdir,writeFile,readFile,readdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const tag=process.argv[2]||'v1';if(!/^[a-z0-9-]+$/.test(tag))throw new Error('Invalid tag');
const root=resolve('data/user-e2e-'+tag);await mkdir(root,{recursive:false});
const modulePath=process.env.PLAYWRIGHT_MODULE||'C:/Users/dongxu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(modulePath));
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const results=[],startedAt=new Date().toISOString(),files=[];
for(const dir of ['server','dist'])for(const name of await readdir(dir))if(/\.(mjs|js|css|html)$/.test(name))files.push(join(dir,name));
async function hash(){const h=createHash('sha256');for(const file of files.sort()){h.update(file);h.update(await readFile(file));}return h.digest('hex');}
const sourceHash=await hash();for(const file of files){const dest=join(root,'code',file);await mkdir(resolve(dest,'..'),{recursive:true});await copyFile(file,dest);}await copyFile('evals/user-e2e-edit-retest.mjs',join(root,'runner.mjs'));
await writeFile(join(root,'manifest.json'),JSON.stringify({startedAt,sourceHash,mode:'real-browser-real-doubao-real-media',baseUrl:'http://127.0.0.1:3210',browser:'local Chrome headless'},null,2));
async function fresh(){const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage(),log={consoleErrors:[],http:[],steps:[]};
 page.on('pageerror',e=>log.consoleErrors.push(e.message));
 page.on('response',async r=>{if(['/api/chat','/api/task/continue'].some(p=>r.url().endsWith(p))){const record={url:r.url(),status:r.status(),request:r.request().postDataJSON()};log.http.push(record);try{record.body=await r.text();}catch(e){record.error=e.message;}}});
 await page.goto('http://127.0.0.1:3210');await page.locator('#connection').filter({hasText:'本地 Skill'}).waitFor();return{context,page,log};}
async function state(f){const id=await f.page.evaluate(()=>sessionStorage.getItem('creative-session'));if(!id)return null;const r=await f.page.request.get('http://127.0.0.1:3210/api/session/'+id);if(!r.ok())throw new Error('Session HTTP '+r.status());return r.json();}
async function settle(f,{refreshPending=false}={}){let s=await state(f),refreshed=false;const until=Date.now()+420000;
 while(s&&(s.status==='running'||s.pendingTasks)&&Date.now()<until){if(refreshPending&&!refreshed&&s.pendingTasks){await f.page.reload();refreshed=true;}await new Promise(r=>setTimeout(r,4000));s=await state(f);}
 if(refreshed)f.log.refreshedWhilePending=true;
 await f.page.waitForTimeout(500);return s;
}
async function action(f,label,query,{confirm=false,refreshPending=false}={}){
 const response=f.page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(confirm?'/api/task/continue':'/api/chat'),{timeout:120000});
 if(confirm)await f.page.getByRole('button',{name:'确认并执行此方案',exact:true}).click();else{await f.page.locator('#message').fill(query);await f.page.locator('#send').click();}
 const r=await response;await f.page.waitForFunction(()=>!!sessionStorage.getItem('creative-session'),{timeout:15000});const s=await settle(f,{refreshPending});await f.page.locator('#send:not([disabled])').waitFor({timeout:15000});
 const disk=s?JSON.parse(await readFile('data/'+s.id+'.json','utf8')):null;
 f.log.steps.push({label,query:confirm?'[用户点击确认并执行此方案]':query,responseStatus:r.status(),state:s,disk,at:new Date().toISOString()});
 console.log(JSON.stringify({step:label,status:s?.status,task:s?.task?.status,artifacts:s?.artifacts?.filter(a=>a.purpose==='deliverable').length}));return s;
}
const valid=s=>(s?.task?.artifacts||[]).filter(a=>a.purpose==='deliverable'&&a.verification?.semantic==='passed'&&!a.metadata?.simulated);
const count=(s,k)=>valid(s).filter(a=>a.type===k).length;
const executions=f=>Object.values(f.log.steps.at(-1)?.disk?.taskStore?.executions||{});
async function finish(id,f,checks,extra={}){
 const directory=join(root,id);await mkdir(directory);let s=await state(f);if(s?.status==='completed'){try{await f.page.locator('#task-panel > strong').filter({hasText:'交付已齐'}).waitFor({timeout:15000});}catch{}}
 const pageText=await f.page.locator('body').innerText();if(s?.status==='completed')checks.uiProgress=s.task.items.every(i=>pageText.includes('验收 '+i.count+'/'+i.count+' · 交付已齐'));
 const readyMedia=valid(s).filter(a=>['image','video'].includes(a.type));if(readyMedia.length){try{await f.page.waitForFunction(urls=>urls.every(url=>Array.from(document.querySelectorAll('img.media-result,video.media-result')).some(n=>(n.currentSrc||n.src)===url&&(n.tagName==='IMG'?n.complete&&n.naturalWidth>0:n.readyState>=1))),readyMedia.map(a=>a.url),{timeout:20000});}catch{}}
 const media=await f.page.locator('img.media-result,video.media-result').evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName,url:n.currentSrc||n.src,loaded:n.tagName==='IMG'?n.complete&&n.naturalWidth>0:n.readyState>=1,width:n.naturalWidth||n.videoWidth,height:n.naturalHeight||n.videoHeight,duration:n.tagName==='VIDEO'?n.duration:null,error:n.error?.message})));
 const current=valid(s).filter(a=>['image','video'].includes(a.type));
 if(current.length)checks.mediaDisplayed=current.every(a=>media.some(m=>m.url===a.url&&m.loaded));
 checks.noBrowserError=!f.log.consoleErrors.length;checks.hasUserAnswer=!!s?.events?.some(e=>e.type==='final'&&e.text);
 if(s?.status==='completed')checks.completedHasArtifact=valid(s).length>0;
 try{await f.page.locator('#artifact-panel').isVisible()&&await f.page.locator('#artifact-panel').scrollIntoViewIfNeeded();}catch{}
 await f.page.screenshot({path:join(directory,'page.png')});
 for(const [i,a] of current.entries()){const loc=f.page.locator(a.type==='image'?'img.media-result':'video.media-result').filter({visible:true});const nodes=f.page.locator(a.type==='image'?'img.media-result':'video.media-result');for(let j=0;j<await nodes.count();j++){if(await nodes.nth(j).getAttribute('src')===a.url){try{await nodes.nth(j).scrollIntoViewIfNeeded();if(a.type==='video'){await nodes.nth(j).evaluate(async v=>{v.muted=true;await v.play();});await f.page.waitForTimeout(1200);checks.videoPlayback=await nodes.nth(j).evaluate(v=>{v.pause();return v.currentTime>0&&v.videoWidth>0;});}await nodes.nth(j).screenshot({path:join(directory,'media-'+i+'.png')});}catch(e){f.log.captureError=e.message;if(a.type==='video')checks.videoPlayback=false;}break;}}}
 const result={id,passed:Object.values(checks).every(Boolean),checks,status:s?.status,taskId:s?.task?.id,sessionId:s?.id,artifacts:valid(s).map(a=>({id:a.id,type:a.type,url:a.url,version:a.version,parentId:a.parentId,verification:a.verification})),executions:executions(f).map(e=>({id:e.id,tool:e.tool,status:e.status,providerTaskId:e.providerTaskId})),...extra};
 await writeFile(join(directory,'trace.json'),JSON.stringify({...f.log,pageText,media,result},null,2));await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2));results.push(result);await writeFile(join(root,'progress.json'),JSON.stringify({completed:results.length,passed:results.filter(r=>r.passed).length,total:12}));console.log(JSON.stringify({id,passed:result.passed,checks,status:result.status}));return result;
}
async function single(id,query,judge,options={}){const f=await fresh();try{const s=await action(f,id,query,options);await finish(id,f,judge(s,f));}catch(e){await writeFile(join(root,id+'-error.json'),JSON.stringify({error:e.message,log:f.log},null,2));results.push({id,passed:false,error:e.message});console.log(JSON.stringify({id,error:e.message}));}finally{await f.context.close();}}
try{
 const original=JSON.parse(await readFile('data/user-e2e-v3/U04-confirm-image/result.json','utf8'));
 const image=original.artifacts.find(a=>a.type==='image');
 const prior=JSON.parse(await readFile('data/user-e2e-v3/U04-confirm-image/trace.json','utf8')).media.find(a=>a.url===image.url);
 for(const mode of ['known','url']){const f=await fresh();try{
 if(mode==='known'){await f.page.evaluate(id=>sessionStorage.setItem('creative-session',id),original.sessionId);await f.page.reload();}
 let first;if(mode==='url')first=await action(f,'missing','把我昨天那张图的背景换成米黄色，其他别动。');
 const query=mode==='known'?'修改原始海报这张图：'+image.url+'，把背景换成淡蓝色，杯子和原图构图保持不变。':'原图在这里：'+image.url+'，按刚才说的改，保持原图构图。';
 const result=await action(f,'edit-'+mode,query);const artifact=valid(result).find(a=>a.type==='image');
 if(artifact)await f.page.waitForFunction(url=>Array.from(document.querySelectorAll('img')).some(i=>i.src===url&&i.complete&&i.naturalWidth>0),artifact.url,{timeout:20000});
 const canvas=artifact?await f.page.locator('img.media-result').evaluateAll((nodes,url)=>{const n=nodes.find(n=>n.src===url);return n?{width:n.naturalWidth,height:n.naturalHeight}:null;},artifact.url):null;
 await finish('R-'+mode,f,{completed:result?.status==='completed',image:!!artifact,canvas:canvas?.width===prior.width&&canvas?.height===prior.height,reference:executions(f).some(e=>e.args.referenceImages?.includes(image.url)),lineage:mode==='known'?artifact?.parentId===image.id:first?.task?.id===result?.task?.id},{sourceCanvas:prior,outputCanvas:canvas});
 }finally{await f.context.close();}}
}finally{await browser.close();await writeFile(join(root,'results.json'),JSON.stringify(results,null,2));await writeFile(join(root,'summary.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),total:results.length,passed:results.filter(r=>r.passed).length,sourceUnchanged:sourceHash===await hash(),sourceHash,mode:'real-browser-real-doubao-real-media'},null,2));}
