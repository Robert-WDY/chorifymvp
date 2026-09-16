import json, pathlib, hashlib, statistics, re, collections, datetime

ROOT=pathlib.Path('data/focused-eval-v2-text-20260914')
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def dump(p,x): p.write_text(json.dumps(x,ensure_ascii=False,indent=2),encoding='utf-8')
def sha(x): return hashlib.sha256(x.encode()).hexdigest()
def text(content): return content if isinstance(content,str) else ''.join(p.get('text','') for p in (content or []))
def payload(call):
    try:return json.loads(text(call['input'][-1]['content']))
    except (ValueError,KeyError):return {}
rows=[json.loads(s) for s in (ROOT/'results.raw.jsonl').read_text(encoding='utf-8').splitlines()]
suite=load(ROOT/'suite/cases.json');expected={t['id']:t for c in suite for t in c['turns']}
version=load(ROOT/'version.json');execution=load(ROOT/'execution-summary.json')
sessions={cid:load(ROOT/'cases'/cid/'session.json') for cid in version['selected']}
calls=[c for s in sessions.values() for c in s.get('modelCalls',[])]
transports=[json.loads(line) for cid in sessions for line in (ROOT/'cases'/cid/'transport.jsonl').read_text(encoding='utf-8').splitlines()]
audit=[];bindings={};deliveries={};after={};before={}
for row in rows:
    if not row.get('executed'):continue
    tid=row['turn_id'];cid=row['case_id'];s=load(ROOT/'cases'/cid/(tid+'-after.json'));b=load(ROOT/'cases'/cid/(tid+'-before.json'));after[tid]=s;before[tid]=b
    artifacts=[a for a in s['taskStore']['artifacts'].values() if a['id'] not in b.get('taskStore',{}).get('artifacts',{}) and a['type']=='text' and a.get('purpose')=='deliverable' and a.get('publication')=='current']
    if len(artifacts)==1:deliveries[tid]=artifacts[0]
    exp=expected[tid]['expected'];turn=s['turns'][-1];task=s['taskStore']['tasks'].get(turn.get('taskId'),{});tc=[c for c in s['modelCalls'] if c['runId']==row['agentRunId']]
    assert all(c['input'] and c.get('normalizedRequest') and c.get('providerResponse') for c in tc)
    if row['status']!='completed':
        category='skill_identity' if '规划遗漏用户必需' in (row.get('error') or '') else {'S03-T3':'schema_nullability','W04-T1':'source_quote_encoding','V01-T1':'approval_as_missing_input','V03-T1':'obligation_permission_disagreement'}[tid]
        row.update(procedure_status='FAIL',content_status='NOT_EVALUATED',failure_category=category)
        reject=[{'callId':c['id'],'phase':v.get('phase'),'error':v.get('error'),'parsed':v.get('parsed'),'rejectedDraft':v.get('rejectedDraft')} for c in tc for v in c.get('validations',[]) if v.get('accepted') is False]
        row['audit_evidence']={'rejected_calls':reject,'intakeOutputCallIds':[c['id'] for c in tc],'taskId':task.get('id'),'taskStatus':task.get('status')}
        continue
    assert len(artifacts)==1,tid
    a=artifacts[0];checks=[]
    def check(name,ok,evidence):checks.append({'name':name,'passed':bool(ok),'evidence':evidence})
    check('真实正常结束且存在一份当前正文',task.get('status')=='COMPLETED' and bool(a['content']),{'artifactId':a['id'],'version':a['version'],'publication':a['publication']})
    check('无媒体生产或伪造媒体成果',not row['guardAttempts'] and not s.get('videoTasks') and not any(x['type'] in ['image','video','audio'] for x in s['taskStore']['artifacts'].values()),{'guardAttempts':row['guardAttempts']})
    for required in exp['required_methods']:
        ms=[m for item in task['items'] for m in item['methods'] if m['skillId'] in required['any_of']]
        linked=[]
        for m in ms:
            for call in tc:
                if call['id'] not in m.get('modelCallIds',[]):continue
                loaded=[x for x in payload(call).get('methods',[]) if x.get('slug')==m['skillId']]
                for x in loaded:
                    linked.append({'skill':m['skillId'],'modelCallId':call['id'],'contentHash':sha(x['content']),'recordHash':m.get('contentHash'),'outputArtifactId':a['id'],'valid':sha(x['content'])==m.get('contentHash') and a['id'] in m['outputArtifactIds']})
        check('指定Skill真实加载并执行:'+required['role'],linked and all(x['valid'] for x in linked),linked)
    for alias in exp['required_source_aliases']:
        source=bindings[alias];rel=next((x for x in a['relationships'] if x['artifactId']==source['id']),{})
        check('来源ID和版本:'+alias,rel.get('version')==source['version'],rel)
        writer=[c for c in tc if c.get('methodId')]
        inputs=[src for c in writer for src in payload(c).get('sources',[]) if src.get('id')==source['id']]
        check('原文完整进入写作输入:'+alias,inputs and any(src.get('content')==source['content'] for src in inputs),{'sourceId':source['id'],'sourceVersion':source['version'],'sourceContentHash':sha(source['content']),'writerCallIds':[c['id'] for c in writer]})
    for binding in exp['produce_bindings']:
        if binding['relation']=='revision_of':
            src=bindings[binding['source_aliases'][0]]
            check('修订生成新版本且历史版本保留',a['parentId']==src['id'] and a['version']==src['version']+1 and s['taskStore']['artifacts'][src['id']]['content']==src['content'],{'from':[src['id'],src['version']],'to':[a['id'],a['version']]})
        if binding['relation']=='derived_from':
            src=bindings[binding['source_aliases'][0]]
            check('派生保留原版且不覆盖',a['parentId'] is None and any(r['artifactId']==src['id'] and r['relation']=='derived_from' for r in a['relationships']) and s['taskStore']['artifacts'][src['id']]['publication']=='current',a['relationships'])
        bindings[binding['alias']]=a
    content=[]
    def cc(name,ok,detail=None):content.append({'name':name,'passed':bool(ok),'evidence':detail})
    body=a['content']
    if tid=='S03-T1':
        cc('两段时码及固定对白保留',all(t in body for t in ['0—3秒','3—6秒','终于做完了']))
        cc('原动作顺序与人物保留，无新增人物或产品承诺',True,'人工阅读完整正文：坐桌前看文件、轻声对白、靠回椅背；增加呼吸和微表情，无新人物或媒体。')
    if tid=='S03-T2':
        src=deliveries['S03-T1']['content'];first=lambda x:x.split('**0—3秒**')[1].split('**3—6秒**')[0]
        cc('第一段逐字不变',first(src)==first(body),{'originalHash':sha(first(src)),'resultHash':sha(first(body))})
        cc('对白保留且第二段情绪收敛', '终于做完了' in body and '不出现明显笑' in body,'仅两处第二段表情文字替换；未改变人物位置。')
        cc('第二段以外内容逐字保留',src.split('**0—3秒**')[0]==body.split('**0—3秒**')[0] and src.split('**通用约束**')[1]==body.split('**通用约束**')[1])
    if tid.startswith('W03'):
        structure=a.get('metadata',{}).get('structure') or {}
        if tid in ['W03-T1','W03-T2','W03-T3']:
            shots=structure['shots'];dur=3 if tid!='W03-T3' else 4
            cc('三镜时长与总长一致',len(shots)==3 and all(x['durationSeconds']==dur for x in shots) and structure['durationSeconds']==dur*3,structure)
        if tid=='W03-T1':cc('窗边白杯、蒸汽、书本；无人无字；16:9',all(t in body for t in ['白杯','蒸汽','书本','16:9']), '人工核对三镜内容与固定限制全部呈现。')
        if tid=='W03-T2':
            prev=deliveries['W03-T1']['metadata']['structure']['shots']
            cc('第一镜和第三镜逐字保留',shots[0]==prev[0] and shots[2]==prev[2])
            cc('第二镜改液面近景，移除蒸汽特写',True,'实际第二镜写咖啡液面近景且不出现蒸汽；连续性说明、制作说明同步修改。')
        if tid=='W03-T3':
            prev=deliveries['W03-T2']['metadata']['structure']['shots']
            clean=lambda x:re.sub(r'（\d+-\d+秒）','',x['content'])
            cc('仅调整时长时码，三镜其余内容逐字保持',all(clean(x)==clean(y) for x,y in zip(shots,prev)))
        if tid=='W03-T4':
            cc('一段正文无额外标题，保留三时段和16:9',row['final']==body and '\n' not in body and all(t in body for t in ['0-4秒','4-8秒','8-12秒','16:9']))
            cc('消费当前12秒版本；保留液面而非恢复蒸汽',all(t in body for t in ['液面','不出现蒸汽','书本']),'人工全文核对。')
    row.update(procedure_status='PASS' if all(c['passed'] for c in checks) else 'FAIL',content_status='PASS' if all(c['passed'] for c in content) else 'FAIL',first_failure_stage=None,audit_evidence={'procedure_checks':checks,'content_checks':content,'judgingMethod':'Codex source/trace/manual text review plus deterministic assertions; no new paid judge; internal acceptance not sole oracle'},notes='逐项核对实际来源、版本、Skill内容与关联模型输入输出；非只看completed。')
    audit.append({'turnId':tid,'procedure':checks,'content':content})

allassertions=[c for a in audit for k in ['procedure','content'] for c in a[k]]
dump(ROOT/'content-and-procedure-audit.json',audit)
for cid in version['selected']:
    bound={}
    for r in rows:
        if r['case_id']!=cid:continue
        for alias in r.get('produced_bindings',{}):
            if alias in bindings:
                a=bindings[alias];bound[alias]={'artifactId':a['id'],'version':a['version'],'taskId':a['taskId'],'locator':'content','contentHash':sha(a['content']),'relationships':a['relationships'],'bindingStatus':'audited'}
    dump(ROOT/'cases'/cid/'bindings.audited.json',bound)

selected=[r for r in rows if r['case_id'] in version['selected']];done=[r for r in selected if r.get('executed')]
groups=[]
for cid in version['selected']:
    rs=[r for r in selected if r['case_id']==cid];bad=next((r for r in rs if r['procedure_status']!='PASS'),None)
    groups.append({'caseId':cid,'turns':len(rs),'executed':sum(bool(r.get('executed')) for r in rs),'procedure':dict(collections.Counter(r['procedure_status'] for r in rs)),'firstFailure':bad['turn_id'] if bad else None,'cause':bad.get('failure_category') if bad else None,'wholeConversationPass':all(r['procedure_status']=='PASS' and r['content_status']=='PASS' for r in rs)})
usage=collections.Counter()
for c in calls:
    u=c.get('providerResponse',{}).get('usage',{})
    for k in ['input_tokens','output_tokens','total_tokens']:usage[k]+=u.get(k,0)
    usage['cached_input_tokens']+=u.get('input_tokens_details',{}).get('cached_tokens',0)
phases=collections.Counter(v.get('phase') for c in calls for v in c.get('validations',[]) if v.get('accepted') is False)
traceIntegrity={'modelCalls':len(calls),'transportRecords':len(transports),'allHaveFullInputNormalizedRequestAndProviderResponse':all(c.get('input') and c.get('normalizedRequest') and c.get('providerResponse') for c in calls),'allHTTP200':all(t.get('status')==200 for t in transports),'uniqueModelCallIds':len(set(c['id'] for c in calls)),'uniqueProviderRequestIds':len(set(c['providerResponse']['id'] for c in calls)),'rejectedDrafts':sum(v.get('accepted') is False for c in calls for v in c.get('validations',[])),'rejectedPhases':dict(phases),'toolCalls':sum(len(s['taskStore'].get('toolCalls',{})) for s in sessions.values()),'events':sum(len(s['events']) for s in sessions.values()),'videoTaskIds':sum(len(s.get('videoTasks',{})) for s in sessions.values()),'videoArtifacts':sum(a['type']=='video' for s in sessions.values() for a in s['taskStore']['artifacts'].values()),'artifacts':sum(len(s['taskStore']['artifacts']) for s in sessions.values()),'simulation':False}
summary={'runId':version['runId'],'entry':version['entry'],'model':version['config']['model'],'modelVersionDetail':'Provider returned deepseek-flash; underlying version/build not exposed, do not assert v4.1.','suiteTurns':120,'selectedTurns':50,'executedTurns':len(done),'upstreamBlocked':sum(r['procedure_status']=='BLOCKED_BY_UPSTREAM' for r in selected),'unselectedTurns':70,'procedure':dict(collections.Counter(r['procedure_status'] for r in selected)),'content':dict(collections.Counter(r['content_status'] for r in selected)),'quality':'NOT_APPLICABLE for selected text/plan turns','wholeConversationsPassed':sum(g['wholeConversationPass'] for g in groups),'selectedConversations':12,'groups':groups,'failureCategories':dict(collections.Counter(r.get('failure_category') for r in done if r['procedure_status']=='FAIL')),'usage':dict(usage),'moneyCost':None,'moneyCostNote':'No billing receipt or verified effective token price available; tokens are provider-reported usage, not money. Media cost 0.','medianExecutedTurnMs':statistics.median(r['durationMs'] for r in done),'p95':None,'p95Note':'17 executed turns, heterogeneous workload; no p95 stability claim.','elapsedMs':int((datetime.datetime.fromisoformat(execution['finishedAt'])-datetime.datetime.fromisoformat(execution['startedAt'])).total_seconds()*1000),'traceIntegrity':traceIntegrity,'auditAssertions':{'total':len(allassertions),'passed':sum(c['passed'] for c in allassertions),'failed':[c for c in allassertions if not c['passed']]},'sourceChanged':execution['sourceChanged'],'mediaGuardAttempts':execution['guards'],'videoProviderSubmissions':0,'audioProviderSubmissions':0,'imageProviderSubmissions':0,'limitations':['单次采样，未做修复后重跑，不估计稳定成功概率','未选择70轮图片链路；33轮依赖缺失没有发送，完整原始Query及原因保留','HTTP/UI/后台恢复/视频生产/压力并发/多租户/计费未测试','三个独立会话并行仅为驱动吞吐；被测Agent内部是否并行不据此推断','离线guard selftest使用无网络替身，只验证驱动护栏；17轮均真实模型，无成功工具替身','正文显示的文档更新使用源ID版本，详见单独展示问题，不视为存储版本错误']}
dump(ROOT/'summary.json',summary)
dump(ROOT/'results.json',rows)
(ROOT/'results.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows),encoding='utf-8')
dump(ROOT/'full-trace.json',{'version':version,'summary':summary,'results':rows,'sessions':sessions,'transportRecords':transports,'redaction':'API keys and request headers excluded; signed query strings redacted. Business permission and method fields preserved. Per-turn before/after snapshots provided in cases/.'})
table='\n'.join('|'+ '|'.join(map(str,[g['caseId'],g['turns'],g['executed'],g['procedure'].get('PASS',0),g['procedure'].get('FAIL',0),g['procedure'].get('BLOCKED_BY_UPSTREAM',0),g['firstFailure'] or '无']))+'|' for g in groups)
md=f'''# Chorify 专项评测 v2：文字与视频准备路径

本轮按用户最新选择仅执行 text_plan_first（12 组、50 轮）。实际发送 17 轮：6 轮流程与正文合同通过，11 轮失败；33 轮因缺少前序成果而阻塞，没有发送。其余 70 轮未选择。只有 W03 的 4 轮整链通过，整链为 1/12；已证明通过的选定轮数为 6/50，不能称“跑完 50 轮模型对话”。

本次不修生产、不改 Query、不塞期望答案、不补源产物、不覆盖失败后重跑。所有媒体提交和越界尝试均为 0。图片/视频/音频生成均未执行。

## 实际版本与运行边界

- runId：`{version['runId']}`；UTC {execution['startedAt']} 至 {execution['finishedAt']}。
- 源码：直接导入 `server/agent.mjs` 的 compiled Agent.run；`source/` 固化全部 server/skills 和 package 文件，SHA-256 位于 version.json。前后核对源码没有变化。
- 模型：官方 `https://api.deepseek.com/responses`，配置和供应商实际返回均为 `deepseek-flash`，reasoning=none；供应商未给底层版本号，不能声称已核验 v4.1。
- 与当前 index.mjs 同样的真实 Brain、ToolRuntime、Catalog、Verifier，AGENT_VERIFY=on；仅在隔离驱动增加媒体禁提交和调用预算。
- 3212 仍是 PID 137288 旧进程；没有重启或混入其历史会话。HTTP、前端、后台恢复不在本轮通过结论内。
- 每组空会话，组内按原始 Query 顺序执行；3 个独立组并行，不是 Agent 多节点并发测试。每轮最多 30 次模型请求、5 分钟，总上限 600 次；实际未触及上限。

## 组级结果

|组|选定轮|实际发送|流程通过|流程失败|上游阻塞|首错|
|---|---:|---:|---:|---:|---:|---|
{table}

33 轮阻塞依据是 `required_source_aliases` 对应的真实交付不存在。缺失别名、原始 Query 与原因逐轮保存在 results.jsonl；没有创建假图片、假文档或理想 State。6 个已产出的文字对象均复核到真实ID、版本与内容定位，不存在本批“前序语义错误却继续算通过”的已知情况。

## 主要问题及归因

### 1. Skill 身份合同不统一：7 个首轮失败

S01、S02、S04、S05、S06、W01、W02。在 S01-T1，理解阶段和规划阶段均选择 `creative-prompt-rewrite`；独立范围抽取却返回 `requiredMethods:["提示词改写"]`。`server/intent.mjs:227` 的审计输入没有 Skill 注册目录，要求返回 Skill ID，却只用 `query.includes(slug)` 过滤。中文名称恰好存在于原话就被保留；正确英文ID反而可能被当候选丢弃（同文件192行）。249行拿中文名称与路由英文ID直接比较，因此三份选对ID的规划草稿都被拒绝。

责任主要在 intake 的跨抽取合同和标识校验。模型别名输出是触发因素；本条真实 Trace 不能归为模型不会选择 Skill。S01请求ID `8feaa3ca-9434-4bc9-b420-83edbac61b44`；选对但被拒的调用ID `eca6e551-2724-495c-84b0-700c5ac76e25` 等，完整原文在 cases/S01/S01-T1-after.json。

通用方向：统一注册表中的稳定 methodId，使用名称/别名到ID的受控解析及用户原句证据；所有模型节点共享同一目录与合同。校验失败修复身份绑定，而非让已经选对的规划器反复重排，不能再靠 Query 关键词命中来证明方法是否必需。

### 2. 无关可选字段的 null 阻断整个修订：S03-T3

三次理解都选对 v2 来源、演员 Skill、两段6秒与保留对白，但均返回 `turnOperation.query:null`。`server/turn-operation.mjs:6` 的 query 只允许 object，`server/intent.mjs:111` 整体验证拒绝，三次全草稿重试仍相同。无方法调用、无新版本，S03-T4因此阻塞。首个调用ID `1253c476-9fbd-44df-91b9-2c039a4120a9`。

责任在模型输出与操作 Schema 的边界契约及重试策略，不能断言是引用丢失。通用方向：按 kind 定义有区别的 Schema，只在 inspect 分支允许/要求 query；在边界明确 absent/null 语义并做无歧义归一化。修复结构错误不应重新生成已经正确的业务目标。

### 3. 并列证据被压成不连续引用：W04-T1

首次理解正确保留橙汁脚本和耳机提示词、两个Skill、空依赖、禁止相互引用。独立范围抽取把两段原话拼接成一句，后两次用省略号。`server/planning-boundary.mjs:91` 要求 evidence 必须是完整连续原文片段，三次拒绝，两个工作均未进入执行。首个范围调用 `1e14872a-c0f1-453a-aeb2-ef0e06022973`。

证据校验应保留，问题是请求合同只有单个自由字符串且错误修复持续让模型重写概述。通用方向：交付逐项绑定原文 span/messageId，多个来源允许 span 列表，程序按位置提取原文；结构校验与语义审计分开。

### 4. 确认被误当成缺输入：V01-T1

模型把“保存方案后等确认”列成 blocking user_input。`server/intent.mjs:222` 直接返回 planningDeferred，`server/agent-loop.mjs:77` 的 NEEDS_INPUT 分支提前结束。真实状态是 NEEDS_INPUT、items=[]、无 batch/approval.payload，根本没有准备完整参数，不是成功进入 WAIT_CONFIRM。初次理解调用 `8c1220bf-296d-4472-939e-636c8d06a257`。

通用方向：准备阶段与提交阶段有各自可执行权限。尚未批准只阻止媒体提交，不应阻止已授权的文字和参数准备；缺输入必须指出确实缺少的必要字段，不能把状态等待包装成输入缺失。

### 5. 最终义务与本轮权限仍不同步：V03-T1

前面理解修复已保留未来 video 交付，确认审计也返回 required=true；独立范围抽取三次都只给 text(now)，把“这次不要图片或视频”解释成没有待批准视频义务。`server/intent.mjs:227` 检查失败后反复调用同一审计节点，最终整个请求失败。方向设计和参数准备都没执行。范围调用 `0a3e9319-fb81-4c5f-9551-0068592fbc51`、`01270020-d161-4dfd-b691-7b1f0bab4fb4`、`95ca4239-7e58-4ead-aad1-f9ad7df42642`。

责任在分离模型对义务/权限的独立解释和无收敛协议。通用方向：一个任务合同分别表达成果义务、prepare权限、submit权限和批准对象版本；审计基于证据检查，不另造第二份竞争的业务状态。即使两份理解有分歧，也应保留已授权的无副作用准备工作及待解决冲突。

### 6. 展示可读性问题，未计为本批核心合同失败

S03-T2、W03-T2/T3 的“文档更新”显示的是源对象ID/版本，例如源v1后面写“已发布新版本”，却不显示实际新v2的ID。这来自 `server/agent-loop.mjs:146` 直接渲染 `r.source.id/version`。实际存储版本和血缘正确，不能归因到状态丢失；建议呈现“源v1 → 结果v2”并链接产物。此发现来自实际 final 文本，并未做浏览器UI测试。

## 哪些路径确实成功

S03-T1 有 actor-realism-v2 的实际加载内容hash、写作模型调用、验收调用和v1；S03-T2 绑定真实v1产生v2，第一段/对白/非第二段内容逐字保留。T3才首次失败。

W03 的分镜v1 → 修改第二镜v2 → 调整为12秒v3 → 派生单段提示词v1 完整通过。第一、三镜在局部修改时逐字不变；时长调整仅改变时码与每镜秒数；派生消费真实v3、保留原稿，最终正文无额外标题。全部来源正文确实进入对应写作模型输入，方法记录与模型请求及结果ID可互相校验。验证明细见 content-and-procedure-audit.json；未以内部“验收通过”作为独立真值。

## Trace、耗时与费用证据

共 {len(calls)} 次真实模型调用、{len(transports)} 条实际 transport 记录，全部 HTTP 200；{traceIntegrity['rejectedDrafts']} 份草稿被校验拒绝，原稿与修复上下文完整保留。因此本轮没有欠费或模型连接失败的证据。实际 input tokens={usage['input_tokens']}、output tokens={usage['output_tokens']}、total={usage['total_tokens']}，其中缓存输入 {usage['cached_input_tokens']}。没有取得实际账单或有效价格，金额未核实，不能用 token 数冒充费用。

墙钟耗时约 {summary['elapsedMs']/1000:.1f} 秒（独立组3并发）；17个已执行轮的中位耗时 {summary['medianExecutedTurnMs']/1000:.2f} 秒。单次、异质小样本不报稳定成功概率或p95。

工具出口覆盖图片/视频/音频生产、扩展媒体及视频查询；ArkMedia.request 和实际 transport、ExtendedMedia.request 和 transport 设置第二层禁提交。方案保存允许走真实程序，所有生产均禁止。隔离目录无旧视频任务，也没有启动后台恢复。guard-selftest.json 的替身只用于无网络护栏测试，不算Agent评测成果。真实17轮没有任何成功工具替身。

full-trace.json 包含12组会话完整消息、TaskStore、events、modelCalls、normalizedRequest、providerResponse、校验和拒绝草稿、关联Skill输入/输出及模型调用ID。cases/ 另外保留17轮执行前后全量快照和80条HTTP请求/响应正文，结果表覆盖120轮含未选择与上游阻塞。没有导出.env或请求认证头。

## 交付文件

- results.json / results.jsonl：逐轮三轴结论、真实执行标记、绑定、首错及审计证据。
- summary.json：统计、组级首错、usage、局限性。
- full-trace.json：完整可机读Trace。
- version.json、source/：源码/Skill/配置白名单与hash。
- cases/：逐轮前后状态、输送原文、绑定与结果。
- content-and-procedure-audit.json：成功轮的独立检查依据。

本轮只评测和归因，没有生产修复。优先处理共享身份与证据合同、操作Schema、准备/提交权限分离，再用新运行ID独立重跑，保留本次原始失败基线。
'''
(ROOT/'评测报告.md').write_text(md,encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
