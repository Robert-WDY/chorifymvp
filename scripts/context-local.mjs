// Only this checkout's private config is read. Never source another project's env.
import {readFile,mkdir,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import {parseEnv} from 'node:util';
const root=fileURLToPath(new URL('../',import.meta.url));
const repo=await realpath(root);
const withinRepo=path=>{const part=relative(repo,path);return part&&!part.startsWith('..')&&!isAbsolute(part);};
const configFile=await realpath(new URL('../.env.local',import.meta.url));
if(!withinRepo(configFile))throw new Error('Local config must remain inside this checkout');
const config=parseEnv(await readFile(configFile,'utf8'));
const allowed=/^(LLM_|DEEPSEEK_|DOUBAO_|CONTEXT_AGENT_)/;
for(const key of Object.keys(process.env))if(allowed.test(key)||['PORT','MVP_DATA_DIR','NODE_PATH','NODE_OPTIONS'].includes(key))delete process.env[key];
for(const [key,value]of Object.entries(config))if(allowed.test(key))process.env[key]=value;
const directory=resolve(root,'data/isolated-local');
await mkdir(directory,{recursive:true});
const actual=await realpath(directory);
if(!withinRepo(actual))throw new Error('Local data must remain inside this checkout');
// These are deployment identities, not values inherited from another service.
process.env.CONTEXT_AGENT_PORT='3217';
process.env.CONTEXT_AGENT_DATA_DIR=actual;
process.chdir(root);
if(process.argv.includes('--check')){
 console.log(JSON.stringify({root:repo,entry:resolve(root,'server/context-agent/index.mjs'),port:3217,host:'127.0.0.1',dataDirectory:actual,configFile:resolve(root,'.env.local'),modelEnabled:process.env.CONTEXT_AGENT_ALLOW_MODEL==='1',mediaEnabled:process.env.CONTEXT_AGENT_ALLOW_MEDIA==='1',visionEnabled:process.env.CONTEXT_AGENT_VISION_ENABLED==='1'}));
}else await import('../server/context-agent/index.mjs');
