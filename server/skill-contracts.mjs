import Ajv from 'ajv';
const text={type:'string',minLength:1};
const fieldSchema=name=>name==='durationSeconds'?{type:'number',minimum:0}:['shots','directions','views','facts','assumptions','sellingPoints','issues','observations','preservedConstraints','performanceChanges'].includes(name)?{type:'array',items:{anyOf:[{type:'string'},{type:'object'}]}}:name==='referenceRoles'?{anyOf:[{type:'array',items:{anyOf:[{type:'string'},{type:'object'}]}},{type:'object'}]}:{type:'string'};
const profiles={
 'actor-realism-v2':{operations:['rewrite','storyboard','generate_image','edit_image','generate_video'],steps:['读取原始正文与锁定信息','检查动作、身份与表演连续性','输出保留约束的优化正文'],fields:['preservedConstraints','performanceChanges']},
 'asset-lock-generator-lite-v2':{operations:['generate_image','edit_image'],steps:['确认真实资产引用与预算','制定锚点及视图方案','按任务授权执行并验证引用一致性'],fields:['referenceRoles','views']},
 'creative-cover-copy-v2':{operations:['marketing_script','rewrite','generate_image','edit_image'],steps:['整理用户提供的产品与媒体证据','撰写文案和封面信息','核对文案和画面约束'],fields:['headline','body','cta']},
 'creative-prompt-rewrite':{operations:['rewrite','generate_video','storyboard'],steps:['提取必须保留的信息','修正冲突和不可执行的描述','交付可执行提示词并检查保留项'],fields:['prompt','preservedConstraints']},
 'cinematic-shot-designer-zh-v5':{operations:['storyboard','generate_image'],steps:['解析原场景','规划同一张画面内的多宫格镜头','核对整版构图与台词'],fields:['shots','layout']},
 'cinematic-style-optimizer-v2':{operations:['rewrite','generate_image','edit_image','generate_video'],steps:['保留原事件与参数','选择兼容影调与光学风格','输出风格提示词并核对不变项'],fields:['style','preservedConstraints']},
 'direction-designer-zh-v1':{operations:['answer','marketing_script','storyboard','generate_video'],steps:['整理目标受众及事实缺口','提出差异化创意方向','给出方向选择依据'],fields:['directions','recommendation']},
 'image-prompt-gallery-director-v2':{operations:['rewrite','generate_image','edit_image'],steps:['读取画面约束和参考角色','选择清单内参考资料','交付布局主体光影文字与排除项'],fields:['prompt','referenceRoles']},
 'marketing-brief-zh-v1':{operations:['marketing_script','answer','storyboard'],steps:['区分产品事实与假设','归纳受众卖点传播目标','交付营销brief并标注待核验信息'],fields:['audience','hook','brief']},
 'product-understanding-zh-v1':{operations:['marketing_script','analyze_image','review_content','answer'],steps:['读取现有产品证据','提炼卖点与使用场景','分离未知事实和可用结论'],fields:['facts','assumptions','sellingPoints']},
 'storyboard-one-shot-zh-v2':{operations:['storyboard','rewrite','generate_video'],steps:['提取事件与对白','编排镜头和实际时长','核对连续性并输出分镜'],fields:['shots','durationSeconds']},
 'storyboard-one-shot-zh':{operations:['storyboard','rewrite','generate_video'],steps:['提取事件对白与视觉约束','编排镜头时序','交付完整分镜正文'],fields:['shots','durationSeconds']},
 'video-decomposition-zh-v1':{operations:['read_video','analyze_video','storyboard'],steps:['读取真实视频观察','拆解镜头节奏与卖点','标注证据与不确定项'],fields:['shots','observations']},
 'video-prompt-safety-zh-v1':{operations:['review_content','rewrite','generate_video'],steps:['区分待审材料与执行指令','审查风险与夸大事实','输出理由及安全调整建议'],fields:['verdict','issues','safeAlternative']},
 'video-script-zh-v1':{operations:['marketing_script','storyboard','generate_video','rewrite'],steps:['明确受众目标与信息边界','编排开场正文和收尾','检查时长与台词并交付'],fields:['hook','body','cta']},
};
export function skillContract(skill){
 const p=profiles[skill.slug]||{operations:['rewrite','storyboard','marketing_script'],steps:['读取输入合同','应用已登记专业方法','检查输出合同'],fields:['result']};
 const structured=p.fields.some(f=>['directions','shots'].includes(f));
 const sections={type:'array',items:{type:'object',additionalProperties:false,required:['content'],properties:{title:{type:'string'},content:{type:'string',minLength:1}}}};
 const forms=({'video-script-zh-v1':['script','composite'],'creative-cover-copy-v2':['copy','title','composite'],'creative-prompt-rewrite':['prompt'],'direction-designer-zh-v1':['directions','script','composite'],'storyboard-one-shot-zh-v2':['script','composite'],'storyboard-one-shot-zh':['script','composite']})[skill.slug];
 return {version:skill.slug==='cinematic-shot-designer-zh-v5'?3:2,deliveryLayouts:skill.slug==='cinematic-shot-designer-zh-v5'?['storyboard_sheet']:undefined,forms,prerequisites:{required:[],optional:['source_material'],sideEffects:'only_via_authorized_executor'},role:skill.name,operations:p.operations,inputSchema:{type:'object',required:['sources'],anyOf:[{required:['goal']},{required:['item']}],properties:{goal:{type:'object'},item:{type:'object'},sources:{type:'array'},feedback:{anyOf:[{type:'string'},{type:'object'},{type:'null'}]}}},
 representation:structured?'structured':'content',outputSchema:{type:'object',additionalProperties:false,required:structured?['structure']:['content','structure'],properties:{...(structured?{}:{content:text}),structure:{type:'object',required:p.fields,properties:{...Object.fromEntries(p.fields.map(f=>[f,fieldSchema(f)])),...(structured?{sections}:{})},additionalProperties:false}}},
 allowedTools:[],scriptPolicy:{mode:'optional_external_diagnostics',scheduled:false,claimRequiresReceipt:true},workflow:p.steps,validation:['schema','required_observation','preserve_user_constraints','no_fabricated_artifact'],scripts:skill.scriptDefinitions?.map(s=>s.name)||[]};
}
export function validateSkillOutput(contract,value){const validate=new Ajv({strict:false}).compile(contract.outputSchema);if(!validate(value))throw new Error('Skill输出合同不匹配：'+JSON.stringify(validate.errors));return value;}
export function validateSkillInput(contract,value){const validate=new Ajv({strict:false}).compile(contract.inputSchema);if(!validate(value))throw new Error('Skill输入合同不匹配：'+JSON.stringify(validate.errors));return value;}
