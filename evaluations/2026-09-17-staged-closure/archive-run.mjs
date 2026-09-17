// Copy reviewable full exports, never private SQLite stores or credentials.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [sourceArg,targetArg,envFile]=process.argv.slice(2);
if(envFile)process.loadEnvFile(envFile);
const source=path.resolve(sourceArg),target=path.resolve(targetArg);
if(fs.existsSync(target))throw new Error('Archive already exists');
const secretValues=Object.entries(process.env).filter(([k,v])=>/KEY|SECRET|TOKEN|PASSWORD/i.test(k)&&v.length>=16).map(([,v])=>v);
const files=[];
function collect(dir,relative=''){
 for(const f of fs.readdirSync(dir,{withFileTypes:true})){
  if(f.name==='storage')continue;
  const name=path.join(relative,f.name),file=path.join(dir,f.name);
  if(f.isDirectory()){collect(file,name);continue;}
  if(!/\.(json|txt)$/.test(f.name))continue;
  const content=fs.readFileSync(file,'utf8');
  if(secretValues.some(s=>content.includes(s)))throw new Error('Credential found in export: '+name);
  if(/Bearer\s+[A-Za-z0-9_\-.]{16,}/.test(content))throw new Error('Bearer value found: '+name);
  files.push({name,content,sha256:createHash('sha256').update(content).digest('hex')});
 }
}
collect(source);
for(const f of files){fs.mkdirSync(path.dirname(path.join(target,f.name)),{recursive:true});fs.writeFileSync(path.join(target,f.name),f.content);}
fs.writeFileSync(path.join(target,'archive-manifest.json'),JSON.stringify({files:files.map(({name,sha256})=>({name,sha256})),credentialScan:'configured key/token/password values absent; transport contains bodies without authorization headers',excluded:'Private SQLite storage; complete exported state and trace preserved'},null,2)+'\n');
console.log(JSON.stringify({files:files.length,bytes:files.reduce((n,f)=>n+Buffer.byteLength(f.content),0),target}));
