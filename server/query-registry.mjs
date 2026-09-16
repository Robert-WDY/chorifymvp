// Query themes share one schema and runtime mapping. Output medium is not an effect.
export const queryRegistry={message:'history',artifacts:'artifact_inventory',task:'task_inspect',execution:'execution_inspect',plan:'task_plan',capabilities:'capabilities',tools:'tools',skills:'skills',skill_detail:'skill_detail',model_identity:'model_identity',quote:'quote'};
export const querySchema={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{enum:Object.keys(queryRegistry)},speaker:{enum:['user','assistant']},position:{enum:['first','previous','anchor']},messageId:{type:'string'},taskIds:{type:'array',items:{type:'string'}},targets:{type:'array',items:{type:'string'}},includeQuote:{type:'boolean'},evidence:{type:'string'}}};
export const presentationSchema={type:'object',additionalProperties:false,required:['targets'],properties:{targets:{type:'array',minItems:1,items:{oneOf:[
 {type:'string',minLength:1},
 {type:'object',additionalProperties:false,required:['type','messageId'],properties:{type:{const:'message'},messageId:{type:'string',minLength:1}}},
 {type:'object',additionalProperties:false,required:['type','artifactId','version'],properties:{type:{const:'artifact'},artifactId:{type:'string',minLength:1},version:{type:'integer',minimum:1}}}
]}},format:{enum:['inline','gallery','links']},order:{const:'as_listed'}}};
export const isPresentation=d=>!!d.references?.length&&(['present','retain'].includes(d.action)||d.kind!=='text'&&d.action==='respond');
export function assertQueryTopic(query,op){
 if(!queryRegistry[op.query?.kind])throw new Error('查询主题未实现，不能默认查询历史消息');
 if(op.query.kind==='message'&&!op.query.messageId&&(!op.query.speaker||!op.query.position))throw Object.assign(new Error('历史读取需明确消息ID，或 speaker 和 position；不能猜测历史对象'),{issues:[...(!op.query.speaker?[{path:'/turnOperation/query/speaker'}]:[]),...(!op.query.position?[{path:'/turnOperation/query/position'}]:[])]});
 if(op.query.kind==='message'&&op.query.position==='anchor'&&!op.query.messageId)throw new Error('锚定历史读取缺少 messageId');
 if(op.query.evidence&&!query.includes(op.query.evidence))throw new Error('查询依据不是本轮原文');
}
