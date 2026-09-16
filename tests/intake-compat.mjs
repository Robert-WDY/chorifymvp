import {understandGoal as current} from '../server/intent.mjs';
// Captured legacy response tests only; this adapter does not reinterpret output.
export const understandGoal=(brain,catalog,input,signal)=>current(brain,catalog,{...input,legacyReplay:true},signal);
