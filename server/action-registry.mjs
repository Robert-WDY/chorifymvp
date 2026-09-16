// Business meaning is selected once. Evidence, tool and revision semantics are
// program-owned and are compiled into the existing executor contract.
import {activationSchema,authorizationSchema} from './stage-contract.mjs';
import {evidenceSpansSchema} from './request-input.mjs';
export const actionRegistry=Object.freeze({
 CREATE_IMAGE:{target:null,output:'IMAGE_ARTIFACT',kind:'image',action:'create',operation:'generate_image',evidence:'none',relation:'created',steps:['bind_sources','prepare_image','submit_image','record_artifact']},
 EDIT_IMAGE:{target:'IMAGE',output:'IMAGE_ARTIFACT',kind:'image',action:'modify',operation:'edit_image',evidence:'none',relation:'revision_of',steps:['load_original','prepare_revision','submit_image','record_revision']},
 ANALYZE_IMAGE:{target:'IMAGE',output:'ANALYSIS_REPORT',kind:'text',action:'respond',operation:'analyze_image',evidence:'image',relation:'read_only',steps:['load_original','visual_observation','compose_answer']},
 CREATE_VIDEO:{target:null,output:'VIDEO_ARTIFACT',kind:'video',action:'create',operation:'generate_video',evidence:'none',relation:'created',steps:['bind_sources','prepare_video','submit_video','poll_receipt','record_artifact']},
 CONFIRM_ARTIFACT:{target:'PROPOSAL',output:'EXISTING_DELIVERIES',operation:'approve',relation:'authorize_existing_revision',steps:['verify_proposal_version','approve_saved_plan','resume_existing_execution']}
});
export const actionTypes=Object.keys(actionRegistry);
export const actionModes=['shadow','image_edit','core'];
export function actionEnabled(type,mode){return mode==='core'||mode==='image_edit'&&type==='EDIT_IMAGE';}
const string={type:'string',minLength:1,maxLength:1600},strings={type:'array',items:string,maxItems:20};
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const target={oneOf:[
 object({type:{const:'CANDIDATE'},handle:string},['type','handle']),
 ...['IMAGE','VIDEO','TEXT'].map(type=>object({type:{const:type},id:string,version:{type:'integer',minimum:1}},['type','id','version'])),
 object({type:{const:'ACTION_OUTPUT'},actionId:string},['type','actionId']),
 object({type:{const:'PROPOSAL'},id:string,version:{type:'integer',minimum:1},taskId:string,taskRevision:{type:'integer',minimum:1},planHash:string},['type','id','version','taskId','taskRevision','planHash'])
]};
export const businessActionSchema=object({
 activation:activationSchema,id:string,actionType:{enum:actionTypes},target,intent:string,constraints:strings,
 expectedOutput:object({type:{enum:[...new Set(Object.values(actionRegistry).map(a=>a.output))]},count:{type:'integer',minimum:1,maximum:1000}}),
 confirmation:{type:'boolean'},confirmationEvidence:{type:'string'},requestEvidence:{type:'string'},requestEvidenceSpans:evidenceSpansSchema,
 sources:{type:'array',items:target,maxItems:20},
 modification:object({change:{...strings,minItems:1},preserve:strings},['change','preserve']),
 parameters:object({ratio:string,durationSeconds:{type:'number',minimum:1},exactTexts:strings})
},['id','actionType','intent']);
export function businessRequestSchema(safety,gaps){return object({executionAuthorization:authorizationSchema,speakerRole:{type:'string'},targetAudience:{type:'string'},summary:string,businessActions:{type:'array',minItems:1,maxItems:12,items:businessActionSchema},safety,gaps,facts:strings,globalConstraints:strings,assumptions:strings},['summary','businessActions','safety']);}
export function actionInstructions(mode){
 const enabled=actionTypes.filter(type=>actionEnabled(type,mode));
 return '本模式启用的核心动作：'+(enabled.join('、')||'无，使用兼容合同')+'。businessActions每项含唯一id、actionType、intent；expectedOutput.count表示成品数。消费同轮输出用target或sources的{type:"ACTION_OUTPUT",actionId}。target优先用{type:"CANDIDATE",handle:目录句柄}，由程序绑定真实版本。EDIT_IMAGE的modification填写change/preserve，CONFIRM_ARTIFACT只能使用输入中完整真实PROPOSAL。核心动作不填工具、Skill、DAG或form；未迁移目标使用兼容合同。';
}
