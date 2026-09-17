// Local full-evidence export for review/rollback. No models, no remote access.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HistoryStore,baselineSnapshot } from '../server/context-agent/history.mjs';
const [directory, owner, sessionId, output,baselineOutput] = process.argv.slice(2);
if (!directory || !owner || !sessionId || !output) throw new Error('Usage: node evals/context-agent-export.mjs <data-directory> <owner> <session-id> <new-full-output.json> [new-a4220e1-compatible-output.json]');
const data=await new HistoryStore(resolve(directory)).exportSession(sessionId,owner);
await writeFile(resolve(output),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
if(baselineOutput)await writeFile(resolve(baselineOutput),JSON.stringify(baselineSnapshot(data),null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output:resolve(output),baselineOutput:baselineOutput?resolve(baselineOutput):null,records:data.records.length,assets:Object.keys(data.assets).length,summaries:Object.keys(data.summaries||{}).length,note:baselineOutput?'Baseline copy retains observations as runtime evidence; keep full export and original SQLite for complete restoration.':undefined}));
