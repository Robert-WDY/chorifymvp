import { createTools } from './tools.mjs';
import { createImageObserver } from './providers.mjs';

/** Shared service/evaluation assembly. No configuration reads or provider calls. */
export function assembleAgentTools({ catalog, mode = 'simulation', media, visionEnabled = false, visionBrain, observationTokenBudget = 16000 } = {}) {
  if (visionEnabled && typeof visionBrain?.respond !== 'function') throw new Error('Vision requires an explicitly configured model adapter');
  const observeImages = visionEnabled ? createImageObserver(visionBrain) : undefined;
  return createTools({ catalog, mode, media, observeImages, observationTokenBudget });
}
