// Explicit corpus import. Runtime evaluations only read the frozen corpus.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../evaluations/2026-09-16-context-agent/',import.meta.url));
const source=process.argv[2];
if(!source) throw new Error('Usage: node evals/context-agent-freeze.mjs <original benchmark directory>');
const hash=b=>createHash('sha256').update(b).digest('hex');
const evidencePath=join(source,'artifacts/full-analysis-20260916-164756/输入到State证据.json');
const evidenceBytes=await readFile(evidencePath);
const evidence=JSON.parse(evidenceBytes);
const ids=[...new Set(evidence.map(c=>c.caseId))].sort();
if(ids.length!==23)throw new Error(`Expected the original 23-case selection; found ${ids.length}`);
const files=[];
const inputs=new Set();
for(const id of ids){
  const relative=`cases/${id}.json`,bytes=await readFile(join(source,relative)),c=JSON.parse(bytes);
  if(c.id!==id)throw new Error(`Case identity mismatch: ${id}`);
  for(const input of c.required_inputs||[])inputs.add(input);
  const dest=join(root,'fixture',relative);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,bytes);
  files.push({path:relative,sha256:hash(bytes),bytes:bytes.length,caseId:id,expectedSha256:hash(JSON.stringify(c.expected)),semanticResult:'not_run'});
}
// Product records may refer to images not repeated in required_inputs.
for(const relative of [...inputs])if(relative.endsWith('.json')){
  const data=JSON.parse(await readFile(join(source,relative),'utf8'));
  for(const path of data.assets||[])inputs.add(path);
}
for(const relative of [...inputs].sort()){
  const absolute=resolve(source,relative);
  if(!/^inputs\/[a-zA-Z0-9_./-]+$/.test(relative)||relative.includes('..'))throw new Error(`Unsafe input path ${relative}`);
  const bytes=await readFile(absolute),dest=join(root,'fixture',relative);await mkdir(dirname(dest),{recursive:true});await copyFile(absolute,dest);
  files.push({path:relative,sha256:hash(bytes),bytes:bytes.length});
}
const manifest={schemaVersion:1,selection:'Exact case IDs from the supplied 23-case input-to-state evidence; VIDEO_001 and VIDEO_002 were outside that run.',sourceEvidenceSha256:hash(evidenceBytes),caseCount:ids.length,caseIds:ids,files,expectedPolicy:'Original case files and expected fields copied byte-for-byte. Equivalent tool names are interpreted using the original tool_policy; expected is never rewritten.',evidenceKinds:{scripted:'Protocol/capability fixtures, not model understanding evidence',realModel:'not_run',realMedia:'not_run',visualReview:'not_run'}};
await writeFile(join(root,'fixture/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({caseCount:ids.length,files:files.length,output:root}));
