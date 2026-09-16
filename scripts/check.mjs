import { readdir,readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {hasPlatformDependency} from './platform-check.mjs';
let checked=0;
async function walk(path) {
  for(const entry of await readdir(path,{withFileTypes:true})) {
    const file=`${path}/${entry.name}`;
    if(entry.isDirectory()) await walk(file);
    else {
      const text=await readFile(file,'utf8');
      if(hasPlatformDependency(text)) throw new Error(`遗留平台依赖：${file}`);
      if(/\.(mjs|js)$/.test(file)) {
        const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
        if(result.status!==0)throw new Error(result.stderr);
      }
      checked++;
    }
  }
}
for(const path of ['server','dist','skills','scripts','tests','evals'])await walk(path);
console.log(`独立性与语法检查通过：${checked} 个文件`);
