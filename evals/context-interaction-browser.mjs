// Real browser + local HTTP + scripted model + simulated media. No paid calls.
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createContextServer} from '../server/context-agent/http.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {HistoryStore} from '../server/context-agent/history.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const out=resolve(process.argv[2]||'evaluation-runs/browser-interaction');await mkdir(out,{recursive:true});
const startedAt=Date.now();let firstVisibleActivityMs;
const dir=await mkdtemp(join(tmpdir(),'chorify-browser-')),store=new HistoryStore(dir),state=await store.create('browser');
state.assets.source={id:'source',type:'image',name:'产品原图',version:1,ownerId:'browser',url:'https://fixture.test/source.png'};
state.assets.facts={id:'facts',type:'text',name:'产品资料',version:1,ownerId:'browser',content:'白色护肤瓶，容量未知。'};await store.save(state,'browser');
let main=0,releaseRead,releaseFinal;const readGate=new Promise(r=>releaseRead=r),finalGate=new Promise(r=>releaseFinal=r),inputs=[],events=[];
const say=text=>[{type:'message',role:'assistant',content:[{type:'output_text',text}]}];
const call=(name,args,id)=>[{type:'function_call',name,arguments:JSON.stringify(args),call_id:id}];
const question={message:'请确定两个必要配置',questions:[{key:'placement',label:'发布位置',allowFreeText:true,options:[{id:'social',label:'社交信息流'}]},{key:'language',label:'语言',allowFreeText:false,options:[{id:'zh',label:'中文'}]}]};
const actual=createTools(),tools={...actual,execute:async(name,args,ctx)=>{if(name==='read_asset')await readGate;return actual.execute(name,args,ctx);}};
const brain={respond:async (input,_tools,_signal,options)=>{
 inputs.push(input);const last=input.filter(m=>m.role==='user').at(-1)?.content;const text=typeof last==='string'?last:last?.[0]?.text;
 if(text==='测试流式中断'){await options.onTextDelta('公开文字片段，尚未完成。');throw new Error('模拟供应商事件流截断');}
 switch(main++){
 case 0:assert.match(JSON.stringify(input),/selectedAssets/);return [...say('我先读取选中的产品资料，再准备方案。'),...call('inspect_workspace',{},'workspace')];
 case 1:return call('read_asset',{id:'facts'},'read');
 case 2:return call('request_user_input',question,'question');
 case 3:assert.match(JSON.stringify(input),/social/);return call('generate_image',{prompt:'白色护肤瓶，社交信息流，无容量功效宣称',size:'1024x1024',referenceImages:['source'],sourceIds:['facts']},'prepare');
 case 4:await finalGate;return say('方案已保存，尚未生成。');
 case 5:return say('已取得模拟结果，不是真实成品。');
 case 6:{const saved=await store.load(state.id,'browser');const image=Object.values(saved.assets).find(a=>a.simulated&&a.type==='image');return call('edit_image',{imageId:image.id,instruction:'只改蓝背景，产品保持不变'},'edit');}
 default:return say('修改方案已保存，等待批准。');
 }
}};
const app=createContextServer({brain,tools,store,ownerId:'browser',modelEnabled:true,agentOptions:{maxMediaCalls:3}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{channel:'msedge'})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fixture.test/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="140" height="120"><rect x="40" y="15" width="60" height="90" rx="12" fill="#ddd"/></svg>'}));
 await page.addInitScript(({id})=>localStorage.setItem('chorify.context-agent.session',id),{id:state.id});
 await page.goto(base);await page.locator('[data-asset-id="source"] input').check();await page.locator('[data-asset-id="facts"] input').check();
 await page.locator('#message').fill('帮选中的产品做广告图');await page.locator('#send').click();
 await page.waitForSelector('[data-activity-id="read"][data-status="running"]');firstVisibleActivityMs=Date.now()-startedAt;assert.equal(await page.locator('[data-activity-id="read"]').count(),1);events.push('slow-tool-visible-before-result');
 await page.screenshot({path:join(out,'01-tool-running.png'),fullPage:true});releaseRead();
 await page.waitForSelector('.question');assert.equal(main,3);await page.waitForTimeout(150);assert.equal(main,3);assert.equal(await page.locator('[data-activity-id="read"]').count(),1);events.push('question-pauses-model');
 await page.locator('select[name="placement"]').selectOption('social');await page.getByRole('button',{name:'提交回答',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.question')?.textContent.includes('已回答：社交信息流'));assert.equal(main,3);
 await page.reload();await page.waitForSelector('select[name="language"]');assert.match(await page.locator('.question').textContent(),/已回答：社交信息流/);events.push('partial-answer-restored');
 await page.locator('select[name="language"]').selectOption('zh');await page.getByRole('button',{name:'提交回答',exact:true}).click();
 await page.waitForSelector('.proposal-item');assert.equal(main,5);assert.equal(await page.getByRole('button',{name:'批准选中的模拟方案'}).isDisabled(),true);events.push('proposal-visible-before-final-model-response');
 await page.screenshot({path:join(out,'02-proposal-during-run.png'),fullPage:true});await page.reload();await page.waitForSelector('.proposal-item');assert.equal(main,5);assert.equal(await page.locator('#send').isDisabled(),true);events.push('reload-recovers-running-request-without-new-model-call');releaseFinal();
 await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 const proposalId=await page.locator('.proposal-item').getAttribute('data-proposal-id');await page.locator('.proposal-item input').check();await page.getByRole('button',{name:'批准选中的模拟方案'}).click();
 await page.waitForFunction(()=>!document.querySelector('#send').disabled);let saved=await store.load(state.id,'browser');let receipts=Object.values(saved.invocations).filter(i=>i.kind==='media');assert.equal(receipts.length,1);assert.equal(receipts[0].proposalId,proposalId);assert.deepEqual(receipts[0].args,saved.approvals[proposalId].args);events.push('button-proposal-id-equals-receipt-frozen-args');
 const config=await(await fetch(base+'/api/config')).json();const response=await fetch(base+'/api/approve',{method:'POST',headers:{'Content-Type':'application/json','x-context-token':config.csrf},body:JSON.stringify({sessionId:state.id,proposalIds:[proposalId],requestId:'repeat'})});await response.text();
 saved=await store.load(state.id,'browser');assert.equal(Object.values(saved.invocations).filter(i=>i.kind==='media').length,1);events.push('duplicate-confirmation-no-second-media');
 // The repeated approval consumed a scripted reply; use a dedicated edit decision next.
 main=6;await page.locator('#message').fill('只把背景改蓝色，产品保持不变');await page.locator('#send').click();await page.waitForSelector('.proposal-item');await page.waitForFunction(()=>!document.querySelector('#send').disabled);
 saved=await store.load(state.id,'browser');const edit=Object.values(saved.approvals).find(p=>p.name==='edit_image');assert.equal(edit.args.imageId,receipts[0].assetIds[0]);events.push('edit-binds-actual-result');
 await page.route('**/api/session/'+state.id,async route=>{const response=await route.fetch(),data=await response.json();data.events=[...data.events,...data.events].reverse();await route.fulfill({response,json:data});});
 await page.reload();await page.waitForSelector('.proposal-item');assert.equal(await page.locator('[data-activity-id="read"]').count(),1);events.push('duplicate-out-of-order-replay-does-not-duplicate-cards');await page.unroute('**/api/session/'+state.id);await page.screenshot({path:join(out,'03-restored.png'),fullPage:true});
 let creates=0;page.on('request',r=>{if(r.method()==='POST'&&r.url()===base+'/api/session')creates++;});
 await page.route('**/api/session/'+state.id,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary outage"}'}));
 await page.reload();await page.waitForSelector('#retry:visible');assert.equal(await page.evaluate(()=>localStorage.getItem('chorify.context-agent.session')),state.id);assert.equal(creates,0);events.push('failed-restore-keeps-session-no-create');
 await page.screenshot({path:join(out,'04-recovery-failure.png'),fullPage:true});await page.unroute('**/api/session/'+state.id);await page.locator('#retry').click();await page.waitForSelector('.proposal-item');
 const beforeStream=await store.load(state.id,'browser'),beforeCalls=beforeStream.records.filter(r=>r.kind==='tool_call').length;
 await page.locator('#message').fill('测试流式中断');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);await page.waitForFunction(()=>document.querySelector('#messages').textContent.includes('连接中断，文字未完成'));
 const afterStream=await store.load(state.id,'browser');assert.equal(afterStream.records.filter(r=>r.kind==='tool_call').length,beforeCalls);events.push('partial-public-text-visible-and-marked-incomplete-no-tool-execution');await page.screenshot({path:join(out,'05-stream-interrupted.png'),fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));
 await writeFile(join(out,'result.json'),JSON.stringify({status:'passed',browser:'Microsoft Edge headless via Playwright',events,pageErrors:errors,mainModel:'scripted',scriptedModelCalls:inputs.length,firstVisibleActivityIncludingBrowserStartupMs:firstVisibleActivityMs,realModelCalls:0,realMediaCalls:0,media:'simulation',sessionId:state.id},null,2));
 await writeFile(join(out,'session.json'),JSON.stringify(await store.exportSession(state.id,'browser'),null,2));await writeFile(join(out,'model-inputs.json'),JSON.stringify(inputs,null,2));console.log(JSON.stringify({out,status:'passed',events}));
}catch(error){await writeFile(join(out,'failure.txt'),error.stack);throw error;}
finally{releaseRead();releaseFinal();await browser.close();await new Promise(r=>app.server.close(r));await rm(dir,{recursive:true,force:true});}
