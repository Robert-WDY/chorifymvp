import { createTools } from './tools.mjs';
import { createImageObserver } from './providers.mjs';
import { memoryOptions } from './memory.mjs';
import {createBrain} from '../adapters.mjs';

export function createVisionBrain(env=process.env,transport=fetch){
 const provider=env.CONTEXT_AGENT_VISION_PROVIDER;
 if(!['doubao','deepseek'].includes(provider))throw new Error('视觉通道需要独立指定 CONTEXT_AGENT_VISION_PROVIDER');
 return createBrain({...env,LLM_PROVIDER:provider,LLM_TEXT_STREAMING_SUPPORTED:'0',LLM_PARALLEL_TOOL_CALLS_SUPPORTED:'0',...(env.CONTEXT_AGENT_VISION_MODEL?{[provider==='doubao'?'DOUBAO_CHAT_MODEL':'DEEPSEEK_MODEL']:env.CONTEXT_AGENT_VISION_MODEL}:{})},transport);
}

export function assembleMemoryOptions(env={}) {
  const number=(key,fallback)=>env[key]===undefined?fallback:Number(env[key]);
  return memoryOptions({enabled:env.CONTEXT_AGENT_SUMMARY_ENABLED!=='0',triggerRatio:number('CONTEXT_AGENT_SUMMARY_TRIGGER',0.75),targetRatio:number('CONTEXT_AGENT_SUMMARY_TARGET',0.55),
    summaryMaxTokens:number('CONTEXT_AGENT_SUMMARY_TOKENS',1800),inputMaxTokens:number('CONTEXT_AGENT_SUMMARY_INPUT_TOKENS',8000),
    maxCallsPerTurn:number('CONTEXT_AGENT_SUMMARY_MAX_CALLS',2),reserveMainCalls:number('CONTEXT_AGENT_SUMMARY_RESERVE_CALLS',2),safetyTokens:number('CONTEXT_AGENT_CONTEXT_SAFETY_TOKENS',500)});
}

/** Shared service/evaluation assembly. No configuration reads or provider calls. */
export function assembleAgentTools({ catalog, mode = 'simulation', media, visionEnabled = false, visionBrain, observationTokenBudget = 16000 } = {}) {
  if (visionEnabled && typeof visionBrain?.respond !== 'function') throw new Error('Vision requires an explicitly configured model adapter');
  const observeImages = visionEnabled ? createImageObserver(visionBrain) : undefined;
  return createTools({ catalog, mode, media, observeImages, observationTokenBudget });
}
