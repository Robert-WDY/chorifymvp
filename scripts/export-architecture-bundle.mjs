import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,basename} from 'node:path';
import {redact} from '../server/trace-context.mjs';
const [target,...directories]=process.argv.slice(2);
if(!target||!directories.length)throw new Error('Usage: export-architecture-bundle.mjs target.json directory...');
const sha=raw=>createHash('sha256').update(raw).digest('hex'),scenarios=[],codeManifest=[];
for(const directory of directories)for(const file of (await readdir(directory)).filter(f=>f.endsWith('.json'))){
 const path=resolve(directory,file),raw=await readFile(path,'utf8'),data=JSON.parse(raw);
 scenarios.push({iteration:basename(directory),scenario:file.slice(0,-5),source:path,sourceSha256:sha(raw),...data});
}
for(const file of (await readdir('server')).filter(f=>f.endsWith('.mjs'))){const raw=await readFile('server/'+file);codeManifest.push({path:'server/'+file,sha256:sha(raw)});}
const bundle={formatVersion:3,exportedAt:new Date().toISOString(),notes:['包含每个场景保存的完整模型调用、实际输入、工具Schema、提供方输出、被拒绝草稿、事件、任务合同、修订、方法输入输出、产物、最后回答与提交记录。','目录是不同开发版本的轮次，不能把合并通过率当作同一版本的统计结论。codeManifest只标识导出时的代码。','真实DeepSeek文字调用；媒体外部服务使用模拟返回；创意内容验收器放行，不评画面质量和最终营销效果。','密钥及URL查询参数脱敏，业务上下文不截断；历史未记录的信息不补造。'],codeManifest,scenarios};
const output=JSON.stringify(redact(bundle),null,2);await writeFile(target,output);
console.log(JSON.stringify({file:resolve(target),scenarios:scenarios.length,modelCalls:scenarios.reduce((n,s)=>n+(s.state.modelCalls?.length||0),0),bytes:Buffer.byteLength(output)}));
