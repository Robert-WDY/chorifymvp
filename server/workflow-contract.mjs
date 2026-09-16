// A document slot may require several independently executed stages.
// Stage order is explicit in requiredMethods; it is never inferred from prose.
export function workflowStages(item){
 if(item.output!=='text'||(item.requiredMethods||[]).length<2)return [];
 return item.requiredMethods.map((skillId,index)=>({id:item.id+':stage:'+index,skillId,index,dependsOn:index?[item.id+':stage:'+(index-1)]:[],spec:structuredClone(item.spec||{})}));
}
export function unresolvedScope(task){
 const semantic=task.goal.semantic;
 if(semantic?.deferred?.length)return '仍有未编入执行合同的延期要求：'+semantic.deferred.join('；');
 if(task.approval.required&&!task.items.some(i=>i.output!=='text'))return '确认后的交付义务尚未编入执行合同';
 return null;
}
