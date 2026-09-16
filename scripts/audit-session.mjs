import {readFile,writeFile} from 'node:fs/promises';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node scripts/audit-session.mjs session.json report.json');
const state=JSON.parse(await readFile(input,'utf8')),users=state.messages.filter(m=>m.role==='user'),turns=[];
let turn;
for(const event of state.events){
 if(event.type==='start'){turn={number:turns.length+1,query:users[turns.length]?.content,runId:event.runId,tools:[],intents:[],errors:[]};turns.push(turn);}
 if(!turn)continue;
 if(event.type==='intent')turn.intents.push(event.goal);
 if(event.type==='intent_error')turn.errors.push({error:event.error,intakeTrace:event.intakeTrace});
 if(event.type==='tool_result')turn.tools.push({name:event.name,callId:event.callId,isError:!!event.result.isError});
 if(event.type==='final'){
  const task=state.taskStore.tasks[event.taskId];
  turn.final={status:event.status,taskId:event.taskId,text:event.text};
  turn.taskQuery=task?.query;
  turn.differsFromTaskQuery=!!task&&task.query!==turn.query;
  turn.artifacts=(event.artifacts||[]).filter(a=>a.purpose==='deliverable').map(a=>({id:a.id,itemId:a.itemId,type:a.type,version:a.version,parentId:a.parentId,characters:a.content?.length||0,stageHeadings:(a.content?.match(/阶段[一二三四]/g)||[]).length,verification:a.verification}));
 }
}
const result={sessionId:state.id,source:input,rawModelCallsAvailable:Array.isArray(state.calls)||Array.isArray(state.modelCalls),
 counts:{turns:turns.length,messages:state.messages.length,events:state.events.length,tasks:Object.keys(state.taskStore.tasks).length,executions:Object.keys(state.taskStore.executions).length},
 finalState:{sessionStatus:state.status,lastTurn:state.lastTurn,activeTaskId:state.taskStore.activeTaskId},turns};
await writeFile(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({sessionId:result.sessionId,...result.counts,rawModelCallsAvailable:result.rawModelCallsAvailable,turns:turns.map(t=>({number:t.number,status:t.final?.status,tools:t.tools.map(x=>x.name),differentTaskQuery:t.differsFromTaskQuery,artifacts:t.artifacts?.map(a=>({type:a.type,stageHeadings:a.stageHeadings}))}))},null,2));
