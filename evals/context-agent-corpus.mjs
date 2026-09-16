import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

export const corpusRoot=fileURLToPath(new URL('../evaluations/2026-09-16-context-agent/fixture/',import.meta.url));
export const sha256=value=>createHash('sha256').update(value).digest('hex');
export async function loadCorpus(root=corpusRoot){
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  if(manifest.caseCount!==23||new Set(manifest.caseIds).size!==23)throw new Error('The original 23-case selection was changed');
  const cases=[];
  for(const file of manifest.files){
    if(file.path.includes('..')||file.path.startsWith('/'))throw new Error('Unsafe corpus path');
    const bytes=await readFile(join(root,file.path));
    if(sha256(bytes)!==file.sha256)throw new Error(`Frozen input changed: ${file.path}`);
    if(file.caseId){
      const c=JSON.parse(bytes);
      if(c.id!==file.caseId||sha256(JSON.stringify(c.expected))!==file.expectedSha256)throw new Error(`Original expected changed: ${file.path}`);
      cases.push(c);
    }
  }
  if(cases.length!==23||cases.some(c=>!manifest.caseIds.includes(c.id)))throw new Error('Missing original case');
  return {root,manifest,cases};
}

export function pendingReport(corpus){
  return {schemaVersion:1,engine:'context-agent',validation:'corpus_integrity_only',caseCount:corpus.cases.length,results:corpus.cases.map(c=>({caseId:c.id,queryCount:(c.setup_turns||[]).length+c.conversation.length,originalExpectedSha256:sha256(JSON.stringify(c.expected)),realModel:'not_run',realMedia:'not_run',visualReview:'not_run',businessAcceptance:'not_run',reason:'No newly authorized real model/media evaluation. Scripted protocol tests cannot determine this case\'s semantic acceptance.'})),caveat:'A normal loop return, valid tool arguments, and successful simulated receipts are not business or visual acceptance.'};
}
