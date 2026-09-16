import json,pathlib,collections,hashlib,statistics,shutil,zipfile,re,datetime
P=pathlib.Path.cwd(); R=P/'data/intermediate-eval-20260914'; B=P/'data/focused-eval-v2-text-20260914'
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
def values(v):return list(v.values()) if isinstance(v,dict) else v or []
def imgparts(v):
 if isinstance(v,dict):
  return ([v] if v.get('type')=='input_image' else [])+sum((imgparts(x) for x in v.values()),[])
 if isinstance(v,list):return sum((imgparts(x) for x in v),[])
 return []
version=read(R/'version.json'); raw=read(R/'summary.raw.json'); rows=read(R/'results.json'); suite=read(B/'suite/cases.json')
supp=read(R/'readonly-supplement/results.json'); correction=read(R/'setup-correction-W04-T3/result.json')
sessions={f.parent.name:read(f) for f in (R/'cases').glob('*/session.json')}
fixturetraces={f.stem:read(f) for f in (R/'fixture-traces').glob('*.json')}
suppstates={f.stem:read(f) for f in (R/'readonly-supplement').glob('*-session.json')}
corrstate=read(R/'setup-correction-W04-T3/session.json')
calls={}
for state in [*sessions.values(),*fixturetraces.values(),*suppstates.values(),corrstate]:
 for m in state.get('modelCalls',[]):calls[m['id']]=m
receipts=read(R/'media-receipts.json'); media=read(R/'media/index.json')
posturls={d['url'].split('?')[0]:r['postIndex'] for r in receipts for d in r.get('response',{}).get('data',[]) if 'url' in d}
def postfor(url):return posturls.get((url or '').split('?')[0])
def compact_art(a):return {k:a.get(k) for k in ['id','taskId','itemId','type','purpose','version','parentId','relationships','publication','verification','acceptance','sourceExecutionId','url']}
audit=[]
for c in suite:
 if c['id'] not in version['selected']['textCases']+version['selected']['imageCases']:continue
 for t in c['turns']:
  row=next((x for x in rows if x.get('turn_id')==t['id']),None)
  if not row:
   audit.append({'id':t['id'],'query':t['user_query'],'executed':False,'assessment':'BUDGET_NOT_RUN','reason':'图片20次上限已满；E05/E07前置源图未提交。原SETUP_ERROR为适配器包装错误，非供应商中断。','expected':t['expected']});continue
  a={'id':t['id'],'query':t['user_query'],'original':row,'expected':t['expected'],'executed':bool(row.get('executed'))}
  if not row.get('executed'):
   a['assessment']='SETUP_NOT_SCORED' if row.get('mode')=='fixture_setup' else 'UPSTREAM_SOURCE_NOT_READY';audit.append(a);continue
  state=read(R/row['trace']); before=read(R/f"cases/{c['id']}/{t['id']}-before.json")
  task=state['taskStore']['tasks'].get(row.get('taskId'),{})
  models=[m for m in state.get('modelCalls',[]) if m.get('runId')==row.get('agentRunId')]
  tools=[x for x in values(state['taskStore'].get('toolCalls')) if x.get('runId')==row.get('agentRunId')]
  executions=[x for x in values(state['taskStore'].get('executions')) if x.get('taskId')==row.get('taskId')]
  artifacts=[x for x in values(state['taskStore'].get('artifacts')) if x['id'] not in before.get('taskStore',{}).get('artifacts',{})]
  a.update(modelCallIds=[m['id'] for m in models],rejectedDrafts=[{'callId':m['id'],'validation':v} for m in models for v in m.get('validations',[]) if v.get('accepted') is False],toolCalls=tools,executions=executions,artifacts=[compact_art(x) for x in artifacts],transitions=task.get('transitions',[]),executionPlan=task.get('executionPlan'),approval=task.get('approval'),batches=task.get('batches'),goalTasks=task.get('goal',{}).get('tasks'),requestContract=task.get('goal',{}).get('requestContract'),imagePosts=[postfor(d['url']) for e in executions for d in e.get('result',{}).get('images',[])],imageReferencePosts=[[postfor(u) for u in e.get('args',{}).get('referenceImages',[])] for e in executions],visualInputCounts=[{'callId':m['id'],'count':len(imgparts(m['input'])),'method':m.get('methodId')} for m in models if imgparts(m['input'])])
  status=row.get('status');a['assessment']='RUNTIME_COMPLETED_NOT_FULL_PASS' if status=='completed' else 'RUNTIME_FAILED'
  if row.get('taskStatus')=='WAIT_CONFIRM':a['assessment']='EXPECTED_WAIT_CONFIRM'
  if row.get('taskStatus')=='CANCELLED':a['assessment']='CANCELLED_CONSTRUCTED_PENDING_TASK'
  if t['id']=='W04-T3':a['assessment']='HARNESS_SETUP_ERROR_CORRECTED_SEPARATELY'
  if t['id']=='V03-T2':a['assessment']='PLAN_STATE_MISSING_COMPLETED_FALSE_POSITIVE'
  if t['id']=='E01-T3':a['assessment']='QUALITY_REJECTED_NO_CRASH'
  if t['id']=='E04-T3':a['assessment']='EXTRA_IMAGE_SUBMISSION_PRESERVE_MISREAD'
  if t['id'] in ['E04-T4','E04-T5']:a['assessment']='WRONG_BRANCH_VERSION_INHERITED_FROM_T3'
  audit.append(a)
write(R/'逐轮审计.json',audit)
transport=[json.loads(line) for f in [R/'model-transport.jsonl',R/'readonly-supplement/model-transport.jsonl'] for line in f.read_text(encoding='utf-8').splitlines() if line.strip()]
seenresponse={x.get('response',{}).get('id') for x in transport};corr_new=[m for m in corrstate.get('modelCalls',[]) if m.get('providerResponse',{}).get('id') not in seenresponse and m['id'] not in {q['id'] for s in sessions.values() for q in s.get('modelCalls',[])}]
usage=collections.Counter(); models=collections.Counter();phase=collections.Counter()
for m in calls.values():
 for k in ['input_tokens','output_tokens','total_tokens']:usage[k]+=m.get('providerResponse',{}).get('usage',{}).get(k,0)
 models[m.get('model','unknown')]+=1
 for v in m.get('validations',[]):
  if v.get('phase'):phase[v['phase']]+=1
rejected=[{'callId':m['id'],'runId':m.get('runId'),'validation':v} for m in calls.values() for v in m.get('validations',[]) if v.get('accepted') is False]
modelbycase=collections.defaultdict(list)
for x in transport:modelbycase[x['context']].append(x)
text=[r for r in rows if r.get('executed') and r['case_id'] in version['selected']['textCases']];images=[r for r in rows if r.get('executed') and r['case_id'] in version['selected']['imageCases']]
hashcheck=[{'file':x['file'],'expected':x['sha256'],'actual':hashlib.sha256((P/x['file']).read_bytes()).hexdigest()} for x in version['sourceVersion']['hashes']]
assert all(x['actual']==x['expected'] for x in hashcheck),'Production source drift'
imageledger=[]
for rec in receipts:
 match=next((a for a in audit if rec['postIndex'] in a.get('imagePosts',[])),None)
 imageledger.append({'postIndex':rec['postIndex'],'context':rec['context'],'turnId':match['id'] if match else None,'fixture':rec['context'].startswith('fixture:'),'referencePosts':[postfor(u) for u in rec['request'].get('image',[])],'httpStatus':rec.get('httpStatus'),'responseUsage':rec.get('response',{}).get('usage'),'files':[m for m in media if m['postIndex']==rec['postIndex']]})
write(R/'图片提交与复用账本.json',imageledger)
summary={'runId':version['runId'],'mode':'constructed intermediate diagnostic, unchanged source, real providers','productionCodeModified':False,'sourceHashesVerified':len(hashcheck),'text':{'executed':len(text),'statuses':dict(collections.Counter(r.get('status') for r in text)),'taskStatuses':dict(collections.Counter(r.get('taskStatus','NO_TASK') for r in text))},'image':{'executedQueries':len(images),'statuses':dict(collections.Counter(r.get('status') for r in images)),'submissions':len(receipts),'fixtureSubmissions':sum(r['context'].startswith('fixture:') for r in receipts),'nonFixtureSubmissions':sum(not r['context'].startswith('fixture:') for r in receipts),'successfulReceipts':sum(r.get('httpStatus')==200 for r in receipts),'extraSubmissionMisreadAsPreservation':[19],'internalQualityRepairPosts':[4,8,12],'realFilesValidated':len(media),'actualInvoiceCNY':None,'budgetReservationCNY':20,'reservationIsNotActualCharge':True},'supplement':{'queries':len(supp['results']),'modelRequests':supp['modelRequests'],'imagePosts':0},'harnessCorrection':{'agentQueries':1,'modelRequests':correction['additionalModelCalls'],'result':correction['final']['status']},'uniqueRecordedModelCalls':len(calls),'transportRecords':len(transport),'correctionAdditionalCalls':len(corr_new),'modelCounts':dict(models),'usage':dict(usage),'validationPhaseCounts':dict(phase),'rejectedDrafts':len(rejected),'videoPosts':0,'audioPosts':0,'guardAttempts':raw['boundaries'],'plannedButUnsent':[a['id'] for a in audit if a['assessment']=='BUDGET_NOT_RUN'],'sourceBlocked':[a['id'] for a in audit if a['assessment']=='UPSTREAM_SOURCE_NOT_READY'],'unselectedCases':[c['id'] for c in suite if c['id'] not in version['selected']['textCases']+version['selected']['imageCases']],'runtime3212':'NOT_TESTED','http_ui_restart_recovery':'NOT_TESTED'}
write(R/'summary.audited.json',summary);write(R/'source-hash-check.json',hashcheck);write(R/'rejected-drafts.json',rejected)
write(R/'完整Trace.json',{'version':version,'summary':summary,'audit':audit,'sessions':sessions,'fixtureTraces':fixturetraces,'fixtureSetups':{p.stem:read(p) for p in (R/'setup').glob('*.json')},'modelCalls':list(calls.values()),'modelTransport':transport,'mediaReceipts':receipts,'imageLedger':imageledger,'readonlySupplement':{'results':supp,'sessions':suppstates},'harnessCorrection':{'result':correction,'session':corrstate},'traceLimitations':['Authorization headers and signed URL query strings are redacted. Per-call raw provider inputs/outputs are retained except redaction.','Correction calls use traced normalizedRequest/providerResponse; no independent transport.jsonl for that replay.','Existing redact() can consume markdown closing parenthesis after signed URL. This is export alteration, not evidence that UI rendered invalid markdown.','Fixture SHA in fixtures/*.json hashes Buffer JSON, not actual file bytes; media/index.json contains correct byte SHA256.','No original chain pass inferred from constructed prerequisites; no original E07 score inferred from cup substitute.']})
note='''本轮使用当前源码直接调用 Agent.run，生产 server/skills 未修改；不经过 3212 HTTP/前端。主评测 runId：f34fd712-c99c-4626-b861-c4767865a33c。基线 runId：75ebcf29-2fd0-4cde-bf4e-8199cdbf57a4；冻结源码与配置在 source-version/ 中，可按 source-hash-check.json 校验。

**执行范围与统计口径**

文字 50 轮全部实际发送：31 completed、14 failed、3 WAIT_CONFIRM（前端 needs_input）、1 cancelled、1 blocked。completed 仅表示运行状态，不代表每项需求通过。W04-T3 的 blocked 来自前置素材缺少验收信息，属测试构建问题；另用真实 Verifier 检查后原 Query 重放 completed，原失败未覆盖。

原图片用例实际发送 16 轮：15 completed、1 blocked；另有 4 个首轮用中间态代替，不计通过。E01-T4 因上一轮没有合格绿瓶版本而未发送；E05、E07 共 8 个原始轮次因图片上限未运行。追加 3 轮无生图补测，另有 W04-T3 一轮纠正重放；共 70 次 Agent Query（50+16+3+1），不能合并算一个通过率。

本轮图片提交恰为 20 次：4 次创建源图、16 次后续提交。其中 3 次是质量修复（#4/#8/#12），1 次是错误地重做应保留分支（#19）。20 个 HTTP 200 回执、20 张可解码真实图片，均 2048×2048；视频和音频提交均 0。4 张源图是橙瓶、蓝底白杯、熊猫、黄椅。橙瓶跨 E01/E02 复用；蓝底杯及 E02 真实米白编辑结果又用于澄清/视觉补测，均以新会话 ID/素材 ID 导入，不伪造原任务成功。

用户批准上限为 ¥20 且 20 次图片提交。运行器确实限制了提交数，并按每次 ¥1 预留，总预留 ¥20；但未取得供应商适用单价或账单，不能把预留金额写成实际消费，也不能独立证明实际费用小于 ¥20。账本保留实际 usage；文字/视觉模型费用同样未取得账单。下次应先获取可信单价，再据请求规格预留金额。

**最关键的问题与证据**

1. “保留旧成果”被转成新的生产权限。E04-T3 用户只要求新增白底蓝椅分支、保留已有灰底黄椅。理解器却产出两个 edit_image 目标，独立合同也给 image=2、currentPermission.mediaBudget.image=2；随后 #18 生成蓝椅、#19 重做灰底黄椅。这不是修复重试。E04-T4 展示了 #19 而不是原 #17；E04-T5 也继承新造的灰底版本。单件验收都通过，整轮仍违反保留义务。证据：cases/E04/E04-T3-after.json、逐轮审计.json（E04-T3/T4/T5）、图片账本 #17–20。源码：server/intent.mjs intake（独立范围提取 227、数量对齐 231、路由 249、goal 构建 255）；server/model-context.mjs evidenceContext:20 对多节点任务将 query 置空。模型误解和程序授权/整体验收之间缺少“已有保留项不消耗新增预算”的通用语义校验。

2. 双图比较的视觉输入结构错误。D01-cup-observation-2 绑定两张真实图片，但 observeImages 逐张调用 analyze_image，每次都传同一个“对比两张图”问题。视觉模型每次只收到一个 input_image：第一调用（85fff504-a785-4615-941f-264005816359）说两图都蓝底；第二调用（14c42ed8-eb24-47cf-9611-4df180db087d）说两图都米白底。正文随后选了后者，两次验收均拒绝，最终 blocked。证据：readonly-supplement/D01-cup-observation-2-after.json、model-transport.jsonl 中上述调用对应原始响应；源码 server/observation-contract.mjs observeImages:19–25、server/tools.mjs:86–92、server/text-stage.mjs:53。这是“跨图问题/单图输入”不匹配，不应只归因模型理解能力。单图补测 D01-cup-observation-1 实际调用 analyze_image，正确回答深蓝底/白杯/1个/无把手，模型请求包含真实 input_image。

3. Skill 身份没有统一。50 轮中有 12 轮在 intake 以“规划遗漏用户必需的Skill”失败，涉及 S01/S02/S04/S05/S06/W01/W02/W03/W04。中文名称与 canonical slug 混用，独立提取没有完整 catalog，随后使用 query.includes(slug) 筛选，再按 slug 校验路由。例 S01-T1 原文“提示词改写”，独立合同保留中文名，规划路由使用英文 ID，最终拒绝。源码 server/intent.mjs:192、227、249；每轮被拒草稿均在 rejected-drafts.json，完整模型输入输出在 完整Trace.json。不能用新增关键词规则刷过测试；应在单一 registry 上解析名称/别名到稳定 ID，保留原文证据，路由和审计共用身份。

4. 最终义务与当前待确认状态仍不一致。V03-T1 被“范围统计必须包含确认后的最终媒体义务”拒绝；V03-T2 能给方案正文却新任务 COMPLETED、没有相应可执行 batch/approval payload；V03-T3 修复后仍缺 deliverables[1].count，Schema 拒绝。V03 使用构建的历史方向和计划，所以仅证明这些中间态输入下的表现。对照 V01-T1/T2/T3，本轮确有 WAIT_CONFIRM 和具体方案 payload；不应把 needs_input 一概判失败。源码 server/intent.mjs:227、server/turn-operation.mjs:6，证据逐轮审计.json/V01/V03 的 approval、batches、transitions。

5. 歧义澄清只完成一半。E05-T2-reuse 使用两张真实白杯图，原样问“把它改成红色”。系统没有提交图片，正确问改哪张；但在等待状态中已默认“主体变红、背景不变”，没有问改杯子还是背景。第一次草稿还把说明文字当成 source ID，修复后才进入 needs_input。证据 readonly-supplement/E05-T2-reuse-1-after.json。应把目标对象和修改属性分别作为未决槽位，未澄清的属性不能写入确定约束。

6. 图像工具正常返回不代表内容保持成功。E01-T3 的候选 #3 瓶盖仍橙色，修复 #4 添加 Logo/标签，系统拒绝并阻塞；这是正确拦截的质量失败，无供应商连接故障。E02-T4 首稿 #7 添加杯把，修复 #8 恢复无把手杯。E03-T2 首稿 #11 改变熊猫姿态/风格，修复 #12 更接近，但与源图 #10 的姿态、笔触仍需人工复核；不能仅以内部 passed 宣称像素保持。后续抱枕颜色变更及椅子变色均实际有返回。图片联络图及逐张原图在 media/。

7. 测试框架本身有可核验偏差。W04-T3 前置文字带 taskId 却缺 verification，server/sources.mjs:79 正确拒绝新生产消费；补齐真实验收后重放成功，不能把原阻塞记生产缺陷。E05/E07 在预算护栏抛错时，server/media.mjs:26 的 catch 将“本地未提交”包装为“连接中断/提交未知”；回执仅20条且前置源未发出，所以本轮属预算未运行，不是欠费或网络错误。该行为说明错误类型/已提交证据需要保留，但不等于已复现真实网络故障。原始结果不覆盖，审计分类单列。

8. 交付展示仍有内容级疑点。S02-T4 要求纯正文仍带标题前缀；S05-T4 要选定第二条标题却同时交付第一、第二条；S06 部分输出仍带旧批注，应进一步按用户选定范围核验。文档修订末尾展示旧 source ID/v1 后写“已发布新版本”，容易误认版本（server/agent-loop.mjs:146），实际产物 version 需看 State。本轮未将这些自动算成完整 PASS。脱敏器 server/trace-context.mjs:17 会吞掉签名URL后的 Markdown右括号，导出的文本可能缺括号；不能据此认定线上前端同样坏掉。

**已验证与未验证**

已验证：真实模型/图片请求回执；输入素材复用；50轮文字请求全部发送；部分文字修订/历史展示；V01待确认参数状态；跨对象图片切换；多轮图片版本；独立分支误生产；单图观察与双图输入错误；内部质量修复与错误拒绝；20次提交边界。为降低费用，没有为所有被上游阻塞的图片分支再造素材，也没有把不合格绿瓶当合格版本继续。

未验证：原首轮失败的端到端链路已经修复；3212前端/HTTP行为；真实视频生成；点击确认后供应商提交；重启恢复/幂等/提交结果未知恢复；生产全局共享预算；真实账单；全部内容约束、每张图严格像素保持。E05修改红背景和E07苹果组未运行；杯子观察补测不替代原苹果组通过。无生产修复，因此同版本结果波动（例如W03-T1本轮失败、旧基线成功）属于单次采样差异，不能称改进率。

**通用改进方向（未实施）**

把本轮操作表达为“读取/展示/保留/修订/派生/新建”及明确的对象ID、源版本、属性差量，编译时从真正新增/编辑动作计算权限与预算；既有成果保留只更新展示/分支关系。把观察合同分成单图事实与多图比较，多图比较一次传入完整有序图片集及来源ID；修复必须从矛盾证据返回观察节点，不能仅重写正文。Skill 身份从统一注册表解析。合同区分最终交付义务、当前执行许可、待确认可执行参数。预算用持久化预留/结算与真实单价，区分未提交、拒绝、已受理、结果未知。评测保留真实链路成绩与中间态诊断成绩，逐轮核对输入集合和实际副作用，不能只统计 completed。

**文件导航**

完整Trace.json：主会话所有模型上下文/原始provider输入输出、工具回执、State、前置构建、纠正重放及只读补测；逐轮审计.json：每轮Query、原始状态、计划、批准、工具输入输出、来源、产物和拒绝草稿；图片提交与复用账本.json：每次POST与媒体文件的映射；rejected-drafts.json：格式/规划拒绝记录（质量拒绝另在验收调用和产物中）；source-hash-check.json：源码字节校验。

原始脱敏文件仍完整保留在 evidence/，包括每轮before/after。private目录、.env、Authorization与签名URL参数不导出。若需要重发模型请求，必须使用本地原始私有资料，不可将脱敏URL当可执行URL。media/index.json 的 sha256 是实际图片字节哈希；fixtures/*.json 中旧 sha256 是Buffer序列化哈希，不用于文件校验。
'''
note += '\n**本次可核验统计**\n\n```json\n'+json.dumps(summary,ensure_ascii=False,indent=2)+'\n```\n\n**逐轮状态索引（非通过率）**\n\n|轮次|实际发送|审核分类|原始状态|\n|---|---|---|---|\n'
for a in audit:note+=f"|{a['id']}|{'是' if a['executed'] else '否'}|{a['assessment']}|{a.get('original',{}).get('status','NOT_RUN')}|\n"
note=note.replace('E01-T3 的候选 #3 瓶盖仍橙色，修复 #4 添加 Logo/标签，系统拒绝并阻塞；这是正确拦截的质量失败，无供应商连接故障。','E01-T3 候选 #3 的瓶身已绿、瓶盖仍橙。首次验收自行推定瓶盖也必须变绿并拒绝（call 16d7c7af-54dd-488c-ae55-b3773a75f40a），但用户说的是“瓶身”，因此首次拒绝存在扩大修改范围的问题，不能直接判作工具失败。修复 #4 又添加 Logo/标签，最终拒绝有真实像素依据（call 6a5e1e4a-5ef0-4e0a-b9cd-21795bf4301d）。这是“验收扩大要求→额外修复→新缺陷”的链条，无供应商连接故障。')
note=note.replace('后续抱枕颜色变更及椅子变色均实际有返回。','后续 E03-T6/#15 虽把抱枕变绿，但熊猫笔触/身体外观与暖光相对 #14 明显改变，内置验收仍 passed，属于需独立复核的假阳性；E04-T5/#20 椅子相对 #19 占幅与外观也明显改变，不能只因变橙和尺寸相同就宣称保持成功。')
(R/'评测报告.md').write_text(note,encoding='utf-8')
write(R/'visual-review.json',{'method':'manual contact-sheet inspection; not pixel-perfect measurement; all media decoded separately','findings':[
 {'posts':[1,2],'result':'background_edit_visually_plausible','note':'橙瓶原图与浅蓝背景编辑；未做严格像素一致性测量'},
 {'posts':[2,3,4],'result':'verification_overreach_then_real_quality_failure','note':'#3瓶身已绿、瓶盖仍橙；首轮验收自行要求盖也绿。#4新增文字标签，最终拒绝合理。'},
 {'posts':[5,7,8],'result':'first_edit_shape_changed_repair_closer','note':'#7新增把手；#8恢复无把手环纹白杯，但局部轮廓/尺度不做完全保持声明'},
 {'posts':[6,9],'result':'left_composition_visible','note':'墨绿瓶新增版本向左；不可仅据此判所有风格约束通过'},
 {'posts':[10,11,12],'result':'quality_repair_with_remaining_preservation_uncertainty','note':'#11坐姿/画风改变明显；#12较接近，但与原图姿态/笔触仍有偏差'},
 {'posts':[12,13,14],'result':'warm_light_and_pillow_visible','note':'暖光与右侧米白抱枕可见；严格身份保持未量化'},
 {'posts':[14,15],'result':'internal_pass_manual_preservation_failure','note':'抱枕变绿，但熊猫笔触、身体外观和暖光明显改变'},
 {'posts':[16,17,18,19],'result':'extra_preservation_submission','note':'蓝椅支线正确使用#16；#19是不应产生的灰底黄椅重做，并非内部修复'},
 {'posts':[19,20],'result':'internal_pass_manual_preservation_concern','note':'变橙色成功，但主体占幅/外观明显变化；严格保持不能据passed认定'}]})
print(json.dumps(summary,ensure_ascii=False))
