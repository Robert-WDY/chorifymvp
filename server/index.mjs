import {validateTextInputs} from './request-input.mjs';
import {capabilitySnapshot} from './runtime-facts.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {resolve} from 'node:path';
import { Doubao, createBrain, brainConfig } from './adapters.mjs';
import { ArkMedia } from './media.mjs';
import { ToolRuntime } from './tools.mjs';
import { loadCatalog } from './catalog.mjs';
import { Agent } from './agent.mjs';
import { hasPendingTasks, refreshTasks } from './task-monitor.mjs';
import {SessionStore,messageText} from './session-store.mjs';
import {Verifier} from './verification.mjs';
import {taskSnapshot,storeOf,clientStatus} from './task-state.mjs';
import {mediaSkills,publicTools} from './media-skill-contracts.mjs';
import {runtimeVersion} from './runtime-version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const build=await runtimeVersion(root);
const dataDirectory=resolve(process.env.MVP_DATA_DIR||root+'data');
const port = Number(process.env.PORT || 3210);
const secret = randomBytes(32).toString('hex');
const catalog = await loadCatalog();
const brain = createBrain();
const videoBrain = brain.config.provider==='deepseek'?new Doubao(brainConfig(process.env,'doubao')):brain;
const media = new ArkMedia({ key: process.env.DOUBAO_API_KEY, baseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com',
  imageModel: process.env.DOUBAO_IMAGE_MODEL, videoModel: process.env.DOUBAO_VIDEO_MODEL });
const runtime = new ToolRuntime({ catalog, brain, media, python: process.env.PYTHON_BIN });
const active = new Map();
const monitoring = new Set();
await mkdir(dataDirectory, { recursive: true });
const sessions=new SessionStore(dataDirectory);
const verifier=new Verifier(brain,{videoBrain,policy:process.env.RESULT_ACCEPTANCE||'delivery_only'});
const pathFor = id => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('会话 ID 无效');
  return dataDirectory + `/${id}.json`;
};
const save = state => sessions.save(state);
const agent = new Agent({ brain, runtime, catalog, save, verifier, actionMode:process.env.BUSINESS_ACTION_MODE||'core', maxSteps: Math.max(2, Math.min(32, Number(process.env.MAX_AGENT_STEPS) || 16)) });
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 65536) throw new Error('请求超过 64KB'); }
  return JSON.parse(data || '{}');
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: '仅允许本地访问' });
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, {
      csrf: secret, model: brain.config.model || '未配置模型', provider:brain.config.provider, providerName:brain.config.providerName, brainReady: !!brain.config.key,
      dataDirectoryId:createHash('sha256').update(process.platform==='win32'?dataDirectory.toLowerCase():dataDirectory).digest('hex'),
      videoVerificationModel:videoBrain.config.model,
      resultAcceptancePolicy:verifier.policy,
      businessActionMode:agent.actionMode,
      runtimeContractVersion:'intent-requirements-v2',
      mediaSubmissionPolicy:agent.effectPolicy,
      finalResponseMode:{production:'saved_artifact_projection',query:'model'},
      finalResponseComposer:true,
      runtimeVersion:await build.inspect(),
      capabilities: {...runtime.capabilities(),registry:capabilitySnapshot(runtime,catalog),tools:publicTools,services:{},protocol:'compiled-v1'},
      skills: catalog.skills.map(({slug,name,description}) => ({slug,name,description})),
    });
    if(req.method==='GET'&&url.pathname==='/api/sessions'){
      const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||50),query=url.searchParams.get('q')||'';
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200||query.length>200)return json(res,400,{error:'历史记录查询参数无效'});
      const history=await sessions.list({query,offset,limit});
      history.sessions=history.sessions.map(s=>({...s,status:active.has(s.id)?'running':s.status==='running'?'interrupted':s.status}));
      return json(res,200,history);
    }
    if (req.method === 'POST') {
      if (req.headers['x-mvp-token'] !== secret) return json(res, 403, { error: '请刷新页面后重试' });
      const data = await body(req);
      if (url.pathname === '/api/cancel') {
        active.get(data.sessionId)?.abort();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/chat'||url.pathname==='/api/task/continue') {
        const resuming=url.pathname==='/api/task/continue';
        if (!resuming&&(typeof data.message !== 'string' || !data.message.trim() || data.message.length > 30000)) return json(res, 400, { error: '请输入 1–30000 字需求' });
        try{validateTextInputs(data.inputs||[]);}catch(error){return json(res,400,{error:error.message});}
        if(data.requestId)pathFor(data.requestId);
        const id = data.sessionId || data.requestId || randomUUID();
        pathFor(id);
        if (active.has(id)||monitoring.has(id)) return json(res, 409, { error: '当前会话正在执行或更新任务进度，请稍后重试' });
        const controller = new AbortController();
        active.set(id, controller);
        let state = { id, messages: [], actions: {}, events: [] };
        if (data.sessionId) {
          try { state = await sessions.load(id); }
          catch { active.delete(id); return json(res, 404, { error: '会话不存在，请新建任务' }); }
        }
        if(!data.sessionId&&data.requestId){try{state=await sessions.load(id);}catch{ /* First request with this id creates the session. */ }}
        const task=resuming?taskSnapshot(state,storeOf(state).tasks[data.taskId]):taskSnapshot(state);
        if(resuming&&(!task||task.id!==data.taskId||!task.actions.canResume)){active.delete(id);return json(res,400,{error:'没有匹配的可继续任务'});}
        if(resuming&&task.status==='WAIT_CONFIRM'&&task.approval.planHash!==data.planHash){active.delete(id);return json(res,409,{error:'确认方案已变化，请刷新重试'});}
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15000);
        try { await agent.run(state, resuming?'继续任务':data.message.trim(), event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); }, controller.signal,resuming?{resumeTaskId:data.taskId,planHash:data.planHash,requestId:data.requestId,runtimeVersion:build.loaded}:{requestId:data.requestId,inputs:data.inputs||[],replyTo:typeof data.replyTo==='string'?data.replyTo:null,runtimeVersion:build.loaded}); }
        finally { clearInterval(heartbeat); active.delete(id); res.end(); }
        return;
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
      const id = url.pathname.slice('/api/session/'.length);
      const state = await sessions.load(id,{recover:!active.has(id)&&!monitoring.has(id)});
      return json(res, 200, { id, pendingTasks:hasPendingTasks(state), status: clientStatus(state,{running:active.has(id),monitoring:monitoring.has(id)}),
        events: state.events||[], task:taskSnapshot(state),artifacts:Object.values(storeOf(state).artifacts),tasks:Object.values(storeOf(state).tasks).map(t=>({id:t.id,status:t.status,query:t.query,parentTaskId:t.parentTaskId})),users: (state.messages||[]).filter(x => x.role === 'user').map(messageText),messages:(state.messages||[]).filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:messageText(m)})) });
    }
    if(req.method==='GET'&&/^\/media\/[a-f0-9-]{36}\.(mp3|wav)$/.test(url.pathname)) {
      const audio=await readFile(root+'data'+url.pathname);
      res.writeHead(200,{'Content-Type':url.pathname.endsWith('.wav')?'audio/wav':'audio/mpeg','Content-Length':audio.length,'Cache-Control':'private, max-age=3600'});res.end(audio);return;
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/reply-view.js': ['reply-view.js', 'text/javascript'], '/fact-display.js': ['fact-display.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const file = files[url.pathname];
    if (req.method === 'GET' && file) { res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }); res.end(await readFile(root + 'dist/' + file[0])); return; }
    json(res, 404, { error: '不存在的接口' });
  } catch { if (!res.headersSent) json(res, 400, { error: '请求失败，请检查输入或本地服务状态' }); else res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Creative Agent: http://127.0.0.1:${port}`));
let sweeping=false;
setInterval(async()=>{
  if(sweeping)return;sweeping=true;
  try {
    for(const filename of await readdir(dataDirectory)) {
      if(!/^[a-f0-9-]{36}\.json$/.test(filename))continue;
      const id=filename.slice(0,-5);if(active.has(id)||monitoring.has(id))continue;
      monitoring.add(id);
      try {
        const state=await sessions.load(id);
        if(!hasPendingTasks(state))continue;
        if(state.status==='running')state.status='waiting';
        if(await refreshTasks(state,runtime,AbortSignal.timeout(60000),{verifier,save,resume:async(s,taskId)=>{
          const controller=new AbortController();active.set(id,controller);
          try{await new Agent({brain,runtime,catalog,verifier,save}).run(s,'继续已授权任务',()=>{},AbortSignal.any([controller.signal,AbortSignal.timeout(360000)]),{resumeTaskId:taskId,runtimeVersion:build.loaded});}finally{active.delete(id);}
        }}))await save(state);
      } catch {} finally {monitoring.delete(id);}
    }
  } finally {sweeping=false;}
},5000).unref();
