import {score as baseScore} from '../production24/scorer.mjs';
export function score(c,trace){
 const result=baseScore(c,trace),s=trace.state.taskStore||{},task=s.tasks?.[s.activeTaskId],artifacts=Object.values(s.artifacts||{}).filter(a=>a.taskId===task?.id&&a.purpose==='deliverable'&&['passed','simulated_passed'].includes(a.verification?.semantic));
 if(c.expect.text)result.checks.text=artifacts.some(a=>a.type==='text');
 if(c.expect.missing)result.checks.missing=task?.status==='NEEDS_INPUT'&&!!task.goal.missingInputs?.length;
 if(c.expect.waitConfirm)result.checks.waitConfirm=task?.status==='WAIT_CONFIRM'&&!!task.approval?.planHash&&!!task.approval?.payload;
 if(c.expect.flexibleUnits)result.checks.units=task?.status==='NEEDS_INPUT'?!!task.goal.missingInputs?.length:task?.items.every(i=>i.output==='text')?artifacts.some(a=>a.type==='text'):task?.items.reduce((n,i)=>n+i.count,0)===c.expect.flexibleUnits;
 result.passed=Object.values(result.checks).every(Boolean)&&Object.values(result.hard).every(Boolean)&&!trace.harnessError;
 result.classification=!result.passed?'failed':c.expect.gap?'capability_gap_handled':task?.status==='WAIT_CONFIRM'?'awaiting_confirmation':task?.status==='NEEDS_INPUT'?'missing_fixture_or_input':['completed','simulated'].includes(trace.state.status)?'flow_completed':'safely_stopped';
 result.level=c.level;result.originalGoalLabel=c.original.expected.goal.type;result.originalLabelsExecutable=false;
 result.originalFixtureGap=!!c.expect.missing;
 return result;
}
