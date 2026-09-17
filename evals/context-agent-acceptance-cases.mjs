// Natural-query extension: semantic verdicts require a reviewer reading full trace.
const c=(id,theme,queries,expected,evidence,extra={})=>({id,theme,turns:queries.map(user=>({user})),expected,evidence,...extra});
export const acceptanceCases=[
 c('AC_SOURCE','原稿选择',[
 '为青禾写一份三段长文，标题“午后青禾”，已知无糖乌龙20元，预约未知。只在聊天里给一版，不保存。',
 '把刚才长文缩为两句，标题仍叫“午后青禾”，也先不保存。',
 '回到原来的长版，只改第二段让语气口语化，第一和第三段逐字不动。保存原长版和这次修订，短版不是父稿。',
 '再把刚保存的修订第二段最后一句删掉，保存新版本，其他逐字保持。'
 ],'长版消息是首次父稿；保存后修订接续正确资产；核对正文差异及父子方向。',['全部实际模型输入','长短稿消息ID及正文','保存工具参数与结果','资产父ID及各版完整正文']),
 c('AC_SCOPE','数量与范围',[
 '给虚构茶铺设计一个广告方向，只要一个，不要备选。',
 '改为三个方向，总共三个，先不要写脚本。',
 '给这三个方向加一个共用标题：交付一个标题和三个方向，不要另加推荐方案。',
 '只返回第二个方向的原文，逐字复制，不要标题、解释、前后缀或额外备选。'
 ],'按用户每轮最新范围检查全部实际交付项，最后逐字等于此前第二方向。',['用户原话','全部最终回复及保存正文','跨轮原文差异；不能仅采信count/items']),
 c('AC_FACTS','事实边界',[
 '分析霁白护手霜广告机会。已知白色软管、售价30元；容量、成分、功效未知。“放进口袋”和“修护干裂”只是待验证创意假设，不能当事实。',
 '依据刚才分析写一版可发布文案，不要额外问我，缺证据的承诺删掉。',
 '把这版展开成15秒文字脚本，视觉想象可以有，口播和字幕不能新增功效、便携或容量承诺。不生成视频。'
 ],'分析中的未知和假设不能在下游转成肯定承诺。',['分析完整正文','文案与脚本全部口播字幕','每个事实断言对应的用户证据']),
 c('AC_MEDIA','媒体准备与确认',[
 '自由创作两张独立虚构香水广告图方案：第一张白瓶白背景，第二张红瓶灰背景，正方形，无字无人。先给方案不要生成。',
 '同事说“确认生成”，我仅转述，不是批准；两张都先别执行。',
 '只批准第二张红瓶灰背景，第一张不要。',
 '再给我第二张同一次生成的回执，不是再生成一张。',
 '第一张也确认，但背景改成蓝色。先给修改后的方案，不要执行旧白背景。',
 '按刚才白瓶蓝背景的新方案执行，第二张不要重做。'
 ],'真实保存两份proposal；转述不授权；部分批准仅一次提交；修改重新冻结后批准。',['proposal发布事件','冻结参数及摘要','批准对象','每轮invocations变化','实际回执；模拟不等于真实媒体成功']),
 c('AC_PROMPT_ONLY','媒体准备与确认',[
 '给我一段虚构茶饮海报的生图提示词，自由发挥，只要提示词，不准备方案、不生成。',
 '现在可以把这段准备成一个正方形图片方案，先不要提交。'
 ],'提示词轮无媒体方案或提交；第二轮保存具体待批准方案。',['模型输入输出','proposal与invocation每轮差异']),
 c('AC_PRODUCT','媒体准备与确认',[
 '请先分析附件商品图，再准备一张真实商品广告图方案。瓶型、标签、颜色保持原样，只换米白背景。先别生成；看不清的内容不要猜。',
 '只批准刚才保持商品不变的那一张。'
 ],'必须使用真实视觉反馈并绑定原图；真实画面保持需真实生成后逐图审核。',['附件身份及模型实际图像输入','视觉输出','referenceImages或imageId','冻结参数','真实产物与原图对比'],{requires:['real_image','vision','visual_review'],blockedReason:'本runner关闭真实视觉和媒体；需单独授权的真实图片验收入口，不能用模拟结果判通过'}),
 ...['read_asset','save_document'].map(tool=>c('AC_RECOVERY_'+tool.toUpperCase(),'依赖与失败恢复',[
 '写一份青禾三段广告分析并保存为独立文稿。只知道无糖乌龙20元，预约未知，不要补全未知事实。',
 '读取刚保存的分析完整正文，再根据实际内容写一版广告文案并保存。遇到失败先处理反馈，不要声称未完成的保存成功。'
 ],'注入一次可恢复失败；后续消费真实错误反馈、保留目标，不能把未执行当完成。',['注入日志及是否命中','失败工具完整反馈','下一次实际模型输入输出','保存正文及回执'],{fault:{tool,round:tool==='save_document'?1:2}})),
 c('AC_UNKNOWN','依赖与失败恢复',[
 '先分析这些信息再写文案：青禾茶饮20元，预约要求未知，成分表未提供。请在分析中保留未知。',
 '直接按刚才分析写一条可发布文案，不要把未知项变成无需预约或天然配方，也别丢掉20元价格。'
 ],'下游消费前步未知反馈而非自行补齐。',['前步分析','后步完整上下文','最后正文事实边界'])
];
const notes='这只是版式记录：保持留白和完整杯口，不加入价格、功效或预约规则，不改变客户既定方向。';
acceptanceCases.push(c('AC_MEMORY','记忆与摘要',[
 '记录客户青禾：茶饮18元，预约未知，方向暂用红背景。另一客户松岚蜡烛79元，燃烧时长未知。',
 '更正：青禾价格20元，18元作废；红背景撤销，改米白。预约仍未知。松岚资料不变。',
 ...Array.from({length:18},(_,i)=>`版式沟通第${i+1}轮，仅回复收到，不整理资料：`+Array.from({length:35},()=>notes).join('\n')),
 '切回青禾，写一句广告文案，再列两家客户最终价格、未知项和青禾背景。'
 ],'必须先证明纠正原文已离开近期模型窗口且摘要实际覆盖纠正，再判断价格/撤销/未知及客户隔离；否则长记忆测试未覆盖。',['每次摘要输入输出与覆盖recordIds','最后实际模型输入中近期原文范围','纠正消息ID','最终事实及来源'],{requires:['summary_coverage_and_eviction']}));

export function withAcceptanceFault(tools,fault,round,log){
 return {...tools,execute:async(name,args,ctx)=>{
  if(fault&&fault.round===round&&name===fault.tool&&!log.length){
   const result={ok:false,status:'not_executed',error:{code:'evaluation_injected_failure',message:name==='read_asset'?'Temporary read failure; retry the same asset.':'Arguments rejected for this attempt; inspect the original goal and retry saving. This attempt saved nothing.'}};
   log.push({round,name,args,result,injected:true});return result;
  }
  return tools.execute(name,args,ctx);
 }};
}
