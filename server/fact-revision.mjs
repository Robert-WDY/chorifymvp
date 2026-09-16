// Preserve inherited factual obligations unless the current request explicitly
// revises them. A freshly generated list is not a deletion record.
export function reviseFactRequirements(previous,changes,query){
 if(!changes||!Array.isArray(changes.add)||!Array.isArray(changes.remove))throw new Error('修订必须输出factChanges.add/remove，分别记录新增与取消的系统事实要求及本轮原文依据');
 for(const change of [...changes.add,...changes.remove])if(!['capabilities','quote','task_state'].includes(change.source)||typeof change.evidence!=='string'||!change.evidence.trim()||!query.includes(change.evidence))throw new Error('事实要求变更缺少有效来源与本轮逐字原文依据');
 if(changes.add.some(a=>changes.remove.some(r=>r.source===a.source)))throw new Error('同一事实要求不能同时新增和取消');
 return [...new Set([...previous.filter(s=>!changes.remove.some(r=>r.source===s)),...changes.add.map(a=>a.source)])];
}
