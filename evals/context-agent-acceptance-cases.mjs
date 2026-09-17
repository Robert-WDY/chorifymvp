// Natural-query extension: semantic verdicts require a reviewer reading full trace.
const c=(id,theme,queries,expected,evidence,extra={})=>({id,theme,turns:queries.map(user=>({user})),expected,evidence,...extra});
export const acceptanceCases=[
 c('AC_SOURCE','原稿选择',[
 '我们青禾茶铺要推一款无糖乌龙，20元一杯。帮我写篇三段的推文，标题就叫“午后青禾”，先发这里看看。',
 '把刚才长文缩为两句，标题仍叫“午后青禾”，也先不保存。',
 '还是原来的长版好，第二段改得像店员平时说话，其他两段别动。改完帮我存一下，原来的长版也留着。',
 '再把刚保存的修订第二段最后一句删掉，保存新版本，其他逐字保持。'
 ],'长版消息是首次父稿；保存后修订接续正确资产；核对正文差异及父子方向。',['全部实际模型输入','长短稿消息ID及正文','保存工具参数与结果','资产父ID及各版完整正文']),
 c('AC_SCOPE','数量与范围',[
 '我们茶铺想做个广告，你先想一个方向给我看看。',
 '还是给我三个方向对比一下吧，脚本先不急。',
 '我要把这三个方向发给老板看。帮我整理成一条消息，开头加个标题，下面就放刚才那三个方向。',
 '第二个单独发我一下，原文就行，我直接复制。'
 ],'按用户每轮最新范围检查全部实际交付项；整理消息为一个总标题和原有三个方向，不新增备选或改写方向；最后逐字等于此前第二方向。',['用户原话','全部最终回复及保存正文','跨轮原文差异；不能仅采信count/items']),
 c('AC_FACTS','事实边界',[
 '接了个霁白护手霜的广告，白色软管，卖30元。客户的详细资料还没发。我想到拍出门装进衣兜的场景，也想过往修护干裂上说，不过这个效果还得问客户。你先帮我分析一下怎么做。',
 '那你先按现在这些资料写一版文案，我发给客户看看。',
 '把这版展开成15秒广告脚本，画面、口播和字幕都写上，先看文字。'
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
 '青禾茶铺准备推无糖乌龙，20元一杯。帮我从三个方面分析一下广告怎么做，写好存成文档。',
 '你把刚才存的分析打开看看，照着里面的思路写一版广告文案，也帮我存好。'
 ],'注入一次可恢复失败；后续消费真实错误反馈、保留目标，不能把未执行当完成。',['注入日志及是否命中','失败工具完整反馈','下一次实际模型输入输出','保存正文及回执'],{fault:{tool,round:tool==='save_document'?1:2}})),
 c('AC_UNKNOWN','依赖与失败恢复',[
 '青禾周末要做新品试饮，茶饮卖20元。要不要提前报名，店长还没定，配料表也还没发我。你先帮我看看宣传可以怎么写。',
 '就按你刚才的思路写一条朋友圈吧，把价格带上。'
 ],'下游消费前步未知反馈而非自行补齐；没有报名结论或配料证据，不能承诺无需预约或天然配方；保留20元。',['前步分析','后步完整上下文','最后正文事实边界'])
];
const notes='这只是版式记录：保持留白和完整杯口，不加入价格、功效或预约规则，不改变客户既定方向。';
acceptanceCases.push(c('AC_MEMORY','记忆与摘要',[
 '我手上有两个客户：青禾推茶饮，18元，海报先用红底，试饮要不要预约还在商量；松岚做香氛蜡烛，79元一款，能烧多久客户还没回复。你先记一下。',
 '青禾刚来消息，价格是20元，我之前记错了。红底也不做了，换米白。预约的事还没定，松岚那边暂时没新消息。',
 ...Array.from({length:18},(_,i)=>`版式沟通第${i+1}轮，仅回复收到，不整理资料：`+Array.from({length:35},()=>notes).join('\n')),
 '回到青禾，帮我写一句广告文案。另外把这两家现在的价格、还等客户回复的事，以及青禾海报用什么底色整理一下，我核对下。'
 ],'必须先证明纠正原文已离开近期模型窗口且摘要实际覆盖纠正，再判断价格/撤销/未知及客户隔离；否则长记忆测试未覆盖。',['每次摘要输入输出与覆盖recordIds','最后实际模型输入中近期原文范围','纠正消息ID','最终事实及来源'],{requires:['summary_coverage_and_eviction']}));


// Primary category describes the user journey; theme remains a cross-cutting review tag.
export const acceptanceCategories={
 new_text:'新对话文字回答query',
 multi_text:'多轮对话文字回答query',
 new_image:'新对话图片生成和分析',
 multi_image:'多轮对话的图片生成和分析',
 multi_image_reference:'多轮对话的图片引用',
 new_text_image:'新对话文字回答加图片生成',
 multi_text_image_reference:'多轮对话文字回答加图片生成加素材引用'
};
const imageBlock={requires:['real_image','vision','visual_review'],blockedReason:'此案例需要有效原图和真实视觉/媒体能力；当前simulation runner不具备，保持not_run。'};
acceptanceCases.push(
 c('AC_NEW_COPY','数量与范围',[
 '青禾新出了桂花乌龙，无糖，20元一杯。帮我写条朋友圈，轻松一点，别太长。'
 ],'新会话直接交付一条文字；不擅自增加图片任务或编造卖点。',['首轮完整模型输入输出','实际正文及全部工具调用'],{category:'new_text'}),
 c('AC_NEW_ANALYSIS','事实边界',[
 '霁白护手霜卖30元，白色软管，客户详细资料还没发。你觉得广告可以从哪些角度想？'
 ],'以有限资料给出创意分析；建议不变成已验证产品功效。',['首轮实际模型输入输出','事实和创意建议对应关系'],{category:'new_text'}),
 c('AC_NEW_IMAGE','媒体准备与确认',[
 '帮我做一张咖啡店海报图，白色咖啡杯放在窗边，有下午的阳光，竖版，不要文字。'
 ],'新会话理解生图请求并准备具体待批准方案；无需已有对话；未批准不能提交。',['首轮模型输入及工具反馈','proposal参数和提交记录'],{category:'new_image'}),
 c('AC_NEW_IMAGE_ANALYSIS','事实边界',[
 '帮我看看这张商品图，拿来做电商主图合适吗，哪里可以改？'
 ],'对实际附件做视觉分析；明确观察依据，不以文件名推测画面。',['附件身份和实际视觉请求','视觉反馈与最终分析'],{category:'new_image',...imageBlock,fixtures:['product_a.png']}),
 c('AC_IMAGE_REFERENCE','原稿选择',[
 '这两张商品图你先帮我看看，哪张更适合做首页横幅？',
 '还是用我传的第一张，把背景换成米白，商品别动，先给我看看方案。',
 '就按这个来。',
 '刚才改的那张背景再亮一点，商品保持原来的样子。'
 ],'第一张指上传顺序，不是模型推荐顺序；后续编辑引用实际生成版本；无生成产物时不能假造父图。',['两张附件ID及顺序','视觉请求反馈','每轮imageId/referenceImages与父子关系','批准参数及真实产物'],{category:'multi_image_reference',...imageBlock,fixtures:['product_a.png','source_image.png']}),
 c('AC_NEW_TEXT_IMAGE','数量与范围',[
 '我们青禾茶铺上新桂花乌龙，无糖，20元一杯。帮我写条朋友圈，再配一张清爽一点的方形海报图。'
 ],'同时交付文字并准备图片方案，不遗漏任一交付；首轮未批准不提交。',['完整文字交付','图片proposal参数及提交记录'],{category:'new_text_image'}),
 c('AC_MULTI_MIXED','原稿选择',[
 '这是我们新品的资料和两张商品图。先帮我看看，朋友圈怎么发比较好？',
 '就走你刚才说的第一个方向，写条朋友圈，再用我传的第二张商品图配一张方形海报，先给我看方案。',
 '文案里的价格改成22元，图按刚才的方案做。',
 '文案用刚改的那版。图片还是用最开始上传的第二张，换成浅灰背景，再给我一套。'
 ],'文字消费真实资料与选定方向；生成绑定第二张上传图；文字改价不串改冻结图片参数；最后回到上传原图而非生成图。',['资料全文及两个图片ID','每轮模型输入与文字正文','方案/批准/回执','原图与产物父子关系'],{category:'multi_text_image_reference',...imageBlock,fixtures:['product_brief.txt','product_a.png','source_image.png']})
);
const existingCategory={AC_MEDIA:'multi_image',AC_PRODUCT:'multi_image',AC_PROMPT_ONLY:'multi_image'};
for(const item of acceptanceCases){
 item.category??=existingCategory[item.id]||'multi_text';
 item.sessionMode=item.category.startsWith('new_')?'new':'multi';
}
export function selectAcceptanceCases({categories=[],ids=[]}={}){
 for(const name of categories)if(!Object.hasOwn(acceptanceCategories,name))throw new Error('Unknown acceptance category: '+name);
 for(const id of ids)if(!acceptanceCases.some(c=>c.id===id))throw new Error('Unknown acceptance case: '+id);
 const selected=acceptanceCases.filter(c=>(!categories.length||categories.includes(c.category))&&(!ids.length||ids.includes(c.id)));
 if(!selected.length)throw new Error('No acceptance cases match the selected categories and IDs');
 return selected;
}

export function withAcceptanceFault(tools,fault,round,log){
 return {...tools,execute:async(name,args,ctx)=>{
  if(fault&&fault.round===round&&name===fault.tool&&!log.length){
   const result={ok:false,status:'not_executed',error:{code:'evaluation_injected_failure',message:name==='read_asset'?'Temporary read failure; retry the same asset.':'Arguments rejected for this attempt; inspect the original goal and retry saving. This attempt saved nothing.'}};
   log.push({round,name,args,result,injected:true});return result;
  }
  return tools.execute(name,args,ctx);
 }};
}
