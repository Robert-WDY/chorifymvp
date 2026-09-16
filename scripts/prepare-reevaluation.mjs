import fs from 'node:fs';
const out='data/user-multiturn-reeval-20260914';
if(fs.existsSync(out+'/run-manifest.json'))throw Error('Existing evaluation must not be overwritten');
let s=fs.readFileSync('scripts/eval-user-multiturn-20260914.mjs','utf8').replace("path.resolve('data/user-multiturn-eval-20260914')","path.resolve('data/user-multiturn-reeval-20260914')");
s=s.replace("const files=audit.files.map(f=>({path:f.path,sha256:hash(fs.readFileSync(f.path))}));","const sourcePaths=[...new Set([...audit.files.map(f=>f.path),...fs.readdirSync('server').filter(f=>f.endsWith('.mjs')).map(f=>'server/'+f)])];const files=sourcePaths.map(p=>({path:p,sha256:hash(fs.readFileSync(p))}));");
fs.writeFileSync('scripts/reeval-user-multiturn-20260914.mjs',s);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/runner.executed.mjs',s);
