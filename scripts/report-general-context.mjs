import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const dir='data/general-context-repair-20260914';
const hash=b=>createHash('sha256').update(b).digest('hex');
const names=(await fs.readdir('server')).filter(f=>f.endsWith('.mjs')),changes=[],version=[];
for(const name of names){const after=await fs.readFile('server/'+name);let before;try{before=await fs.readFile(dir+'/before/server/'+name);}catch{}const row={file:'server/'+name,before:before?hash(before):null,after:hash(after)};version.push({file:name,sha256:row.after});if(row.before!==row.after)changes.push(row);}
const original=JSON.parse(await fs.readFile(dir+'/original-trace.json'));
const batches=await Promise.all(['live','live2','frozen'].map(async name=>({name,...JSON.parse(await fs.readFile(dir+'/'+name+'-results.json'))})));
const frozen=batches.find(b=>b.name==='frozen'),runs=batches.flatMap(b=>b.rows.map(r=>({...r,batch:b.name})));
let tokens=0,withUsage=0;
for(const row of runs){const {state}=JSON.parse(await fs.readFile(dir+'/'+row.batch+'-'+row.id+'.json'));for(const c of state.modelCalls){const usage=c.providerResponse?.usage;if(Number.isFinite(usage?.total_tokens)){tokens+=usage.total_tokens;withUsage++;}}}
const metrics={original:{sessionId:original.sessionId,turns:original.turns.length,calls:original.modelCalls.length,events:original.businessEvents.length},sourceVersion:version,changedFiles:changes,batches:batches.map(b=>({name:b.name,requests:b.requests,cases:b.rows.length,originalAssertionsPassed:b.rows.filter(r=>r.passed).length,normalFinals:b.rows.filter(r=>r.checks.normalFinal).length})),totalRequests:batches.reduce((n,b)=>n+b.requests,0),recordedTotalTokens:tokens,requestsWithUsage:withUsage,realMediaSubmissions:runs.reduce((n,r)=>n+r.boundaries.length,0),frozenMatchesCurrent:frozen.rows.every(r=>JSON.stringify(r.version)===JSON.stringify(version)),regression:{tests:359,passed:359},interpretation:'原断言及所有失败记录保留。frozen 的 revise-original 要求必须出现 mode=rewrite，但实际执行了已加载的文字 Skill 并发布新版本，该执行方式断言未通过，不代表运行中断；不能把正常结束等同于内容质量全部合格。'};
await fs.writeFile(dir+'/verification-summary.json',JSON.stringify(metrics,null,2));
const refs=[
 ['历史消息与失败请求上下文','server/conversation-query.mjs','export function conversationContext'],
 ['历史消息按角色与锚点读取','server/conversation-query.mjs','export function resolveMessage'],
 ['操作与观察合同','server/turn-operation.mjs','export function readOperation'],
 ['入口理解及有界修复','server/intent.mjs','export async function understandGoal'],
 ['逐图片观察、部分失败恢复','server/observation-contract.mjs','export async function observeImages'],
 ['局部修改与整体改稿','server/document-revision.mjs','export function applyRevision'],
 ['文字执行输入','server/text-stage.mjs','async function executeSingleStage'],
 ['媒体范围无变化处理','server/planning-boundary.mjs','export function revisionMediaScope'],
];
const positions=await Promise.all(refs.map(async([name,file,needle])=>({name,file,line:(await fs.readFile(file,'utf8')).split('\n').findIndex(l=>l.includes(needle))+1})));
const rows=[
 ['1','你是什么模型','原轮成功；没有模型请求，旧关键词捷径直接读配置。','删除语句捷径；现在模型选择查询主题，执行器仍从实际配置读取。'],
 ['2','你上一轮的回答是什么','这份真实 Trace 中成功，返回前一轮助手原文；0 次模型请求。未找到本轮失败证据。','移除特定句式匹配，支持角色、位置、消息 ID 与 replyTo 关系；新表述实测准确。修复期间发现统一呈现路径多加状态前缀，已改为 answer 交付，确保逐字回查。'],
 ['3','生成一张图片','NEEDS_INPUT：用户未给主题。属于澄清，不是程序异常。','没有给该句增加默认模板或特判；仍交由模型结合上下文判断。'],
 ['4','猫的图片','补齐主题后完成真实图片生成，原图视觉验收有请求记录。图片 publication 仍为 candidate，与完成状态措辞不完全一致。','本次沿用真实原图验证观察链路，未再出图；旧产物发布标签未做历史迁移。'],
 ['5','你觉得这张图片怎么样','模型已抽出 requiredEvidence=image 和图片引用，却又返回 inspect/artifacts。normalizeTurnOperation 和 inspectionGoal 接受矛盾合同并覆盖交付，提前走元数据查询；没有视觉调用却显示完成。','不以“只读”推导“查目录”。不兼容的操作/证据合同退回完整语义修复；observe 保留真实图片、观察义务和文字输出。'],
 ['6','你分析这张图片','首稿含 deliverablesNote 多余字段且仍把观察与查目录混淆；第二稿查询 evidence 不是原始 query，重试耗尽后 failed。','格式与业务矛盾均基于原始请求修复完整草稿，不锁死有问题的操作字段；拒绝草稿保持原状进入 Trace。真实同句已实际看图并回答。'],
 ['7','图片','两次草稿都在顶层放 executionShape，但没有可归属的单项交付，最终 Schema 错误。模型同时受旧任务焦点和系统失败提示干扰。','从持久 turn.rawInput/status/error 构建 pendingRequest，区分系统失败与用户缺信息，减少重复历史和决策草稿。前两次真实采样正常澄清；冻结版本本次续接观察成功，尚不能称为稳定解决所有省略语。'],
 ['8','你有什么工具','成功读取目录，目录宣称 analyze_image 可用；与第5轮没有执行观察形成落差。','能力读取与执行选择分开；现在有真实 analyze_image 回执、原图输入以及回答输入作为执行证据。'],
 ['9','给我生成飞机的产品宣传，要包括市场分析','文字和市场分析已交付，未生成媒体；内容中的市场概况没有联网核验，不能据模型验收称为事实核验通过。','保持文字交付范围。本次重点修复后续补充关系，未声称已验证市场研究事实或营销质量。'],
 ['10','军用飞机，发布平台为抖音','主理解正确识别为改稿；第二个只看短摘要的操作判定器改成 new。程序又强制所有文字修改用 source_delta，禁止全文改写；首次局部改稿验收失败，第二次 edits=[] 回退原文后再次失败。','普通修改保留同一份已接受语义合同，不再被摘要判定器覆盖；纯续跑/批准保留带完整近期问答的授权复核。修订执行器读取完整原稿与原始增量，允许 patch/rewrite/no_change 或真实 Skill 执行，验收通过后才发布新版本。另修复不改变数量的零增量被要求提供新授权证据而阻塞文字改稿的问题。'],
];
const text='# 最新手动会话：逐轮 Trace 分析与通用修复\n\n'
 +'分析会话：'+original.sessionId+'。原会话 10 轮、24 次模型调用、74 个事件。分析依据为实际已保存的原始模型输入、适配后请求、原始响应、拒绝草稿、状态和工具记录，不以页面标题代替执行证据。\n\n'
 +'项目 package 版本 0.3.0，无 Git；精确代码前后 SHA-256 和最终源码指纹见 verification-summary.json。配置继续使用现有 DeepSeek deepseek-flash 和 manual-fixed-server 会话目录，未修改 .env。\n\n'
 +'## 逐轮结论\n\n|轮次|用户输入|原始证据与原因|处理及边界|\n|---|---|---|---|\n'+rows.map(r=>'|'+r.join('|')+'|').join('\n')+'\n\n'
 +'## 本次修复的原则\n\n删除了 conversation-query 中按具体问法匹配模型、工具、历史消息的快捷路由；删除 turn-operation 中用关键词推导查询和翻译、query-registry 中要求命中历史关键词才允许查消息的判断。语义由模型解释，程序只负责已声明合同的结构、角色/ID/版本、观察回执、依赖与执行权限校验，没有加入评测 case ID、固定 query 答案或针对“猫/军用飞机/抖音”的生产分支。\n\n'
 +'元数据查询不再吞掉内容观察。观察按源 ID、版本、URL 摘要和问题绑定；多图逐个读取，部分失败重试复用成功回执，旧版本/旧问题观察不能直接复用；文字生成及验收必须获得对应证据。文档修订以完整来源、原始用户变更和候选反馈作为输入，局部修改保持片段外原文，整体修改保留用户仍适用的义务和限制，结构文档保持单一正文权威。\n\n'
 +'这不是全项目去除所有旧启发式：来源单元选择、格式兼容、旧控制流程中仍有既有处理，本轮没有逐一重构，也没有声称全部语义错误均消除。模型仍可能选错目标或请求澄清，市场事实和创意质量仍需要独立评估。\n\n'
 +'## 验证结果\n\n- 自动化回归 359/359，通过，其中本次新增 8 项通用合同测试。旧“零次模型调用”和关键词捷径测试已改为语义选择后的原文/执行验证；媒体返回格式的测试替身仍明确属于测试。重试上限改为 3 次，只更新相应次数断言，未放宽禁止越权/源版本检查。\n'
 +'- 冻结同一源码快照 8 条真实 DeepSeek 回归：8 条均 completed，8 条请求传输均正常，0 次新增图片/视频提交；原预设断言 7/8。revise-original 实际走已加载 Skill 完成改稿并发布 v2，而断言只接受 document_revision 的 mode=rewrite，因此原断言失败被保留。不能把这次实现路径差异计成原断言通过。\n'
 +'- 冻结组包含原话及新措辞回查、三种真实看图请求、失败后的省略语续接、局部标题修改与整体定位/平台修改。局部改标题还逐字比对了其余全文。观察不是测试替身：供应商请求含原图，工具有分析正文，后续模型请求含绑定观察。\n'
 +'- 全部开发采样 '+metrics.totalRequests+' 次模型请求；记录到 usage 的 '+withUsage+' 次合计 '+tokens+' tokens。开发失败和不同快照都保留，不能混算成最终成功率。\n'
 +'- “图片”省略语在开发中两次澄清、本次冻结组成功；样本量小，不证明跨表述稳定性。现有媒体供应商提交被测试边界显式阻止，不属于真实出图或视频评测。\n\n'
 +'## 代码入口\n\n'+positions.map(r=>'- '+r.name+'：'+r.file+':'+r.line).join('\n')+'\n\n'
 +'## 加载状态\n\n生产代码已写入；自动审批策略拦截了停止/重启旧进程和启动新进程的命令，理由只返回 blocked by policy。3212 仍由旧进程 PID 137288 提供服务，本轮改动尚未在该端口加载。请手动运行 scripts/restart-local-backend.ps1；脚本会先检查运行中会话，再以原数据目录重启3212，不修改.env。\n\n## 证据文件\n\n- original-trace.json：原10轮完整已记录 Trace，API 密钥与签名查询参数已脱敏。\n- turn-analysis-input.json：按轮聚合的模型输出、校验与关键事件。\n- frozen-results.json：同快照原始断言，保留1项未通过。\n- frozen-*.json：逐条完整隔离会话及原始模型请求/响应、状态和工具回执。\n- live-*.json / live2-*.json：修复过程的原始失败及阶段采样。\n- regression-final.log：359项回归结果。\n- verification-summary.json：源码版本、实际调用数和证据解释。\n\n'
 +'所有历史用户会话原文保留；评测在隔离副本上运行，没有向原会话追加修复回答，也没有改写原失败记录。\n';
await fs.writeFile(dir+'/分析与修复报告.md',text);
console.log(JSON.stringify({changedFiles:changes.length,totalRequests:metrics.totalRequests,recordedTokens:tokens,frozenMatchesCurrent:metrics.frozenMatchesCurrent,frozenAssertions:frozen.rows.filter(r=>r.passed).length}));
