export const toolNames={list_assets:'查找素材',read_asset:'读取素材',read_skill:'读取创作方法',read_history:'读取历史原文',search_history:'检索历史',inspect_workspace:'查看工作区',read_approval:'读取已保存方案',analyze_image:'观察图片',compare_images:'对比原图与成品',read_media_result:'查询媒体回执',save_document:'保存文稿',generate_image:'准备图片方案',edit_image:'准备图片修改',generate_video:'准备视频方案',confirm_media:'确认并提交媒体',execute_approved:'执行已批准方案',request_user_input:'向用户提问',measure_text:'检查文字要求'};
export const eventNames={start:'接收用户请求',end:'本轮运行结束',summary_attempt:'开始整理会话记忆',summary_failed:'会话记忆整理失败',tool_batch_policy:'系统选择工具执行方式',model_request:'模型决策请求',model_response:'模型返回',model_error:'模型调用失败',delivery_check:'检查交付要求',confirm_media:'处理媒体确认',proposal_published:'方案已展示，等待批准',proposal_client_rendered:'页面已显示方案',legacy_import:'载入旧版历史'};
export const plain=value=>typeof value==='string'?value:Array.isArray(value)?value.map(p=>p.text||'').join('\n'):'';
export const excerpt=(text,n=150)=>{const s=plain(text).replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;};
export function debugLabels(state){
 const labels={},turns=new Map(),calls=new Map(state.records.filter(r=>r.kind==='tool_call').map(r=>[r.callId,r.name]));let n=0;
 for(const r of state.records){if(r.turnId&&!turns.has(r.turnId))turns.set(r.turnId,++n);const prefix=r.turnId?'第'+turns.get(r.turnId)+'轮 · ':'';
  labels[r.id]=prefix+(r.kind==='message'?(r.role==='user'?'用户原话':'Agent文字')+'：'+excerpt(r.content,65):r.kind==='tool_call'?(toolNames[r.name]||'工具')+'请求':r.kind==='tool_result'?(toolNames[calls.get(r.callId)]||'工具')+'的执行反馈':eventNames[r.event||r.name]||'系统记录');
 }
 for(const a of Object.values(state.assets||{}))labels[a.id]=(a.title||a.name||({image:'图片素材',text:'文字素材',video:'视频素材'}[a.type]||'素材'))+(a.version?' · 第'+a.version+'版':'');
 for(const p of Object.values(state.approvals||{}))if(p.proposalId)labels[p.proposalId]=(toolNames[p.name]||'媒体')+' · 已保存方案';
 return labels;
}
export function readable(text,labels){
 let s=plain(text);if(labels[s])return labels[s];
 for(const [id,label]of Object.entries(labels))if(id.length>8&&s.includes(id))s=s.split(id).join('「'+label+'」');
 return s.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'（内部引用）').replace(/\b[0-9a-f]{32,64}\b/gi,'（内部标识）');
}
