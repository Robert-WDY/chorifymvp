import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
// Item definitions have one source: the accepted Goal. Runtime progress is
// explicitly excluded; any new definition field is protected by default.
const progress=new Set(['id','status','artifactIds','observations','methods','issues','methodExecution','requirementIds','requirementCoverage','coverageProgress','resolvedCoverage','resolvedSelectorBinding','readReceipt','noChangeReceipt']);
export function itemDefinition(goal,index){
 const source=structuredClone(goal.tasks[index]);
 return {...source,index,description:goal.semantic?.deliverables?.[index]?.description||goal.summary,spec:source.spec||{}};
}
export function assertExecutionProjection(task){
 if(task.contract&&task.contract.hash!==createHash('sha256').update(JSON.stringify(task.goal)).digest('hex'))throw new Error('已接受的任务合同被修改，必须创建修订版本');
 if(!task.goal?.tasks||!Array.isArray(task.items)||task.items.length!==task.goal.tasks.length)throw new Error('执行项数量偏离已接受目标');
 const ids=new Set();
 for(const [index,item] of task.items.entries()){
  if(!item.id||ids.has(item.id))throw new Error('执行项身份无效或重复');ids.add(item.id);
  const actual=Object.fromEntries(Object.entries(item).filter(([key])=>!progress.has(key)));
  if(!isDeepStrictEqual(actual,itemDefinition(task.goal,index)))throw Object.assign(new Error('执行项定义偏离已接受目标：'+index+'；必须创建修订版本'),{code:'execution_projection'});
 }
 if(task.contract?.itemIds&&!isDeepStrictEqual(task.contract.itemIds,task.items.map(i=>i.id)))throw new Error('已接受的执行项身份或顺序发生变化');
}
