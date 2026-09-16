import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function representationFor(fields){return fields.some(k=>['directions','shots'].includes(k))?'structured':'content';}
export function canonicalDocument(result,representation,render){
 // Free prose has one authority. Metadata cannot replace or augment its body.
 // Structured workflows request no parallel body; all sections live in structure.
 if(representation==='structured'&&Object.hasOwn(result,'content'))throw Object.assign(new Error('结构文档只能返回完整structure，不能同时生成另一份content正文；所有说明放sections。'),{code:'document_authority'});
 const document=representation==='structured'?{kind:'structured',value:structuredClone(result.structure)}:{kind:'content',value:result.content};
 const content=representation==='structured'?render(document.value):document.value;
 if(typeof content!=='string'||!content.trim())throw new Error('文档正文为空');
 return {...result,content,document,conversion:{authority:representation,sourceHash:digest(document),rendererVersion:representation==='structured'?'structured-v2':'identity-v1',outputHash:digest(content)}};
}
export function acceptanceRecord(verdict,content){
 const checker=verdict.checker||{kind:verdict.evaluationPolicy?'test_stub':'unrecorded'};
 const evaluated=checker.kind==='model'&&checker.phase!=='facts'&&verdict.evaluationPolicy!=='procedure_only_not_quality';
 return {...(verdict.factualAcceptance?{factualAcceptance:structuredClone(verdict.factualAcceptance)}:{}),...(verdict.hardRequirements?{hardRequirements:structuredClone(verdict.hardRequirements)}:{}),...(verdict.constraintChecks?{constraintChecks:structuredClone(verdict.constraintChecks)}:{}),checker,inputHash:digest(content),...(verdict.evaluationPolicy==='delivery_only'?{delivery:{passed:verdict.passed,scope:'presence_and_receipts',policy:'delivery_only'}}:{}),quality:{...verdict,status:evaluated?(verdict.outcome||(verdict.passed?'passed':verdict.uncertain?'uncertain':'failed')):'not_evaluated'},factualSupport:verdict.factualAcceptance?.status==='passed'?'fact_boundary_checked':evaluated?'model_checked':'not_checked'};
}
