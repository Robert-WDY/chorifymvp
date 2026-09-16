import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {redact} from '../server/trace-context.mjs';
const [source,target]=process.argv.slice(2);if(!source||!target)throw new Error('Usage: node scripts/export-trace-json.mjs source.json target.json');
const raw=await readFile(source,'utf8'),parsed=JSON.parse(raw),state=parsed.state||parsed;
const output={formatVersion:2,sessionId:state.id,exportedAt:new Date().toISOString(),sourceSha256:createHash('sha256').update(raw).digest('hex'),completeness:{modelCallsAvailable:!!state.modelCalls?.length,recordedModelCalls:state.modelCalls?.length||0,notes:['模型调用包含实际输入、工具Schema、适配后的请求、原始输出、解析接受/拒绝和提供方usage（已记录时）。','旧会话未记录的调用不能事后补回；仅保存脱敏前存在的字段，不补造原始信息。','API密钥和URL查询参数已脱敏；业务正文、方法、事件和状态不截断。','模拟媒体只证明调度及结构合同，不证明视觉质量。']},turns:state.turns||[],modelCalls:state.modelCalls||[],businessEvents:state.events,taskStore:state.taskStore,messages:state.messages,finalTurn:state.lastTurn};
await writeFile(target,JSON.stringify(redact(output),null,2));console.log(JSON.stringify({file:target,calls:output.modelCalls.length,turns:output.turns.length,events:output.businessEvents?.length}));
