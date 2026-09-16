// Business ledger projection only. Never embeds turns, model calls or chat bodies
// recursively, and is not an input to planning or execution.
export function businessStateSnapshot(state){
 const store=state.taskStore||{};
 return {schemaVersion:1,capturedAt:new Date().toISOString(),scope:'session business ledger; excludes trace, chat bodies and presentation caches',
  data:structuredClone({sessionId:state.id,sessionStatus:state.status,lastTurn:state.lastTurn,
   activeTaskId:store.activeTaskId||null,version:store.version,
   tasks:store.tasks||{},artifacts:store.artifacts||{},executions:store.executions||{},inputs:store.inputs||{},
   decisions:store.decisions||[],actions:state.actions||{},messageCount:(state.messages||[]).filter(m=>['user','assistant'].includes(m.role)).length})};
}
