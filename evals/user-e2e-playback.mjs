import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'file:///C:/Users/dongxu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const tag=process.argv[2]||'v3';if(!/^[a-z0-9-]+$/.test(tag))throw new Error('Invalid tag');
const root=resolve('data/user-e2e-'+tag),output=join(root,'playback-review');await mkdir(output,{recursive:false});const results=[];
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{for(const id of ['U06-script-video','U11-natural-video']){
 const r=JSON.parse(await readFile(join(root,id,'result.json'),'utf8')),a=r.artifacts.find(a=>a.type==='video');if(!a){results.push({id,passed:false,error:'No accepted video'});continue;}
 const context=await browser.newContext({viewport:{width:1440,height:1400}});await context.addInitScript(id=>sessionStorage.setItem('creative-session',id),r.sessionId);const page=await context.newPage();await page.goto('http://127.0.0.1:3210');
 await page.waitForFunction(url=>Array.from(document.querySelectorAll('video')).some(v=>v.src===url&&v.readyState>=1),a.url,{timeout:30000});const videos=page.locator('video');let video;for(let i=0;i<await videos.count();i++)if(await videos.nth(i).getAttribute('src')===a.url){video=videos.nth(i);break;}
 await video.scrollIntoViewIfNeeded();await video.evaluate(async v=>{v.muted=true;v.currentTime=0;await v.play();});
 for(const second of [1,3]){await page.waitForFunction(({url,second})=>Array.from(document.querySelectorAll('video')).some(v=>v.src===url&&v.currentTime>=second),{url:a.url,second},{timeout:15000});await video.screenshot({path:join(output,id+'-'+second+'s.png')});}
 await page.waitForFunction(url=>Array.from(document.querySelectorAll('video')).some(v=>v.src===url&&v.ended),a.url,{timeout:15000});
 const observed=await video.evaluate(v=>({width:v.videoWidth,height:v.videoHeight,duration:v.duration,ended:v.ended,currentTime:v.currentTime,readyState:v.readyState,error:v.error?.message}));
 const result={id,source:a.url,...observed,passed:observed.ended&&observed.width>0&&!observed.error&&(id!=='U06-script-video'||Math.abs(observed.duration-5)<0.3&&Math.abs(observed.width/observed.height-9/16)<0.01)};results.push(result);console.log(JSON.stringify(result));await context.close();
}}finally{await browser.close();await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));}
