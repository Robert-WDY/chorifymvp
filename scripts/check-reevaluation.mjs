import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const dir='data/user-multiturn-reeval-20260914';
const files=fs.readdirSync(dir).filter(f=>fs.statSync(dir+'/'+f).isFile());
const secretValues=fs.readFileSync('.env','utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^\s*([A-Z_]*(?:KEY|TOKEN|SECRET))\s*=\s*(.*?)\s*$/);return m&&m[2].length>12?[m[2].replace(/^['"]|['"]$/g,'')]:[];});
const leaked=[],broken=[];for(const f of files){const text=fs.readFileSync(dir+'/'+f,'utf8');if(secretValues.some(v=>text.includes(v))||/\bsk-[\w-]{20,}\b/.test(text))leaked.push(f);if(f.endsWith('.md'))for(const m of text.matchAll(/\]\(<([^>]+)>\)/g)){const ref=m[1].replace(/:\d+$/,'');if(!fs.existsSync(ref))broken.push(ref);}}
const r=JSON.parse(fs.readFileSync(dir+'/评测结果.json'));const manifest=JSON.parse(fs.readFileSync(dir+'/run-manifest.json'));const changed=manifest.sourceFiles.filter(f=>createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256).map(f=>f.path);
const result={at:new Date().toISOString(),credentialLeakFiles:leaked,brokenLinks:broken,productionChanged:changed,turns:r.results.length,uniqueTurnKeys:new Set(r.results.map(x=>x.caseId+'-'+x.turn)).size,traceFilesExist:r.results.filter(x=>x.startedAt).every(x=>fs.existsSync(dir+'/'+x.traceFile)),outputFiles:files.map(f=>({file:f,bytes:fs.statSync(dir+'/'+f).size,sha256:createHash('sha256').update(fs.readFileSync(dir+'/'+f)).digest('hex')}))};
fs.writeFileSync(dir+'/交付检查.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,outputFiles:result.outputFiles.length}));if(leaked.length||broken.length||changed.length||result.turns!==136)process.exitCode=1;
