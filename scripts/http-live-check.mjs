import { writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:3210';const config=await(await fetch(base+'/api/config')).json();
const reports=[];let sessionId;
for(const message of ['把“清晨，一杯咖啡唤醒城市”改写成一句有画面感的视频提示词，只要文字，不生成媒体。','把刚才的提示词改成夜晚，保持咖啡主题，只给改写后的一句话。']) {
  const response=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-MVP-Token':config.csrf},body:JSON.stringify({message,sessionId}),signal:AbortSignal.timeout(240000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const events=(await response.text()).split('\n').filter(Boolean).map(JSON.parse);sessionId=events[0].sessionId;
  const final=events.at(-1);const report={message,status:final.status,answer:final.text,tools:events.filter(e=>e.type==='tool_result').map(e=>({name:e.name,error:!!e.result.isError}))};reports.push(report);console.log(JSON.stringify({status:report.status,tools:report.tools}));
}
const passed=reports.every(r=>r.status==='completed'&&r.answer?.length>10)&&reports[1].answer.includes('夜');
await writeFile(new URL('../data/http-live-check.json',import.meta.url),JSON.stringify({time:new Date().toISOString(),sessionId,mode:'real-http-real-doubao-local-skills',passed,reports},null,2));
if(!passed)process.exitCode=1;
