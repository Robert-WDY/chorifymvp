import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createBrain} from '../adapters.mjs';
import {loadAgentCatalog as loadCatalog} from './skills.mjs';
import {assembleAgentTools} from './runtime.mjs';
import {createMediaProvider} from './providers.mjs';
import {createContextServer} from './http.mjs';

const modelEnabled=process.env.CONTEXT_AGENT_ALLOW_MODEL==='1';
const mediaEnabled=process.env.CONTEXT_AGENT_ALLOW_MEDIA==='1';
const mode=mediaEnabled?'live':'simulation';
const integer=(name,fallback,min,max)=>{
  const value=process.env[name]===undefined?fallback:Number(process.env[name]);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${name} 必须是 ${min}–${max} 的整数`);return value;
};
const maxMediaCalls=integer('CONTEXT_AGENT_MAX_MEDIA_CALLS',mediaEnabled?0:4,0,20);
if(mediaEnabled&&(!modelEnabled||!maxMediaCalls))throw new Error('真实媒体需要显式开启模型调用并设置大于 0 的 CONTEXT_AGENT_MAX_MEDIA_CALLS；具体参数仍须用户批准。');
const brain=modelEnabled?createBrain():{config:{model:'未启用'},respond:async()=>{throw new Error('真实模型调用未授权');}};
const catalog=await loadCatalog();
const media=mediaEnabled?createMediaProvider({key:process.env.DOUBAO_API_KEY,baseUrl:process.env.DOUBAO_BASE_URL||'https://ark.cn-beijing.volces.com',imageModel:process.env.DOUBAO_IMAGE_MODEL,videoModel:process.env.DOUBAO_VIDEO_MODEL}):undefined;
// Vision is a separately declared provider capability. Never assume a text model sees URL strings.
const visionEnabled=modelEnabled&&process.env.CONTEXT_AGENT_VISION_ENABLED==='1';
const tools=assembleAgentTools({catalog,media,visionEnabled,visionBrain:visionEnabled?createBrain():undefined,mode,
  observationTokenBudget:integer('CONTEXT_AGENT_OBSERVATION_TOKENS',16000,1000,128000)});
const directory=resolve(process.env.CONTEXT_AGENT_DATA_DIR||fileURLToPath(new URL('../../data/context-agent/',import.meta.url)));
const port=integer('CONTEXT_AGENT_PORT',3212,1024,65535);
const {server,active}=createContextServer({brain,tools,catalog,directory,modelEnabled,mode,agentOptions:{maxSteps:integer('CONTEXT_AGENT_MAX_STEPS',16,1,32),maxModelCalls:integer('CONTEXT_AGENT_MAX_MODEL_CALLS',16,1,64),maxToolCalls:integer('CONTEXT_AGENT_MAX_TOOL_CALLS',48,1,96),contextTokenBudget:integer('CONTEXT_AGENT_CONTEXT_TOKENS',24000,8000,128000),maxMediaCalls}});
server.listen(port,'127.0.0.1',()=>console.log(`Chorify context-agent: http://127.0.0.1:${port} | model=${modelEnabled?'enabled':'disabled'} | media=${mode}`));
const stop=()=>{for(const controller of active.values())controller.abort();server.close(()=>process.exit(0));};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
