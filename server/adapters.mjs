import {readResponseStream} from './response-stream.mjs';
import {modelInput,providerFailure} from './request-boundary.mjs';
import {transportTrace} from './trace-context.mjs';
import { createHash } from 'node:crypto';

export function endpoint(base, suffix) {
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('仅支持 HTTP(S) 接口');
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能含凭据或查询参数');
  return base.replace(/\/$/, '').replace(/\/api\/v3(?:\/responses)?$/, '') + suffix;
}

export class Doubao {
  constructor(config, transport = fetch) { this.config = config; this.fetch = transport; }
  async respond(input, tools, signal, { json = false, singleToolCall = false, maxOutputTokens = 6000, onTextDelta } = {}) {
    const { key, baseUrl, model } = this.config;
    if (!key || !model) throw new Error('请在 .env 配置豆包 API Key 和模型 ID');
    // Output-message envelopes vary by provider; replay assistant text as simple input messages.
    const normalizedInput=modelInput(input,{json});
    if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>6000)throw new Error('Invalid model output token limit');
    const stream=this.config.supportsTextStreaming===true&&typeof onTextDelta==='function'&&!json;
    const callPolicy=singleToolCall && this.config.supportsParallelToolCalls===true ? {parallel_tool_calls:false} : {};
    const started=Date.now();this.lastCall={provider:'doubao',model};
    transportTrace({model,input:normalizedInput,...(tools.length?{tools,tool_choice:'auto',...callPolicy}:{}),...(json?{text:{format:{type:'json_object'}}}:{}),thinking:{type:'disabled'},stream,store:false,max_output_tokens:maxOutputTokens});
    const response = await this.fetch(endpoint(baseUrl, '/api/v3/responses'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input:normalizedInput, ...(tools.length ? { tools,
        tool_choice: 'auto',...callPolicy } : {}),
        ...(json ? {text:{format:{type:'json_object'}}} : {}),
        thinking: { type: 'disabled' }, stream, store: false, max_output_tokens: maxOutputTokens }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    if (!response.ok) {
      const failure=await providerFailure(response,'豆包',key);transportTrace(null,failure.record);throw failure.error;
    }
    const data = stream?await readResponseStream(response,{onTextDelta,signal}):await response.json();transportTrace(null,data);
    this.lastCall={provider:'doubao',model:data.model||model,requestId:data.id,durationMs:Date.now()-started,usage:data.usage||null};
    if (data.error || data.status === 'failed' || data.status === 'incomplete') throw new Error('豆包未完整返回结果，请检查模型配置或输出长度');
    if (!Array.isArray(data.output)) throw new Error('豆包响应缺少 output');
    return data.output.filter(item => ['message', 'function_call'].includes(item.type));
  }
}

export class DeepSeek {
  constructor(config, transport = fetch) { this.config = config; this.fetch = transport; }
  async respond(input, tools, signal, {json = false, singleToolCall = false, maxOutputTokens = 6000, onTextDelta} = {}) {
    const {key, baseUrl, model, reasoningEffort = 'none'} = this.config;
    if (!key || !model) throw new Error('请在 .env 配置 DEEPSEEK_API_KEY 和 DEEPSEEK_MODEL');
    if (!['none','low','high','max'].includes(reasoningEffort)) throw new Error('DeepSeek reasoning effort 无效');
    // Unsupported media/tools must not be silently ignored by the provider.
    for (const item of input) {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!['input_text','output_text','input_image'].includes(part.type)) throw new Error('DeepSeek 当前接口不支持该输入类型：' + part.type);
      }
    }
    if (tools.some(t=>t.type!=='function')) throw new Error('DeepSeek 仅开放已适配的 function 工具');
    const url = new URL(baseUrl);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('DeepSeek 接口地址无效');
    const target = baseUrl.replace(/\/+$/,'').replace(/\/responses$/,'') + '/responses';
    const normalized = modelInput(input,{json});
    if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>6000)throw new Error('Invalid model output token limit');
    const stream=this.config.supportsTextStreaming===true&&typeof onTextDelta==='function'&&!json;
    const callPolicy=singleToolCall && this.config.supportsParallelToolCalls===true ? {parallel_tool_calls:false} : {};
    const started = Date.now(); this.lastCall = {provider:'deepseek',model};
    transportTrace({model,input:normalized,reasoning:{effort:reasoningEffort},max_output_tokens:maxOutputTokens,stream,...(tools.length?{tools,tool_choice:'auto',...callPolicy}:{}),...(json?{text:{format:{type:'json_object'}}}:{})});
    const response = await this.fetch(target, {
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({model,input:normalized,reasoning:{effort:reasoningEffort},max_output_tokens:maxOutputTokens,stream,
        ...(tools.length?{tools,tool_choice:'auto',...callPolicy}:{}),...(json?{text:{format:{type:'json_object'}}}:{})}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(120000)]),
    });
    if (!response.ok) {
      const failure=await providerFailure(response,'DeepSeek',key);transportTrace(null,failure.record);
      this.lastCall={...this.lastCall,durationMs:Date.now()-started,httpStatus:response.status,category:failure.record.category};throw failure.error;
    }
    const data=stream?await readResponseStream(response,{onTextDelta,signal}):await response.json();transportTrace(null,data);
    this.lastCall={provider:'deepseek',model:data.model||model,requestId:data.id,durationMs:Date.now()-started,usage:data.usage||null};
    if(data.error||data.status==='failed'||data.status==='incomplete')throw new Error('DeepSeek 未完整返回结果，请检查输出预算或服务状态');
    if(!Array.isArray(data.output))throw new Error('DeepSeek 响应缺少 output');
    return data.output.filter(item=>['message','function_call'].includes(item.type));
  }
}

export function brainConfig(env=process.env,provider=env.LLM_PROVIDER||'doubao') {
  if(provider==='doubao')return{provider,supportsTextStreaming:env.LLM_TEXT_STREAMING_SUPPORTED==='1',supportsParallelToolCalls:env.LLM_PARALLEL_TOOL_CALLS_SUPPORTED==='1',providerName:'豆包',key:env.DOUBAO_API_KEY,baseUrl:env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',model:env.DOUBAO_CHAT_MODEL};
  if(provider==='deepseek')return{provider,supportsTextStreaming:env.LLM_TEXT_STREAMING_SUPPORTED==='1',supportsParallelToolCalls:env.LLM_PARALLEL_TOOL_CALLS_SUPPORTED==='1',providerName:'DeepSeek',key:env.DEEPSEEK_API_KEY,baseUrl:env.DEEPSEEK_BASE_URL||'https://api.deepseek.com',model:env.DEEPSEEK_MODEL||'deepseek-flash',reasoningEffort:env.DEEPSEEK_REASONING_EFFORT||'none'};
  throw new Error('LLM_PROVIDER 必须为 doubao 或 deepseek');
}

export function createBrain(env=process.env,transport=fetch) {
  const config=brainConfig(env);
  return config.provider==='deepseek'?new DeepSeek(config,transport):new Doubao(config,transport);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function fingerprint(name, args) {
  return createHash('sha256').update(JSON.stringify([name, canonical(args)])).digest('hex');
}
