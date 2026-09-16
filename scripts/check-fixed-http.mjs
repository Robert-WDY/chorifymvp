import {writeFile} from 'node:fs/promises';
const base=process.argv[2]||'http://127.0.0.1:3212',config=await(await fetch(base+'/api/config')).json();
const response=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-MVP-Token':config.csrf},body:JSON.stringify({message:'只查询当前已实现的图片生成工具与专业Skill，以及实际报价来源是否已配置。不要执行任何媒体生成。',requestId:crypto.randomUUID()}),signal:AbortSignal.timeout(180000)});
const events=(await response.text()).split('\n').filter(Boolean).map(JSON.parse),final=events.findLast(e=>e.type==='final');
const result={httpStatus:response.status,sessionId:events[0]?.sessionId,status:final?.status,tools:events.filter(e=>e.type==='tool_result').map(e=>e.name),skillCount:config.skills.length,registryVersion:config.capabilities.registry.version,events};
await writeFile('data/fixed-http-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,events:undefined}));if(final?.status!=='completed')process.exitCode=1;
