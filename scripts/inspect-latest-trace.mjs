import {readFile,writeFile} from 'node:fs/promises';
import {redact} from '../server/trace-context.mjs';
const s=JSON.parse(await readFile('data/general-context-repair-20260914/before/session.json','utf8'));
const text=m=>typeof m.content==='string'?m.content:(m.content||[]).map(p=>p.text||'').join('\n');
const users=s.messages.filter(m=>m.role==='user');
const summary=s.turns.map((t,i)=>({turn:i+1,query:text(users[i]),runId:t.runId,status:t.status,error:t.error,
 calls:s.modelCalls.filter(c=>c.runId===t.runId).map(c=>({id:c.id,phase:c.methodId||c.input?.[0]?.content?.slice(0,24),inputKeys:(()=>{try{return Object.keys(JSON.parse(c.input?.at(-1)?.content));}catch{return [];}})(),output:c.output?.map(text).join('\n'),validations:c.validations})),
 events:s.events.filter(e=>e.runId===t.runId&&['intent','intent_error','tool_start','final'].includes(e.type)),
}));
await writeFile('data/general-context-repair-20260914/turn-analysis-input.json',JSON.stringify(redact(summary),null,2));
for(const t of summary){console.log(JSON.stringify({turn:t.turn,query:t.query,status:t.status,calls:t.calls.map(c=>({id:c.id,phase:c.phase,output:c.output?.slice(0,1450)}))}));}
