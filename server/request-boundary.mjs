import {redact} from './trace-context.mjs';

export function modelInput(input,{json=false}={}){
 const normalized=input.map(item=>item.type==='message'&&item.role==='assistant'
  ?{role:'assistant',content:(item.content||[]).filter(p=>p.type==='output_text').map(p=>p.text).join('\n')}:structuredClone(item));
 const hasJson=normalized.some(m=>/json/i.test(typeof m.content==='string'?m.content:(m.content||[]).map(p=>p.text||'').join('\n')));
 if(json&&!hasJson)normalized.unshift({role:'system',content:'仅输出合法 JSON 对象。'});
 return normalized;
}
export async function providerFailure(response,provider,key){
 let body;try{body=await response.json();}catch{body={error:{message:'提供方未返回 JSON 错误体'}};}
 const scrub=value=>redact(typeof value==='string'&&key?value.split(key).join('[REDACTED_KEY]'):value);
 const safe=redact(JSON.parse(JSON.stringify(body,(_k,v)=>typeof v==='string'?scrub(v):v)));
 const code=String(safe.error?.code||safe.error?.type||'http_error');
 const category=/overdue|balance|credit|quota|insufficient/i.test(code)?'billing':response.status===401||response.status===403?'authentication':response.status===429?'rate_limit':response.status>=500?'provider_unavailable':'request_protocol';
 const detail=String(safe.error?.message||'请求未被接受');
 return {record:{httpStatus:response.status,requestId:response.headers.get('x-request-id'),body:safe,category},error:Object.assign(new Error(`${provider} 请求失败 HTTP ${response.status} [${category}/${code}]：${category==='billing'?'账户欠费或额度不足；':''}${detail}`),{code,category,httpStatus:response.status,repairTarget:'transport',retryable:false})};
}
