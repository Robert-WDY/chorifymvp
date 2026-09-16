import {tools} from './tool-schemas.mjs';
const text={type:'string',minLength:1};
export const mediaSkills=[
 {slug:'image_creation_skill',name:'图片创作',description:'构图、文字与引用角色规划，生成或编辑图片',operations:['generate_image','edit_image'],tool:'generate_image',methods:['image-prompt-gallery-director-v2','creative-cover-copy-v2']},
 {slug:'video_creation_skill',name:'视频创作',description:'创意、分镜、时长与参考图规划，生成视频',operations:['generate_video'],tool:'generate_video',methods:['video-script-zh-v1','storyboard-one-shot-zh-v2','video-prompt-safety-zh-v1']},
].map(s=>({...s,version:1,inputSchema:{type:'object',required:['goal','sources','feedback'],properties:{goal:{type:'object'},sources:{type:'array'},feedback:{type:'array'}}},outputSchema:{type:'object',additionalProperties:false,required:['concept','preservedConstraints','safety','items'],properties:{concept:text,preservedConstraints:{type:'array',items:text},safety:{type:'object',additionalProperties:false,required:['passed','reason'],properties:{passed:{type:'boolean'},reason:text}},items:{type:'array',minItems:1,maxItems:20,items:tools.find(t=>t.name===s.tool).parameters}}},allowedTools:[s.tool],workflow:['理解目标和真实引用','编写构图或分镜与完整执行参数','检查约束和内容安全','提交结构化方案供系统校验'],validation:['schema','count','references','constraints','safety','plan_validator']}));
export const publicTools=tools.filter(t=>['find_material','generate_image','generate_video'].includes(t.name));
export function mediaSkillFor(operation){return mediaSkills.find(s=>s.operations.includes(operation));}
