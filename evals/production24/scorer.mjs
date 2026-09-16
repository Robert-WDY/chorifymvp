import {isDeepStrictEqual} from 'node:util';
export function score(c,trace){
 const {state,calls=[],submissions=[],snapshots=[],restart}=trace,s=state.taskStore||{},task=s.tasks?.[s.activeTaskId];
 const all=Object.values(s.artifacts||{}),eligible=a=>a.purpose==='deliverable'&&a.verification?.technical==='passed'&&['passed','simulated_passed'].includes(a.verification?.semantic);
 const artifacts=all.filter(a=>a.taskId===task?.id&&eligible(a));
 const counts=Object.fromEntries(['text','image','video'].map(k=>[k,artifacts.filter(a=>a.type===k).length]));
 const checks={understanding:!!task&&!state.events?.some(e=>e.type==='intent_error'),state:(c.expect.states||[(c.expect.image||c.expect.video)?'simulated':'completed']).includes(state.status),modelToolIsolation:calls.every(x=>!x.tools.length)};
 const hard={noFakeMedia:all.filter(a=>a.url&&a.purpose==='deliverable').every(a=>{const e=s.executions?.[a.sourceExecutionId];return !!e&&e.status==='succeeded'&&(e.result?.videoUrl===a.url||e.result?.images?.some(i=>i.url===a.url));}),noFalseCompletion:!['completed','simulated'].includes(state.status)||(!!task?.items.length&&task.items.every(i=>artifacts.filter(a=>a.itemId===i.id&&a.type===i.output).reduce((n,a)=>n+(a.type==='text'?a.metadata?.unitCount||1:1),0)>=i.count)),simulationLabel:!all.some(a=>a.metadata?.simulated)||state.status!=='completed'};
 for(const k of ['text','image','video'])if(c.expect[k])checks[k]=counts[k]===c.expect[k];
 if(c.expect.noMedia)checks.noMedia=submissions.length===0;
 if(c.expect.noVideo)checks.noVideo=submissions.every(x=>x.tool!=='generate_video');
 if(c.expect.maxSubmissions)checks.submissionBudget=submissions.length<=c.expect.maxSubmissions;
 if(c.expect.reference)checks.reference=submissions.some(x=>[...(x.args.referenceImages||[]),x.args.firstFrameUrl].includes(c.expect.reference));
 if(c.expect.duration)checks.duration=c.expect.gap?task?.items.some(i=>i.spec?.durationSeconds===c.expect.duration):submissions.filter(x=>x.tool==='generate_video').every(x=>x.args.duration===c.expect.duration);
 if(c.expect.count)checks.goalCount=task?.items.reduce((n,i)=>n+i.count,0)===c.expect.count||task?.goal.semantic?.deliverables?.reduce((n,i)=>n+i.count,0)===c.expect.count;
 if(c.expect.operations)checks.operation=task?.items.some(i=>c.expect.operations.includes(i.operation));
 if(c.expect.confirm){const first=snapshots[0];checks.confirm=first?.task?.status==='WAIT_CONFIRM'&&first.submissionCount===0;hard.approvalIntegrity=checks.confirm&&!!first.task.approval.planHash&&submissions.length>0&&isDeepStrictEqual(first.task.approval.payload.items,submissions.map(x=>x.args));}
 if(c.expect.clarify)checks.clarify=snapshots[0]?.task?.status==='NEEDS_INPUT'&&snapshots[0].submissionCount===0;
 if(c.expect.sameTask)checks.sameTask=snapshots[0]?.task?.id===task?.id;
 if(c.expect.revision)checks.revision=artifacts.some(a=>a.parentId&&s.artifacts[a.parentId]&&a.version===s.artifacts[a.parentId].version+1);
 if(c.expect.changedGoal)checks.changedGoal=snapshots[0]?.task?.status==='WAIT_CONFIRM'&&snapshots[0].submissionCount===0&&task?.items.every(i=>i.output==='image');
 if(c.expect.independent)checks.independent=task?.items.every(i=>!i.dependsOn.length);
 if(c.expect.dependency){const media=task?.executionPlan?.nodes.find(n=>n.kind==='media');checks.dependency=!!media?.dependsOn.length&&media.dependsOn.every(id=>submissions.every(x=>x.completedItemIds.includes(id)));checks.consumedSource=artifacts.filter(a=>a.type==='text').some(a=>calls.some(call=>call.input.some(m=>{try{const p=JSON.parse(m.content);return Array.isArray(p.methodReferences)&&p.sources?.some(source=>source.content===a.content);}catch{return false;}})));}
 if(c.expect.fault==='unknown')hard.noUnknownRetry=submissions.length===1&&Object.values(s.executions||{}).some(e=>e.status==='unknown');
 if(c.expect.fault)checks.faultTriggered=trace.provider.faults.some(f=>f===c.expect.fault);
 if(c.expect.restart)checks.restart=!!restart?.killed&&restart.beforePid!==restart.afterPid&&restart.taskId===task?.id&&Object.values(s.executions||{}).some(e=>e.providerTaskId===restart.providerTaskId)&&submissions.length===1;
 if(c.expect.anyOutcome)checks.goalOrClarification=state.status==='needs_input'?!!task?.goal.missingInputs?.length:counts.video>0;
 if(submissions.length){checks.skillContract=submissions.every(x=>x.skillArtifactId&&s.artifacts[x.skillArtifactId]?.metadata.structure);checks.parameters=submissions.every(x=>!!x.args.prompt&&(x.tool!=='generate_video'||Number.isInteger(x.args.duration)&&x.args.duration>=2&&x.args.duration<=12));}
 const passed=Object.values(checks).every(Boolean)&&Object.values(hard).every(Boolean);
 return{id:c.id,name:c.name,status:state.status,passed,checks,hard,counts,modelCalls:calls.length,submissions:submissions.length,classification:c.expect.gap?(passed?'capability_gap_handled':'capability_gap_mishandled'):passed?(['simulated','completed'].includes(state.status)?'flow_completed':'safely_stopped'):'failed',realMediaArtifacts:0,reason:task?.reason||state.events?.findLast(e=>e.type==='intent_error')?.error};
}
