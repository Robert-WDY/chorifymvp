export function historyRows(state,source,legacy){
 switch(source){
  case 'records':return state.records;
  case 'assets':return Object.values(state.assets||{});
  case 'approvals':return Object.values(state.approvals||{});
  case 'legacyMessages':return legacy?.messages||[];
  case 'legacyCalls':return legacy?.modelCalls||[];
  case 'legacyEvents':return legacy?.events||[];
  case 'legacyTasks':return Object.values(legacy?.taskStore?.tasks||{});
  case 'legacyArtifacts':return Object.values(legacy?.taskStore?.artifacts||{});
  case 'legacyExecutions':return Object.values(legacy?.taskStore?.executions||{});
  default:throw new Error('Unknown history section');
 }
}
export function historyPage(rows,offset=0,limit=30){
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid history page');
 return {total:rows.length,hasMore:offset+limit<rows.length,rows:rows.slice(offset,offset+limit).map((r,i)=>({index:offset+i,id:r.id||r.callId||null,label:[r.at||r.createdAt,r.kind||r.type,r.event||r.name||r.role||r.status].filter(Boolean).join(' · ')||'历史记录'}))};
}
