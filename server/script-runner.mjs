import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { findSkill } from './catalog.mjs';
const integrity = JSON.parse(await readFile(new URL('./script-integrity.json',import.meta.url),'utf8'));
const ajv = new Ajv2020({strict:false,allErrors:true});
export function scriptDefinition(catalog, slug, name) {
  const script = findSkill(catalog,slug).scriptDefinitions.find(x=>x.name===name);
  if(!script) throw new Error('该脚本未登记');
  return script;
}
export async function runScript(catalog, slug, name, input, signal, python = process.env.PYTHON_BIN || 'python') {
  const script = scriptDefinition(catalog,slug,name);
  const validate = ajv.compile(script.inputSchema);
  if(!validate(input)) throw new Error(`脚本参数错误：${ajv.errorsText(validate.errors)}`);
  if(!/^scripts\/[a-z0-9-]+\.py$/.test(script.entrypoint)) throw new Error('脚本路径无效');
  const bytes = await readFile(catalog.root+`${slug}/${script.entrypoint}`);
  if(createHash('sha256').update(bytes).digest('hex')!==integrity[`${slug}/${name}`]) throw new Error('脚本完整性校验失败，拒绝执行');
  // Only reviewed installed source runs. No shell, model-supplied code or inherited API keys.
  const source=bytes.toString('utf8')+'\nimport json,sys\nprint(json.dumps(main(json.load(sys.stdin)),ensure_ascii=True))\n';
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(k.toUpperCase())));
  const output=await new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-X','utf8','-c',source],{env,windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
    let stdout='',expired=false;
    const timer=setTimeout(()=>{expired=true;child.kill();},10000);
    child.stdout.setEncoding('utf8');child.stderr.resume();
    child.stdout.on('data',part=>{stdout+=part;if(stdout.length>1000000){expired=true;child.kill();}});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Python 启动失败或已取消，请检查 PYTHON_BIN'));});
    child.on('close',code=>{clearTimeout(timer); if(code!==0||expired)reject(new Error(expired?'脚本超过执行资源上限':'脚本执行失败，请检查输入'));else resolve(stdout);});
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(input));
  });
  const result=JSON.parse(output);
  const validateOutput=ajv.compile(script.outputSchema);
  if(!validateOutput(result)) throw new Error('脚本输出不满足登记的 Schema');
  return result;
}
