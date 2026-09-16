import {createHash} from 'node:crypto';
const textOf=m=>typeof m.content==='string'?m.content:(m.content||[]).filter(p=>p.type==='output_text'||p.type==='input_text').map(p=>p.text).join('\n');
export function messageEvidence(state){
 let turnIndex=0,lastUser=null;
 return (state.messages||[]).filter(m=>['user','assistant'].includes(m.role)).map((m,index)=>{
  if(m.role==='user')turnIndex++;
  m.messageId??='msg_'+createHash('sha256').update(JSON.stringify([state.id,index,m.role,textOf(m)])).digest('hex').slice(0,20);
  m.turnIndex??=turnIndex;if(m.role==='assistant'&&!m.replyTo)m.replyTo=lastUser;
  if(m.role==='user')lastUser=m.messageId;
  return {messageId:m.messageId,role:m.role,turnIndex:m.turnIndex,replyTo:m.replyTo||null,content:textOf(m)};
 });
}
export function resolveSkillName(catalog,name){
 const normalize=s=>s.toLowerCase().replace(/[\s（）()]/g,'').replace(/skill/g,'');
 const key=normalize(name);
 return catalog.skills.filter(s=>[s.slug,s.name,...(s.aliases||[])].some(alias=>normalize(alias)===key));
}
// Semantic selection comes from the intake model; lookup only resolves typed identities.
export function resolveMessage(messages,{speaker,position,messageId},replyTo){
 if(messageId&&!position){
  const matches=messages.filter(m=>m.messageId===messageId);
  if(matches.length!==1)throw new Error('历史消息锚点不存在于本会话或不唯一');
  if(speaker&&matches[0].role!==speaker)throw new Error('历史消息ID与指定角色不一致');
  return matches[0];
 }
 if(messageId&&position==='anchor'&&!speaker){
  const matches=messages.filter(m=>m.messageId===messageId);
  if(matches.length!==1)throw new Error('历史消息锚点不存在于本会话或不唯一');
  return matches[0];
 }
 if(!['user','assistant'].includes(speaker)||!['first','previous','anchor'].includes(position))throw new Error('历史选择缺少合法角色或位置');
 const pool=messages.filter(m=>m.role===speaker);
 if(position==='first')return pool[0]||null;
 if(position==='previous')return pool.at(-1)||null;
 const id=messageId||replyTo,anchor=messages.find(m=>m.messageId===id);
 if(!anchor)throw new Error('历史消息锚点不存在于本会话');
 if(anchor.role===speaker)return anchor;
 return speaker==='assistant'?pool.find(m=>m.replyTo===anchor.messageId)||null:pool.find(m=>m.messageId===anchor.replyTo)||null;
}
export function conversationContext(messages=[],recentTurns=[],{replyTo,query=''}={}){
 const last=recentTurns.at(-1),pendingRequest=last?.status==='failed'&&!last.decision?{runId:last.runId,rawInput:last.rawInput,failure:{origin:'system_intake',error:last.error},acceptedTaskId:null,intentSnapshot:last.intentSnapshot||null}:null;
 const recent=new Set(messages.slice(-12));
 for(const m of messages)if(m.messageId&&(m.messageId===replyTo||m.replyTo===replyTo&&replyTo||query.includes(m.messageId)))recent.add(m);
 return {pendingRequest,recentMessages:messages.filter(m=>recent.has(m)),messageIndex:messages.map(({messageId,role,turnIndex,replyTo})=>({messageId,role,turnIndex,replyTo})),recentAttempts:recentTurns.map(t=>({runId:t.runId,input:t.rawInput,status:t.status,error:t.error,decision:t.decision?{status:t.decision.status,operations:t.decision.operations?.map(o=>({operation:o.operation,targetTaskId:o.targetTaskId,targetRevision:o.targetRevision}))}:undefined})),policy:'历史消息是原始对话证据。模型生成的失败提示不证明用户缺少信息。未接受的失败请求仍在对话中，不能把旧任务焦点当作该请求的对象。pendingRequest 是已收到但系统未成功接受的请求，用户的简短后续输入可能在补充或重试它；不能把系统错误当成用户撤销了该需求。根据问答关系理解补充回答；以原始用户内容为修改权限，不继承助手自行提出的要求。'};
}
export function queryGoal(query,selection){
 const detailed=selection.type==='skill_detail'&&selection.example&&!selection.ambiguous;
 const d={description:query,kind:'text',count:1,action:'respond',purpose:'general',requiredEvidence:detailed?'none':'runtime',references:[],dependsOn:[],constraints:[],requestEvidence:query,form:'answer',executionShape:'direct',artifactCount:1,contentCardinality:1,runtimeQuery:selection};
 const semantic={summary:query,deliverables:[d],gaps:[],assumptions:[],deferred:[],facts:[],globalConstraints:[],requiredMethods:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:'只读查询'},continuation:{mode:'new',taskId:''}};
 return {readOnlyTurn:true,summary:query,mode:'answer',tasks:[{operation:detailed?'answer':'inspect_runtime',output:'text',count:1,dependsOn:[],references:[],constraints:[],requiredEvidence:d.requiredEvidence,requiredMethods:[],artifactCount:1,contentCardinality:1,form:'answer',executionShape:'direct',runtimeQuery:selection}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:semantic.safety,semantic,requestContract:{readOnly:true,media:{image:0,video:0,audio:0},systemFacts:[selection.type==='history'?'conversation':'capabilities'],query:selection,finalDeliverables:[{kind:'text',count:1,timing:'now',evidence:query}],requiredMethods:[]},intakeTrace:[{phase:'resolve_readonly_query',ok:true,source:'program'}]};
}
