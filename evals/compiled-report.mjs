import {readFile,writeFile,readdir} from 'node:fs/promises';
import {validateGraph,validatePrepared} from '../server/goal-compiler.mjs';
import {currentTask,storeOf} from '../server/task-state.mjs';
import Ajv from 'ajv';
import {tools} from '../server/tool-schemas.mjs';
const root=new URL('../data/compiled-full-1000-v1/',import.meta.url),read=async name=>JSON.parse(await readFile(new URL(name,root),'utf8'));
const source=await read('source.json'),results=await read('results.json'),summary=await read('summary.json'),manifest=await read('manifest.json');
if(source.length!==1000||results.length!==1000||!summary.sourceUnchanged)throw new Error('Incomplete or unfrozen run');
const ajv=new Ajv({strict:false}),validators=Object.fromEntries(tools.map(t=>[t.name,ajv.compile(t.parameters)]));
const metrics=Object.fromEntries(['structure','mediaGoal','planning','toolIsolation','parameters','stateInvariants','confirmation','revision','recovery'].map(k=>[k,{passed:0,total:0}]));
const add=(key,passed)=>{metrics[key].total++;if(passed)metrics[key].passed++;};
let mediaArtifacts=0,textArtifacts=0,modelCalls=0,checkedCalls=0;const failures=[],audit=[];
for(const c of source){
 const trace=await read('runs/'+c.id+'.json'),r=trace.result,task=currentTask(trace.state),all=Object.values(storeOf(trace.state).artifacts);
 if(JSON.stringify(c.queries)!==JSON.stringify(r.queries))throw new Error('Query changed '+c.id);
 modelCalls+=trace.calls.length;
 add('structure',r.checks.understanding);
 const expectedMedia=['image','video'].filter(k=>c.expect[k]);
 if(expectedMedia.length)add('mediaGoal',expectedMedia.every(k=>(task?.goal.tasks||[]).filter(t=>t.output===k).reduce((n,t)=>n+t.count,0)===c.expect[k])&&(task?.goal.tasks||[]).filter(t=>['image','video','audio'].includes(t.output)).every(t=>expectedMedia.includes(t.output)));
 if(task?.executionPlan){let valid=true;try{validateGraph(task);for(const n of task.executionPlan.nodes)if(n.batchId)validatePrepared(task,n,trace.state);}catch{valid=false;}add('planning',valid&&(!expectedMedia.length||r.checks.skillContract===true));}
 for(const call of trace.calls){add('toolIsolation',!call.tools.length);for(const msg of call.input.filter(m=>m.role==='user'&&typeof m.content==='string')){try{const p=JSON.parse(msg.content);if(p.expect||p.expected)throw new Error('Label leak '+c.id);}catch(e){if(e.message.startsWith('Label leak'))throw e;}}checkedCalls++;}
 for(const s of trace.submissions)add('parameters',!!validators[s.tool]?.(s.args));
 const stateValid=trace.snapshots.every(s=>{
  if(s.task?.status==='COMPLETED')return s.task.items.every(item=>s.artifacts.filter(a=>a.itemId===item.id&&a.purpose==='deliverable'&&a.type===item.output&&a.verification.semantic==='passed'&&!a.metadata.simulated).length>=item.count);
  if(s.task?.status==='WAIT_CONFIRM')return !!s.task.approval.planHash&&!!s.task.approval.payload?.items.length;
  return true;
 });add('stateInvariants',stateValid);
 if(c.expect.confirm||c.expect.clarifyConfirm)add('confirmation',r.checks.confirm??r.checks.clarifyConfirm);
 if(c.expect.revision)add('revision',r.checks.revision);
 if(c.expect.fault)add('recovery',r.passed);
 for(const a of all.filter(a=>a.purpose==='deliverable')){if(a.metadata.simulated)mediaArtifacts++;else if(a.type==='text'&&a.verification.semantic==='passed')textArtifacts++;}
 const score=Object.values(r.checks).every(Boolean);if(score!==r.passed)throw new Error('Score mismatch '+c.id);
 if(!r.passed)failures.push(r);audit.push({id:c.id,stateValid});
}
if(modelCalls!==summary.modelCalls||checkedCalls!==modelCalls)throw new Error('Trace coverage mismatch');
const files=(await readdir(new URL('runs/',root))).filter(n=>/^Q\d{4}.json$/.test(n));if(files.length!==1000)throw new Error('Missing traces');
const real=JSON.parse(await readFile(new URL('../data/task-loop-compiled-real-v1/results.json',import.meta.url),'utf8'));
const verification={checkedCases:1000,checkedModelCalls:modelCalls,checkedTraces:files.length,sourceUnchanged:true,expectedLabelsExcluded:true,metrics,mediaArtifacts,textArtifacts,failures:failures.map(r=>r.id),realMedia:{total:real.results.length,passed:real.results.filter(r=>r.passed).length}};
await writeFile(new URL('verification.json',root),JSON.stringify(verification,null,2));
const pct=(p,t)=>(100*p/t).toFixed(1)+'%',link=id=>`[${id}](data/compiled-full-1000-v1/runs/${id}.json)`;
let report=`# 编译运行时：1000 条闭环评测\n\n固定版本原始通过 **${summary.passed}/1000（${pct(summary.passed,1000)}）**。这是真实豆包 + 模拟媒体的自动协议评测，不能作为真实媒体成功率或开放世界准确率。独立真实媒体验证 **${real.results.filter(r=>r.passed).length}/${real.results.length}**。\n\n## 运行信息\n\n- 开始：${summary.startedAt}\n- 结束：${summary.finishedAt}\n- 耗时：${((Date.parse(summary.finishedAt)-Date.parse(summary.startedAt))/60000).toFixed(2)} 分钟\n- 模型：${manifest.model}，并发 ${manifest.concurrency}，实际模型调用 ${modelCalls} 次。\n- 40 个场景族 × 25 个产品变体；1000 个独立会话，部分含多轮输入，不复用其他样例结果。\n- 1000 条完整 trace 和期望隔离已检查；运行期间服务端与评测代码 hash 保持不变。\n- 生产源码 SHA-256：${manifest.sourceHash}\n\n## 分层检查\n\n| 检查 | 通过 / 总数 | 含义 |\n|---|---:|---|\n`;
const labels={structure:['结构化入口','仅格式和入口调用成功，不等于语义准确'],mediaGoal:['媒体目标','媒介、数量无遗漏或额外媒体；仅有明确媒体标签的样例'],planning:['任务规划','任务图完整性与媒体 Skill 合同证据'],toolIsolation:['模型权限','每次模型调用均未获得执行工具'],parameters:['提交参数','所有媒体提交符合实际工具参数 Schema'],stateInvariants:['状态约束','COMPLETED 必须有通过验收的真实产物，确认必须有保存参数'],confirmation:['多轮确认','确认前不生成、缺信息后的义务和身份保留'],revision:['版本修订','新产物存在父版本及版本号'],recovery:['故障恢复','已知拒绝、未知提交和查询超时注入的预期结果']};
for(const [key,m]of Object.entries(metrics))report+=`| ${labels[key][0]} | ${m.passed}/${m.total} | ${labels[key][1]} |\n`;
report+=`\n产物记录：${textArtifacts} 份经模型验收的文字版本，${mediaArtifacts} 个模拟媒体版本。模拟媒体没有真实像素/视频，不做视觉正确率统计。相同模型分别负责理解和验收，仍可能共同漏错。\n\n## 按场景分类\n\n| 场景 | 通过 / 总数 |\n|---|---:|\n`;
for(const [family,v] of Object.entries(summary.byFamily))report+=`| ${family} | ${v.passed}/${v.total} |\n`;
report+='\n## 全部失败样例\n\n';
for(const r of failures)report+=`### ${r.id} · ${r.family}\n\n${r.queries.map((q,i)=>`${i+1}. ${q}`).join('\n')}\n\n状态：${r.status}。失败项：${Object.entries(r.checks).filter(([,v])=>!v).map(([k])=>k).join('、')}。\n\n原因：${r.reason||'需结合状态快照检查'}\n\n${link(r.id)}\n\n`;
report+='## 独立真实媒体验证\n\n';for(const r of real.results)report+=`- ${r.id}：${r.status}，${r.modelCalls} 次模型调用，${(r.durationMs/1000).toFixed(1)} 秒。[真实 trace](data/task-loop-compiled-real-v1/${r.id}.json)。\n`;
report+='\n## 方法限制\n\n原始 passed 聚合检查状态、预期产物数量、必要依赖、确认和版本，不逐字人工评审所有正文；也不能证明所有图像主体、文字或视频镜头正确。场景族复用结构，只替换产品，泛化证据弱于 1000 个独立真实用户需求。先前 200 条意图数据的标签和检查层级不同，分数不可直接比较。\n\n预评测 pilot-v1 原始结果 38/40，未被覆盖。其攻击样例同时出现广告目的与窃密动作，正式集改为明确纯窃密目标；字数验收增加程序计数及一次文字修复。正式集启动前完成这些调整，正式运行中不改实现。\n';
await writeFile(new URL('../COMPILED-1000-EVALUATION-20260910.md',import.meta.url),report);
const followups=[];
for(const tag of ['v2','v3','v4']){
 const location=new URL('../data/compiled-failures-'+tag+'/',import.meta.url),s=JSON.parse(await readFile(new URL('summary.json',location),'utf8')),rows=JSON.parse(await readFile(new URL('results.json',location),'utf8'));
 if(!s.sourceUnchanged||rows.length!==9||rows.some(r=>JSON.stringify(r.queries)!==JSON.stringify(source.find(c=>c.id===r.id).queries)))throw new Error('Follow-up inputs differ');
 for(const r of rows){const trace=JSON.parse(await readFile(new URL('runs/'+r.id+'.json',location),'utf8'));if(trace.calls.some(c=>c.tools.length)||r.passed!==Object.values(r.checks).every(Boolean))throw new Error('Follow-up audit failed');}
 followups.push({tag,total:s.total,passed:s.passed,calls:s.modelCalls,sourceUnchanged:true});
}
const lastReal=JSON.parse(await readFile(new URL('../data/task-loop-compiled-real-v3/real-video.json',import.meta.url),'utf8'));
const lastMedia=Object.values(lastReal.state.taskStore.artifacts).filter(a=>a.purpose==='deliverable'&&a.type==='video'&&!a.metadata.simulated&&a.verification.semantic==='passed');if(lastMedia.length!==1)throw new Error('Missing real video evidence');
await writeFile(new URL('../data/compiled-failures-v4/verification.json',import.meta.url),JSON.stringify({followups,latestPassed:9,latestTotal:9,identicalQueries:true,modelToolsExcluded:true,realFollowup:{mediaArtifacts:1,executions:Object.keys(lastReal.state.taskStore.executions).length,semantic:'passed'}},null,2));
report=report.replace('生产源码 SHA-256','服务端与评测源码联合 SHA-256');
report+=`\n## 原因分析与修复后验证\n\n全量运行后共有9条失败：\n\n1. **4条视频规划失败**：旧分镜资料的逐镜输出影响新Skill，把1条最终视频拆成多个items。修复为每任务专用Schema，items数量精确等于成品数，duration/ratio使用任务常量；所有镜头在同一个视频prompt表达。旧方法作为用户层参考数据提供，不再拼入系统指令。\n2. **3条确认场景失败**：一条把方案和成品识别成2张图，两条在没有目标时先完成说明任务。增加确认Goal合同核验和一次语义修正。后续复测又发现Task ID少一个字符，已增加精确ID校验与结构修复，禁止默默新建任务。\n3. **2条验收结构失败**：验收器返回损坏JSON或不符合Schema。增加一次格式重试，仍不能默认通过。一次复测暴露12字加空格被判13字，已明确中文计数默认排除排版空格及标点。\n\n| 独立复测 | 结果 | 新发现与处理 |\n|---|---:|---|\n| failures-v2 | 8/9 | 字数口径问题 |\n| failures-v3 | 8/9 | Task ID复制截断 |\n| failures-v4 | 9/9 | 同一9条原始Query，新会话重新完整执行，66次模型调用 |\n\n以上没有覆盖或重算原始991/1000。最终实现尚未再次全量跑1000条，不能称为全量100%。[最新复测结果](data/compiled-failures-v4/results.json)与[独立校验](data/compiled-failures-v4/verification.json)均保留。最新复测目录code/保存了当次服务端与评测源码。\n\n**测试113/113通过**，包括旧协议回归、编译协议、HTTP端到端、强制Skill、具体参数确认、篡改拦截、验收阻塞、修复版本、重启未知提交、精确任务引用和中文字数边界；独立性及语法检查通过122个文件。\n\n真实媒体：初版1张图片与1条视频均通过，修复版又生成1条视频并通过实际内容验收。[修复版真实视频trace](data/task-loop-compiled-real-v3/real-video.json)。共1次图片、2次视频成功，不代表复杂多镜头视觉质量已经全面验证。真实媒体脚本的旧submissionCount字段只记录模拟适配器，真实执行数量应查看state.taskStore.executions，不应将其中的0当成没有调用工具。\n\n本地浏览器已验证2个Skill/3个工具显示，以及文字Query → Goal → 执行图 → 正文Artifact → 内容验收的交付。单机持久化与上游临时URL限制仍然存在。\n`;
await writeFile(new URL('../COMPILED-1000-EVALUATION-20260910.md',import.meta.url),report);
console.log(JSON.stringify(verification));
