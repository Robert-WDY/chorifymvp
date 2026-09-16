import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {renderStage} from '../server/text-stage.mjs';
const directory='data/real-media-query-audit-20260911';
const original=JSON.parse(await readFile(directory+'/747-original-trace.json'));
const parse=c=>JSON.parse(c.output.flatMap(m=>m.content||[]).map(p=>p.text||'').join(''));
const scriptCall=original.calls.find(c=>c.methodId==='video-script-zh-v1'),output=parse(scriptCall),rendered=renderStage(output.structure);
const proofs=[];
function prove(name,check,evidence){check();proofs.push({name,reproduced:true,evidence});}
prove('结构化重建删除模型已返回的视频规格',()=>{assert.ok(output.content.includes('## 视频规格'));assert.ok(!rendered.includes('视频规格'));},{callId:scriptCall.id,rawContentCharacters:output.content.length,renderedCharacters:rendered.length});
prove('结构化重建删除模型已返回的分镜表',()=>{assert.ok(output.content.includes('| 镜号 |'));assert.ok(!rendered.includes('| 镜号 |'));},{callId:scriptCall.id,renderer:'server/text-stage.mjs: renderStage'});
prove('747有图片引用却没有视觉输入',()=>{
 const stageCalls=original.calls.filter(c=>c.methodId);assert.ok(stageCalls.length>0);
 assert.ok(stageCalls.every(c=>JSON.parse(c.input[1].content).sources.some(s=>s.type==='image')));
 assert.ok(original.calls.every(c=>!c.input.flatMap(m=>Array.isArray(m.content)?m.content:[]).some(p=>p.type==='input_image')));
},{stageCalls:original.calls.filter(c=>c.methodId).map(c=>c.id),actualImageInputs:0});
const instructions=await readFile('skills/video-script-zh-v1/instructions.md','utf8');
prove('脚本技能假定已锁定五张宫格图',()=>assert.ok(instructions.includes('前序已锁定五张宫格图')),{file:'skills/video-script-zh-v1/instructions.md',actualSourceCount:1});
prove('仅提示词输出仍被渲染器强加标题和其他字段',()=>{
 const result=renderStage({prompt:'飞机缓慢滑行，镜头平稳跟拍。',preservedConstraints:['仅输出提示词']});assert.ok(result.startsWith('### 提示词'));assert.ok(result.includes('### 保留约束'));
},{sample:renderStage({prompt:'飞机缓慢滑行，镜头平稳跟拍。',preservedConstraints:['仅输出提示词']})});
await writeFile(directory+'/deterministic-proofs.json',JSON.stringify({purpose:'验证问题存在；reproduced=true不表示已修复。未更改生产代码。',proofs},null,2));console.log(JSON.stringify({reproduced:proofs.length,total:proofs.length}));
