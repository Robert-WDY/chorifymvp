import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir=path.resolve('data/user-multiturn-eval-20260914'),base='C:/Users/asus/Desktop/codex-workspace/chorify-eval-20260914/agent_multiturn_user_tests_v1';
const load=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));const sum=load(dir+'/summary.json'),suite=load(base+'/cases.json'),receipts=load(dir+'/simulated-receipts.json');
const link=(f,label=path.basename(f),line)=>`[${label}](<${path.resolve(f).replaceAll('\\','/')}${line?':'+line:''}>)`;
const notes={
 'G01-T1':['PASS','按实际runtime范围区分直接执行与建议，3句话；没有外部写入。'],
 'G01-T2':['PASS','给出改写说明及原句示例，没有调用外部发送。'],
 'G01-T3':['PASS','示例已改为新品上线，正文不再保留半价/折扣。'],
 'G01-T4':['FAIL','“我上一条消息”被understand改成助手消息；未绑定原文，生成器回答无法获取，验收仍passed、task COMPLETED。'],
 'G01-T5':['PASS','返回本会话第一条用户原文；实际走6次模型调用，不是快捷0调用。'],
 'G01-T6':['PASS','恰好两条标题：今天新品上线 / 今天新品上线啦，均不超12字，没有额外解释。'],
 'G02-T1':['PASS','交付周五15:00线上通知，未外发。含占位符和创意补充，未据此认定外部事实已核实。'],
 'G02-T2':['FAIL','understand首次引入“每周五”，原模型输入中没有“每周”；生成及验收继承污染，把单次通知改为每周通知，仍完成。'],
 'G02-T3':['PASS','独立到货提醒两句，不混入培训时间/场景。'],
 'G02-T4':['PASS','第一句逐字保留，只修改第二句语气。'],
 'G02-T5':['FAIL','确实引用16:00中文版本，但英文artifact被记为revision_of、version3而非派生翻译；Every Friday继承T2错误。'],
 'G02-T6':['FAIL','query_task未输出产物/版本关系；requiredEvidence=task与文本artifact引用不匹配，6次inspection循环仍不满足，达到预算BLOCKED。'],
 'G02-T7':['PASS','回到到货提醒第二句并缩短；第一句保留，未误改英文通知。'],
 'G02-T8':['FAIL','两份understand草稿continuation.mode均输出respond（非法枚举），修复后仍失败。'],
 'G03-T1':['PASS','没有源图时NEEDS_INPUT，零媒体；回复含assets/referenceCatalog内部术语，是展示问题。'],
 'G03-T2':['PASS','图片等待不阻塞独立文字目标；两条拾光店庆通知，周六十点、无优惠活动。'],
 'G03-T3':['PASS','第一条保持，第二条口语化，旧图片义务仍在会话账本。'],
 'C01-T1':['NEEDS_REVIEW','逻辑链路通过：两个独立模拟图片执行、参数区分白杯/橙瓶、1:1。真实文件/视觉质量未评估，不能按真实生图PASS。'],
 'C01-T2':['NEEDS_REVIEW','逻辑链路按橙瓶源URL编辑一次；真实像素保留未评估。附带“缺编辑工具”假设与实际runtime能力不一致。'],
 'C01-T3':['FAIL','文本请求在understand连续结构失败，末次把executionShape放在顶层；没有额外媒体。'],
 'C01-T4':['FAIL','“第一张”选中目录index0的support prompt，而非白杯image；productionUsable=false被程序拒绝。不是simulation图片验收标记导致。'],
 'C01-T6':['NEEDS_REVIEW','明确新增生成一条新模拟执行，旧绿瓶仍保留；真实可打开图片与风格未验证。'],
 'C02-T1':['PASS','真实文字生成与验收：三镜各3秒、总9秒，三个指定画面保留，零媒体。'],
 'C02-T2':['HARNESS_ERROR','方案3项映射正确，返回3个模拟回执；native simulated_passed无法满足coverageStatus要求的真实passed及quality.coverage，不能把0/3当真实图像覆盖失败。'],
 'C02-T5':['HARNESS_ERROR','方案1个文件覆盖3单元，返回1个模拟回执；同一simulation/coverage不兼容。'],
 'C03-T1':['FAIL','实际方法顺序为产品理解→方向设计→Brief→方向设计，方向阶段重复，正式交付两套方向；task仍COMPLETED。'],
 'C03-T2':['FAIL','已有方向选择被重新编译为方向设计→脚本，再交付一组重排方向；脚本虽使用工位改造方向，仍违反只消费原第二方向的过程要求。'],
 'C03-T3':['FAIL','只改字幕语言，却继承方向创作义务，select_capabilities阶段报“方向义务缺少兼容的生产能力”。'],
 'C04-T1':['PASS','完整准备5秒16:9方案并WAIT_CONFIRM；零视频提交。'],
 'C04-T2':['PASS','修改为9:16，5秒保留，重新待确认，零视频提交。'],
 'C04-T3':['PASS','待确认视频保留，独立开业通知成功，零媒体提交。'],
 'C04-T4':['FAIL','仅查询当前方案和费用，被修订继承校验以“确认后的媒体义务缺失”拒绝；尚未到实际报价查询，不能把本次入口失败归为报价能力缺口。']
};
const reviews=sum.results.map(r=>{const id=r.caseId+'-T'+r.turn;const own=receipts.filter(x=>x.caseId===r.caseId&&x.runId===r.requestId);return {...r,provisionalOutcome:r.outcome,provisionalSimulatedSubmissions:r.simulatedSubmissions,...(notes[id]?{outcome:notes[id][0],review:notes[id][1]}:{}),...(r.startedAt?{simulatedSubmissions:own.length,traceFile:id+'.json'}:{})};});
const sessions=fs.readdirSync(dir+'/sessions').filter(f=>f.endsWith('.json')).map(f=>load(dir+'/sessions/'+f));
const calls=sessions.flatMap(s=>(s.modelCalls||[]).map(c=>({caseId:s.evaluation.caseId,sessionId:s.id,...c})));
const transports=sessions.flatMap(s=>(s.transportCalls||[]).map(c=>({caseId:s.evaluation.caseId,sessionId:s.id,...c})));
const inputTokens=transports.reduce((n,c)=>n+(c.body?.usage?.input_tokens||0),0),outputTokens=transports.reduce((n,c)=>n+(c.body?.usage?.output_tokens||0),0);
const count=rows=>Object.fromEntries([...new Set(rows.map(r=>r.outcome))].map(k=>[k,rows.filter(r=>r.outcome===k).length]));
const report={at:new Date().toISOString(),suiteVersion:suite.version,totalScenarios:24,totalTurns:136,executedTurns:reviews.filter(r=>r.startedAt).length,actualModelHTTPRequests:transports.length,modelTraceCalls:calls.length,inputTokens,outputTokens,realImageSubmissions:0,realVideoSubmissions:0,simulatedImageReceipts:receipts.length,counts:count(reviews),executedCounts:count(reviews.filter(r=>r.startedAt)),grading:'逐轮人工复核文字及程序链路；不由被测模型自验passed决定PASS；没有新增裁判模型调用。',harnessCorrection:'初始summary用两worker共享receipts增量，C03-T1误计了其他组媒体。正式结果按caseId+runId重新计算；该轮实际0媒体，但独立方法顺序证据仍使其FAIL。初始summary和执行脚本均保留。',results:reviews};
fs.writeFileSync(dir+'/评测结果.json',JSON.stringify(report,null,2));
fs.writeFileSync(dir+'/完整Trace.json',JSON.stringify({metadata:{suiteHash:createHash('sha256').update(fs.readFileSync(base+'/cases.json')).digest('hex'),mode:'real-model + real-text-verifier + native simulated images; no actual video/image',credentials:'HTTP认证头未记录；modelCalls为应用脱敏副本，transportCalls保留业务authorization而不含认证header。',providerMediaReceipt:'仅模拟日志，没有真实媒体HTTP报文'},sessions,receipts},null,2));
const index=reviews.filter(r=>r.startedAt).map(r=>({caseId:r.caseId,turn:r.turn,query:r.query,requestId:r.requestId,sessionId:r.sessionId,taskId:r.taskId,taskStatus:r.taskStatus,outcome:r.outcome,traceFile:r.traceFile,calls:calls.filter(c=>c.runId===r.requestId).map(c=>({id:c.id,nodeId:c.nodeId,methodId:c.methodId,phases:c.validations?.map(v=>v.phase),status:c.status,startedAt:c.startedAt,finishedAt:c.finishedAt,errors:c.validations?.filter(v=>v.accepted===false||v.ok===false),usage:c.providerResponse?.usage})),toolCalls:Object.values(sessions.find(s=>s.id===r.sessionId)?.taskStore?.toolCalls||{}).filter(c=>c.runId===r.requestId).map(c=>({id:c.id,name:c.name,status:c.status,timing:c.timing})),transportIds:transports.filter(c=>c.runId===r.requestId).map(c=>c.id)}));
fs.writeFileSync(dir+'/Trace索引.json',JSON.stringify(index,null,2));
let md=`# 用户多轮测试包：Chorify MVP 实测结果\n\n本轮核验24组136轮，实际执行${report.executedTurns}轮、${transports.length}次真实DeepSeek请求。当前provider=${process.env.LLM_PROVIDER||'deepseek'}，model=${process.env.DEEPSEEK_MODEL||'deepseek-flash'}。生产server/dist/skills/config未修改；只新增测试驱动和报告。\n\n**${report.executedCounts.PASS}轮PASS、${report.executedCounts.FAIL}轮FAIL、${report.executedCounts.NEEDS_REVIEW}轮图片逻辑链路待真实视觉验证、${report.executedCounts.HARNESS_ERROR}轮模拟验收不兼容。另${report.counts.CAPABILITY_GAP}轮能力缺口、${report.counts.BLOCKED_BY_UPSTREAM}轮前置阻塞。没有真实图片或视频提交，${receipts.length}条图片回执均明确simulated。**\n\n## 执行边界\n\n- 包内SHA256SUMS全部匹配。每组独立新会话，仅把该轮user_query发给Agent，沿用真实前序输出/ID；expected_checks、未来事件及fixture答案没有进入模型。\n- 直接调用当前server/agent.mjs、ToolRuntime、Verifier、SessionStore；HTTP、浏览器渲染和后台monitor未纳入本次链路，因此不声称UI/后台恢复通过。\n- 真实文字模型、真实文字验收；图片通过原生simulation标记返回占位URL，没有真实图像文件。禁止image/video输入发送到真实模型观察；无视频、邮件、订单、日历、生产写操作。\n- 当前缺文档/本地图片上传及旅游、客服、办公、数据代码执行注册链，相关fixture未硬塞进模型伪装工具结果。G03只跑前三轮；C04只跑前四轮。\n- 重启、超时受理丢回执、重复确认事件未注入，恢复子测试为NOT_RUN；没有用一句“超时了”代替真实故障。套件外未增加付费重试样本。\n- 上游没有合格前置时不伪造产物；独立分支继续。例如C02-T5只依赖已存在的文字脚本，可与T2失败区分。前序已有真实可读取但语义错误的产物仍沿用，报告标明错误传播，不预修正历史。\n\n## 关键失败与模块原因\n\n| 用例 | 实测问题 | 错误发生位置与证据 |\n|---|---|---|\n`;
const issues=[
['G01-T4','原话主体识别错误，缺原文仍显示完成','conversation-query.historyQuery未覆盖此句式；understand把用户我变成助手。references=[]/requiredEvidence=none后，text-stage无原文，verify_text仍通过。','server/conversation-query.mjs',25],
['G02-T2','只改时间却把本周变每周','understand输出description首次出现每周，输入没有；generator照此改写，verifier未对“其他不动”进行差异约束。','server/intent.mjs',155],
['G02-T5','翻译误建为修订版本，污染继续传播','英文artifact version3、parent中文v2、relationship revision_of；Every Friday继承T2抽取污染。','server/execution-engine.mjs',52],
['G02-T6','只读盘点重复执行直到预算耗尽','inspectFacts只返回task状态/执行账本，不含产物关系；itemEvidence把文本artifact引用当待匹配task ID，results=[]不能满足，循环6次。','server/task-state.mjs',92],
['G02-T8','合法展示请求被非法控制枚举阻断','两次understand原始output均continuation.mode=respond，Schema只接受new/continue/approve/revise/clarify/cancel。','server/intent.mjs',130],
['C01-T3','写介绍触发结构错误','understand最终草稿在顶层写executionShape，Ajv拒绝；不是图片供应商错误。','server/intent.mjs',84],
['C01-T4','第一张误选support prompt','所选ref后缀0实际为support prompt；正确白杯图仍在目录且可用。程序安全拒绝，但模型局部修复未选对对象。','server/reference-catalog.mjs',19],
['C03-T1','Skill顺序错误和重复方向','method记录为product→direction→brief→direction；第一item已有两阶段，后续又独立方向node。局部方法齐全不等于全局顺序正确。','server/text-stage.mjs',67],
['C03-T2','消费已选方向却再创作方向','已选第二方向被额外direction阶段重排输出，再生成脚本；未仅消费已绑定旧方向。','server/planning-boundary.mjs',4],
['C03-T3','只加字幕被继承的方向义务挡住','能力选择尝试后报告方向义务缺少兼容生产能力；不是葡语生成模型本身没能力。','server/planning-boundary.mjs',56],
['C04-T4','只查方案/费用被媒体继承规则拒绝','入口两次草稿被确认后的媒体义务缺失阻断，尚未执行报价查询；不能把此失败改标为部署缺报价。','server/planning-boundary.mjs',92]
];
for(const [id,problem,why,file,line]of issues)md+=`| ${link(dir+'/'+id+'.json',id)} | ${problem} | ${why} ${link(file,file+':'+line,line)} |\n`;
md+='\n这些失败集中在入口结构/对象选择、跨轮继承、方法编译和状态聚合，不能笼统归因于“模型能力差”。G02-T2具体显示：模型先抽错描述，后续生成与验收共同遵循被污染合同。G02-T6则主要是程序证据判定/查询输出合同不匹配。\n\n## 模拟边界与测试驱动复核\n\nC02-T2真实planner输出3项、对应3个sourceUnitIds；T5输出1项覆盖3镜。模拟返回分别3图/1图，但coverageStatus只接受semantic=passed且有quality.coverage，原生simulation只标simulated_passed且跳过视觉裁判，因此0/3并不能证明实际图片漏镜。这两轮标HARNESS_ERROR，未修改production验收来让其“通过”，依赖它们的轮次阻塞。\n\n'+report.harnessCorrection+'\n\n## 逐轮结果\n\nPASS仅指该轮可验证检查；不将某组中几轮通过提升为整组稳定通过，单次采样不能估计稳定性概率。图片NEEDS_REVIEW的逻辑部分另有回执和参数证据，视觉质量均not_evaluated。\n\n| 场景 | 轮次 | 状态 | 实际任务状态 | 结论 |\n|---|---:|---|---|---|\n';
for(const r of reviews)md+=`| ${r.caseId} | ${r.turn} | ${r.startedAt?link(dir+'/'+r.traceFile,r.outcome):r.outcome} | ${r.taskStatus||'—'} | ${(r.review||r.reason||'').replaceAll('|','/').replaceAll('\n',' ')} |\n`;
md+='\n## 成本、版本与证据\n\n';
md+=`实际模型HTTP请求${transports.length}次，模型Trace ${calls.length}条；累计input_tokens=${inputTokens}，output_tokens=${outputTokens}。有缓存token时不等于净计费token；未读取价格/余额，不估算金额。返回正常证明本轮请求可用，不能推断剩余额度。\n\n`;
md+='来源基线、模型配置和适用性清单：'+link(dir+'/run-manifest.json')+'；生产文件复核：'+link(dir+'/source-check.json')+'。\n\n';
md+='完整单份JSON：'+link(dir+'/完整Trace.json')+'；按轮、task、call查询：'+link(dir+'/Trace索引.json')+'；正式判定：'+link(dir+'/评测结果.json')+'。每轮独立文件包含截至该轮的完整state、原始模型output及被拒草稿、模型HTTP request body/response body（无认证头）、工具参数/回执、任务/批准/版本、最终回答。模拟媒体没有真实HTTP报文；未执行的故障没有伪Trace。\n\n';
md+='## 修复优先级建议（本轮未修复）\n\n1. 原话查询输出稳定messageId+role+原文绑定；只改指定字段时，以源版本与用户delta做差异检查，不由重新抽取的description替换原合同。\n2. 分离history.read、artifact.inventory和provider task查询，查询产物关系不应受媒体回执证据规则约束；只读节点完成后不重复跑同一事实。\n3. 按源type/purpose过滤对象选择目录，禁止把support prompt作为“第一张图”的候选；修复时限制可选ID集合。\n4. 将用户要求的方法序列编译成稳定阶段ID，去除重复stage，历史方向只消费不重建；字幕修订不继承方向创作义务。\n5. 只读查询不应被媒体义务继承强迫变成执行目标；文字确认/修改/查询分开处理，保持未执行义务而不阻塞独立查询。\n6. 完成标志必须同时覆盖原始用户请求，而不是只证明当前已被污染的item通过局部验收。\n';
fs.writeFileSync(dir+'/评测报告.md',md);
console.log(JSON.stringify({counts:report.counts,executedCounts:report.executedCounts,requests:transports.length,inputTokens,outputTokens,simulated:receipts.length,traceBytes:fs.statSync(dir+'/完整Trace.json').size}));
