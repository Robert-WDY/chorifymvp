import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
const root=process.argv[2]||'data', destination=process.argv[3]||'data/context-audit-20260911';
const groups={},findings=[];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){
 const p=join(dir,e.name);if(e.isDirectory()){if(!['code','sessions','node_modules'].includes(e.name))await walk(p);continue;}
 if(e.name!=='trace.json'&&!(dir.endsWith('runs')&&e.name.endsWith('.json')))continue;
 let t;try{t=JSON.parse(await readFile(p,'utf8'));}catch{continue;}if(!Array.isArray(t.calls))continue;
 const run=relative(root,p).split(/[\\/]/)[0],g=groups[run]??={traces:0,calls:0,stages:{},flags:{}};g.traces++;
 for(const [index,c] of t.calls.entries()){
  if(!Array.isArray(c.input))continue;g.calls++;const system=c.input.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  const stage=system.includes('需求理解器')?'understand':system.includes('能力选择器')?'route':system.includes('实际媒体文件数量')?'budget':system.includes('Goal合同校验器')?'audit':system.includes('必须执行的媒体Skill')?'media':system.includes('完成当前文字交付')?'text':system.includes('任务交付验证器')?'verify':'other';
  const s=g.stages[stage]??={calls:0,totalChars:0,maxChars:0};const chars=JSON.stringify(c.input).length;s.calls++;s.totalChars+=chars;s.maxChars=Math.max(s.maxChars,chars);
  let payload;try{payload=JSON.parse(c.input.find(m=>m.role==='user')?.content);}catch{}
  const flags=[];
  if(payload?.methodReferences?.some(m=>/前序已锁定|格号锚点|每镜.*格/.test(m.content||'')))flags.push('legacy_anchor_in_context');
  if(payload?.taskSnapshot?.items?.some(i=>i.methods?.some(m=>m.input)))flags.push('intake_contains_execution_method_inputs');
  if(stage==='text'&&payload?.prior?.length)flags.push('text_receives_all_prior_artifacts');
  if(/结构或合同校验失败|系统格式\/一致性校验反馈|审核输出格式无效/.test(system))flags.push('retry');
  if(c.error)flags.push('api_error');
  let output;try{output=JSON.parse(c.output.filter(m=>m.type==='message').flatMap(m=>m.content||[]).map(m=>m.text||'').join('\n'));}catch{}
  if(output?.consistent===false)flags.push('goal_audit_rejected');
  if(output?.passed===false)flags.push('verification_rejected');
  for(const f of flags)g.flags[f]=(g.flags[f]||0)+1;
  if(flags.some(f=>['retry','goal_audit_rejected','api_error','verification_rejected'].includes(f)))findings.push({path:p,call:index,stage,flags,feedback:system.split('\n').filter(x=>/校验失败|校验反馈|格式无效/.test(x)),issues:output?.issues,error:c.error});
 }
}}
await walk(root);await mkdir(destination,{recursive:true});await writeFile(join(destination,'audit.json'),JSON.stringify({groups,findings},null,2));console.log(JSON.stringify({groups,findings:findings.length},null,2));
