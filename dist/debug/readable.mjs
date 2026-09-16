// Evidence-only presentation. No model calls, business decisions, or state mutations.
export const list=x=>Array.isArray(x)?x:Object.values(x||{});
const words={understand:'理解用户请求',inspect:'读取已有信息',inspection:'读取事实',present:'展示已有成果',retain:'保留已有成果',create:'创建成果',modify:'修改成果',revise:'修订任务',revise_plan:'修改待确认方案',approve:'确认保存的方案',resume:'继续任务',new:'新建任务',continue:'继续任务',clarify:'补充需求',cancel:'取消任务',answer:'文字回答',respond:'回答',text:'文字',image:'图片',video:'视频',audio:'音频',media:'媒体生成',model_identity:'模型身份',runtime_registry:'运行配置与能力注册表',conversation:'对话历史',capabilities:'系统能力',generate_image:'生成图片',edit_image:'编辑图片',generate_video:'生成视频',analyze_image:'分析图片',marketing_script:'宣传脚本',storyboard:'分镜',rewrite:'改写',run_skill:'执行 Skill 方法',use_skill:'使用 Skill',read_skill:'加载 Skill',read_skill_reference:'读取 Skill 参考',select_capabilities:'选择能力',commit_text_deliverable:'提交文字成果',inspect_runtime:'读取运行事实',refresh_task_results:'查询异步任务结果',update_plan:'更新计划',parameter_delta:'参数增量修改',creative_revision:'创意修订',completed:'已完成（记录状态）',COMPLETED:'已完成（记录状态）',PLANNING:'规划中',EXECUTING:'执行中',VERIFYING:'验收中',WAIT_CONFIRM:'等待确认',WAITING:'等待工具结果',PARTIAL:'部分完成',BLOCKED:'受阻',NEEDS_INPUT:'等待补充',FAILED:'失败',CANCELLED:'已停止',REFUSED:'已拒绝',running:'执行中',pending:'待执行',waiting:'等待结果',blocked:'受阻',failed:'失败',cancelled:'已停止',needs_input:'等待输入',passed:'通过',accepted:'已接受',approved:'已批准',not_required:'无需确认',unknown:'未知',unrecorded:'未记录',not_checked:'尚未检查',returned:'已返回',submitted:'已提交',selected:'已选择',loaded:'已加载',executed:'已执行',verified:'已验证',MISSING_EXECUTION_EVIDENCE:'缺少执行证据',MODEL:'模型调用','USER INPUT':'用户请求',START:'请求受理',INTENT:'需求理解结果',INTENT_ERROR:'需求识别失败',TASK_STATE:'任务状态更新',EXECUTION_PLAN:'执行计划',PLAN_PROGRESS:'步骤进度',FINAL:'返回用户',TOOL_START:'工具开始',TOOL_RESULT:'工具返回','MODEL DRAFT':'模型草稿','ACCEPTED CONTRACT':'已接受合同','TASK STATE':'任务快照','VALIDATION understand':'请求合同校验',generate_document_or_media_plan:'文字或媒体方案校验'};
export const label=x=>words[x]||String(x??'未记录');
Object.assign(words,{PENDING:'待执行',prepared:'参数已准备',available:'可用',unavailable:'不可用',allow:'允许',refuse:'拒绝',artifact_verification:'产物验收',image_creation_skill:'图片生成方法',image_editing_skill:'图片编辑方法',video_creation_skill:'视频生成方法',schema_and_binding:'结构与引用绑定检查',accepted_artifact:'合格产物记录',revision_bound_approval:'绑定版本的批准',delivery:'交付义务',authorization:'执行授权',not_evaluated:'尚未评估'});
export const fieldLabels={summary:'需求摘要',description:'目标说明',kind:'类型',operation:'执行操作',action:'请求动作',output:'输出',form:'内容形式',count:'内容数量',artifactCount:'交付数量',contentCardinality:'内部内容数量',title:'标题',name:'名称',content:'正文',text:'文字',prompt:'提示词',negativePrompt:'排除内容',ratio:'画幅比例',size:'图像尺寸',duration:'时长',durationSeconds:'时长（秒）',spec:'规格要求',constraints:'约束',globalConstraints:'全局约束',facts:'事实依据',assumptions:'假设',gaps:'缺失信息',deferred:'暂不执行',requiredMethods:'要求使用的 Skill',methods:'方法执行记录',references:'引用对象',source:'来源',sourceSelection:'来源选择',status:'状态',reason:'原因',error:'错误',issues:'问题',accepted:'是否接受',passed:'是否通过',approval:'确认授权',required:'是否需要',revision:'任务版本',version:'版本',from:'之前',to:'之后',field:'字段',changes:'修改内容',preserve:'保持不变',revisionDelta:'修订增量',executionMode:'执行模式',turnOperation:'本轮操作',continuation:'多轮处理',mode:'方式',query:'查询内容',deliverables:'交付目标',safety:'安全判断',disposition:'处理决定',dependsOn:'依赖步骤',outputContract:'输出合同',input:'输入',result:'结果',arguments:'输入参数',parameters:'参数合同',tools:'可用工具',tool:'工具',skillId:'Skill 方法',slug:'Skill 名称',validation:'校验',technical:'技术检查',semantic:'内容检查',business:'任务验收',mediaQuality:'媒体质量',checks:'检查项',sourceTrusted:'来源可信',topicMatched:'主题匹配',queryResolved:'引用已解析',answerCovered:'回答覆盖查询',completionAllowed:'允许完成',availability:'可用性',modelIdentity:'模型身份',configuredModel:'配置模型',provider:'供应商',underlyingVersion:'底层版本',observedAt:'观察时间',sourceHash:'来源指纹',planHash:'方案指纹',contractHash:'合同指纹',targetRevision:'目标版本',targetVersion:'目标版本',evidence:'证据',expected:'要求',actual:'实际',requirementCoverage:'逐项覆盖',coverageProgress:'覆盖进度',covered:'已覆盖内容',unitIds:'来源单元',items:'子目标',payload:'保存的执行参数',actions:'可执行动作',canResume:'可以继续',canCancel:'可以取消',transitions:'状态流转',at:'时间',artifactReferences:'已有产物引用',newArtifacts:'新增产物数',readReceipt:'读取回执',model:'模型',messages:'消息',role:'角色',system:'系统指令',user:'用户输入',assistant:'模型输出',url:'素材地址',image_url:'图片地址',type:'类型',contentHash:'内容指纹',contractValidated:'方法合同已校验',verification:'验收',publication:'发布状态',procedure:'流程验收',quality:'内容质量',scope:'范围',intent:'意图',constraintsApplied:'应用的约束'};
export const fieldLabel=k=>fieldLabels[k]||k;
Object.assign(fieldLabels,{businessAction:'业务动作合同',businessActions:'业务动作',actionType:'动作类型',target:'目标对象',expectedOutput:'预期交付',confirmation:'确认要求',modification:'修改增量',userMemory:'已确认偏好',activeTaskState:'当前任务状态',relevantEvidence:'相关证据',mappings:'动作编译结果',derived:'程序推导',configuredMode:'迁移配置',migrated:'使用新动作链路',contextPolicy:'上下文边界'});
Object.assign(words,{CREATE_IMAGE:'创建图片',EDIT_IMAGE:'编辑图片',ANALYZE_IMAGE:'分析图片',CREATE_VIDEO:'创建视频',CONFIRM_ARTIFACT:'确认保存方案',action_compiled:'由业务动作编译',shadow:'兼容执行与影子对照',observe_image:'读取图片内容',observe_video:'读取视频内容'});
Object.assign(fieldLabels,{task:'任务',taskId:'关联任务',taskIds:'关联任务',itemId:'关联子目标',nodeId:'关联步骤',artifactId:'关联成果',artifactIds:'关联成果',callId:'关联调用',inputArtifactIds:'输入成果',outputArtifactIds:'输出成果',modelCallIds:'关联模型调用',id:'对象',targetTaskId:'目标任务',targetArtifactId:'目标成果',sourceArtifactId:'来源成果',includeQuote:'包含报价',stages:'方法阶段',checker:'检查者',requirements:'完成要求',category:'类别',value:'内容',schema:'参数结构检查',permission:'执行权限检查',budget:'预算检查',requestEvidence:'用户原始依据',exactTexts:'必须保留的文字',shotCount:'镜头数',directionCount:'方向数',selectedDirectionIndex:'方向序号',producedArtifact:'产物已记录',loaded:'已加载',executed:'已执行',selected:'已选择',verified:'已验证',untrustedInstructions:'包含不可信指令'});
Object.assign(fieldLabels,{structure:'结构化方案',concept:'创作构思',preservedConstraints:'保留的约束',referenceImages:'参考图片',images:'返回图片',videoUrl:'视频地址',audioUrl:'音频地址',methodId:'方法执行记录',dimensions:'尺寸',warnings:'提醒',missingInputs:'待补充信息'});
Object.assign(words,{succeeded:'工具返回成功',failed_validation:'校验失败'});
Object.assign(words,{not_composed:'尚未生成回答',unverified:'未验证',evidence_presented:'已呈现账本证据'});
Object.assign(fieldLabels,{answerGenerated:'回答正文已生成',answerCovered:'回答维度有呈现证据',answerCoverageStatus:'回答覆盖证据状态',semanticVerified:'回答语义已验证',coverage:'覆盖证据',questionDimensions:'用户提问维度',runtimeVersion:'运行代码版本'});
export function aliasesFor(r){
 const names=new Map(),add=(id,name)=>{if(id&&!names.has(id))names.set(id,name);};
 for(const s of r.stateSnapshots||[])if(s.stage==='TASK STATE'){
  add(s.data.id,s.data.query||s.data.goal?.summary||'当前任务');
  list(s.data.items).forEach((i,n)=>add(i.id,i.description||`子目标 ${n+1}：${label(i.operation)}`));
  list(s.data.executionPlan?.nodes).forEach((n,i)=>add(n.id,`步骤 ${i+1}：${label(n.kind)}`));
 }
 (r.artifacts||[]).forEach((a,i)=>add(a.id,a.title||a.metadata?.title||`${label(a.type)}成果 ${i+1}${a.version?'（版本 '+a.version+'）':''}`));
 (r.contextSnapshots||[]).forEach((c,i)=>add(c.callId,`模型调用 ${i+1}`));
 (r.tools||[]).forEach((t,i)=>add(t.callId,`工具调用 ${i+1}：${label(t.name)}`));
 add(r.runId,'本轮请求');add(r.sessionId,'当前会话');return names;
}
export function displayValue(v,names=new Map()){
 if(v===null||v===undefined)return '未记录';if(v===true)return '是';if(v===false)return '否';
 if(typeof v==='object')return JSON.stringify(v);
 if(names.has(String(v)))return names.get(String(v));
 if(/^(?:[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{64}|exec_[a-f0-9-]+)$/.test(String(v)))return '对象引用或指纹（见原始记录）';
 return label(v).replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?::[\w-]+)?/g,id=>{if(names.has(id))return names.get(id);const [base,suffix]=id.split(':');return (names.get(base)||'已保存对象')+(suffix?' · '+label(suffix):'');});
}
export function modelMessages(c){
 const a=c.actualRequest;const actualInput=a?.input??a?.messages;
 const input=actualInput??c.preTransportInput;
 const messages=typeof input==='string'?[{role:'user',content:input}]:Array.isArray(input)?input:input==null?[]:[{content:input}];
 return {source:actualInput!=null?'供应商实际请求':'传输前输入（未记录实际请求）',messages:a?.instructions?[{role:'system',content:a.instructions},...messages]:messages};
}
export function selectedCalls(c){
 const out=list(c.output),calls=out.filter(o=>o.type==='function_call').map(o=>({id:o.call_id,name:o.name,args:o.arguments}));
 for(const o of out)for(const t of o.tool_calls||[])calls.push({id:t.id,name:t.function?.name,args:t.function?.arguments});return calls;
}
export function describeRun(r){
 const accepted=r.intent?.acceptedContract,decision=r.intent?.decision,operation=accepted?.turnOperation;
 const tasks=(r.stateSnapshots||[]).filter(s=>s.stage==='TASK STATE');
 const snapshots=tasks.map(s=>s.data),lastByTask=new Map(snapshots.map(t=>[t.id,t]));
 const observedPlans=[...tasks.map(s=>({at:s.at,plan:s.data.executionPlan})),...(r.plan?.events||[]).map(e=>({at:e.occurredAt,plan:e.plan}))].filter(x=>x.plan);
 observedPlans.sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0));
 const latestPlan=observedPlans.at(-1)?.plan||(r.plan?.snapshots||[]).map(s=>s.executionPlan).filter(Boolean).at(-1);
 const nodes=list(latestPlan?.nodes);
 const ops=decision?.operations||[],explicit=r.timeline?.find(t=>t.phase==='USER INPUT')?.data?.explicitTarget;
 const approvalOp=ops.find(o=>o.operation==='approve'),resumeOp=ops.find(o=>o.operation==='resume');
 let route='尚无足够执行证据';
 if(r.delivery?.queryReceipt)route='理解请求 → 读取已有事实 → 程序检查查询证据 → 返回答案';
 else if(explicit)route=(approvalOp?'显式确认入口':'显式续跑入口')+' → 读取保存任务'+(snapshots.some(t=>t.approval?.status==='approved')?' → 批准已记录':' → 批准结果待核对')+((r.contextSnapshots||[]).length||r.tools?.length?' → 后续调用已记录':'')+(r.finalResponse?.source==='recorded_final_event'?' → 返回本轮状态':'');
 else if(!accepted)route=(r.contextSnapshots||[]).length?'理解请求 → 合同尚未接受':'请求进入 → 等待理解记录（尚无足够执行证据）';
 else if(nodes.length)route='理解请求 → 接受合同 → 执行计划已记录'+(r.tools?.length?' → 工具执行已记录':'')+(r.finalResponse?.source==='recorded_final_event'?' → 返回本轮状态':' → 跟随节点进度');
 else if(r.tools?.length)route='理解请求 → 接受合同 → 调用工具 → 返回本轮状态';
 else if(r.finalResponse?.source==='recorded_final_event')route='理解请求 → 接受合同 → 返回（中间计划未记录）';
 const subgoals=[...lastByTask.values()].flatMap(t=>list(t.items).map((i,index)=>({
  ...i,title:i.description||`子目标 ${index+1}：${label(i.operation)}`,
  history:tasks.filter(s=>s.data.id===t.id).flatMap(s=>list(s.data.items).filter(x=>x.id===i.id).map(x=>({at:s.at,status:x.status,coverage:x.requirementCoverage||x.coverageProgress||null,artifactCount:list(x.artifactIds).length}))),
  coverage:(r.requirementCoverage||[]).filter(c=>c.itemId===i.id)
 })));
 if(!subgoals.length)for(const [n,d] of (accepted?.deliverables||[]).entries())subgoals.push({...d,title:d.description||`交付目标 ${n+1}`,status:'unrecorded',history:[],coverage:[]});
 const confirmation={entry:explicit?(approvalOp?'显式方案确认 / 按钮续跑入口':'显式任务续跑入口'):(approvalOp||accepted?.continuation?.mode==='approve'?'文字确认（经过需求理解）':'本轮没有已记录的确认动作'),operation:approvalOp||resumeOp||null,
  before:(r.previousTurn?.taskSnapshots||[]).filter(s=>s.task?.id===(approvalOp?.targetTaskId||resumeOp?.targetTaskId||explicit)).map(s=>s.task.approval).at(-1)??null,
  history:tasks.map(s=>({task:s.data.query||'当前任务',at:s.at,revision:s.data.revision,status:s.data.status,approval:s.data.approval})),
  intakeCalls:(r.contextSnapshots||[]).filter(c=>c.phase==='understand').length,
  note:'入口名称来自显式目标和保存决策，不能仅凭用户文字猜测点击。HTTP 层在进入 Agent 前拒绝的请求没有 Run，旧 Trace 不能显示其完整经过。'};
 return {summary:accepted?.summary||r.intent?.candidates?.at(-1)?.parsedRawOutput?.summary||(explicit?'本轮通过显式目标恢复保存任务，不重新理解一条创作需求。':'尚未记录可靠的需求理解'),accepted:!!accepted,operation:operation?.kind,route,nodes,subgoals,confirmation,compiled:snapshots.some(t=>t.protocol==='compiled-v1')};
}

const array=v=>Array.isArray(v)?v:[];
export function cleanDisplay(value){
 if(Array.isArray(value))return value.map(cleanDisplay);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['annotations','logprobs'].includes(k)).map(([k,v])=>[k,cleanDisplay(v)]));
 return value;
}
export function structuredModelOutput(output){
 const blocks=array(output).flatMap(o=>o.type==='message'?array(o.content):[o]);
 return blocks.map(b=>{
  if(typeof b.text!=='string')return {format:b.type||'object',value:cleanDisplay(b)};
  try{return {format:'json',value:JSON.parse(b.text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''))};}
  catch{return {format:'text',value:b.text,parseNote:'不是合法 JSON；保留原文，未丢弃或默认成功'};}
 });
}
export function modelStage(call){
 const phases=array(call.validations).map(v=>v.phase),p=call.tracePhase;
 const phase=p||phases.find(x=>x?.startsWith('verify_'))|| (phases.includes('understand')?'understand':phases.includes('generate_document_or_media_plan')?(call.methodId?.includes('creation_skill')?'media_plan':'text_generation'):'unrecorded');
 const titles={observe_image:'读取图片内容',observe_video:'读取视频内容',final_response:'组织最终回答（只读解释）',understand:'需求理解',select_capabilities:'能力选择',text_generation:'生成文字',media_plan:'编写媒体工具参数',verify_text:'验收文字',verify_media:'验收图片或视频',verify_edit:'验收修改结果',verify_plan:'校验工具参数',unrecorded:'阶段缺少证据'};
 const attempt=call.attempt??array(call.validations).find(v=>Number.isInteger(v.attempt))?.attempt;
 return {phase,title:titles[phase]||phase,attempt:attempt??null,evidence:p?'runtime_stage':'recorded_validation',repair:attempt>0};
}

Object.assign(fieldLabels,{draftIntentSnapshot:'未接受草稿快照',executionReceipt:'执行交付回执',contractAccepted:'合同已接受',failureStage:'首次失败阶段',activation:'阶段条件',timing:'执行时机',condition:'等待条件',executionAuthorization:'当前媒体权限',affectedDeliverables:'受影响交付项',requestEvidenceSpans:'用户原文位置',evidenceSegments:'分段原文证据',speakerRole:'用户身份',targetAudience:'目标受众',countDeclared:'明确声明内容数量',currentMessageId:'本轮用户消息',continuationEvidence:'续接指令证据'});
Object.assign(words,{intent_draft:'未接受的理解草稿',draft_reinterpretation:'纠正未接受草稿',intent_snapshot:'已接受合同快照',after_user_input:'等待用户输入',saved_artifact_projection:'呈现已保存成果',unaccepted_draft:'未接受草稿'});
