import { createTools } from './tools.mjs';
import { createImageObserver } from './providers.mjs';
import { memoryOptions } from './memory.mjs';

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
