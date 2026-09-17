// Controlled real-text comparison. No media provider or vision is registered.
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import {createBrain,brainConfig} from '../server/adapters.mjs';
import {applyEdits} from '../server/context-agent/incremental-edit.mjs';
import {ContextAgent} from '../server/context-agent/loop.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
export const cases=[
 {id:'price',original:'桂花乌龙，无糖。\n\n每杯20元，11点营业。\n\n预约规则待确认。',user:'价格改一下，18元，其他原样保留。',before:'20元',after:'18元'},
 {id:'background',original:'透明矩形香水瓶，白色瓶盖。米白背景，柔和侧光。横版，无文字，无人物。',user:'背景换浅蓝色吧，瓶型、瓶盖、光线和其他要求都不要动。',before:'米白背景',after:'浅蓝背景'},
 {id:'repeated',original:'青禾：冷泡茶18元，每天11点开门。\n\n松岚：试香蜡烛18元，预约规则未知。\n\n两家分开发布。',user:'松岚那款改成20元，青禾不变，别动其他字。',before:'试香蜡烛18元',after:'试香蜡烛20元'},
 {id:'delete',original:'夏日冷泡计划\n\n桂花与乌龙慢慢相遇。活动仅限周末。售价18元。\n\n预约要求还没有确定。',user:'“活动仅限周末。”这句撤掉，其他逐字保留。',before:'活动仅限周末。',after:''},
 {id:'two_places',original:'开店说明\n\n每杯18元。原料产地未知，不作产地承诺。\n\n桌面用浅灰色背景，不增加摆件。\n\n每天11点营业。预约规则待确认。',user:'两处：价格变20元，开门改12点。其他一句也别改。',edits:[{before:'18元',after:'20元'},{before:'11点',after:'12点'}]},
 {id:'long',original:Array.from({length:18},(_,i)=>'第'+(i+1)+'段：'+(i===14?'该系列标准售价为79元。':'这是第'+(i+1)+'段的独立说明。')+'保留本段原有顺序、格式和事实。'.repeat(4)).join('\r\n\r\n'),user:'把标准售价改为89元，只动价格，其他字和换行全部保留。',before:'79元',after:'89元'},
 {id:'tone',original:'午后的一杯\n\n本店诚邀您品鉴桂花乌龙冷泡茶。无糖，每杯18元。\n\n每天11点营业。预约要求待确认。',user:'中间那段太正式，改得像店员跟熟客聊天，别增加事实。标题和最后一段原样保留。',target:1},
];
const outputSchemas={
 whole:{type:'object',additionalProperties:false,required:['content'],properties:{content:{type:'string',minLength:1}}},
 edits:{type:'object',additionalProperties:false,required:['edits'],properties:{edits:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:['before','after'],properties:{before:{type:'string',minLength:1},after:{type:'string'}}}}}},
 segments:{type:'object',additionalProperties:false,required:['segments'],properties:{segments:{type:'array',minItems:1,items:{type:'object',additionalProperties:false,required:['id','text'],properties:{id:{type:'string'},text:{type:'string'}}}}}},
};
const ajv=new Ajv({strict:false}),validators=Object.fromEntries(Object.entries(outputSchemas).map(([k,v])=>[k,ajv.compile(v)]));
export function blocks(text){return text.split(/(\r?\n\r?\n)/);}
export function reconstruct(method,original,result){
 if(!validators[method](result))throw new Error('output_schema: '+ajv.errorsText(validators[method].errors));
 if(method==='whole')return result.content;
 if(method==='edits')return applyEdits(original,result.edits).content;
 const parts=blocks(original),seen=new Set();
 for(const item of result.segments){const match=/^s(\d+)$/.exec(item.id),i=match?Number(match[1])*2:-1;if(i<0||i>=parts.length||seen.has(i))throw new Error('invalid_segment');seen.add(i);parts[i]=item.text;}
 return parts.join('');
}
const promptVersions={
 concise:'根据用户要求局部修改原文。只改必要内容，其余文字、事实和格式保持原样。不要增加解释或备选。',
 explicit:'把原文当作不可随意重写的底稿。先根据用户原话确定需要变化的最小连续片段，再修改该片段；未点名部分逐字保持，包括空白、换行、数字、否定和未知项。不要顺手润色，不补事实，不把其他对象的相同词一起替换。输出前核对修改是否全部落实，且没有扩大范围。只输出规定JSON。',
};
export function makeInput(c,method,version){
 const instructions={whole:'返回JSON {"content":"修改后的完整原文"}。完整正文须保留未修改部分。',edits:'返回JSON {"edits":[{"before":"准确连续原文","after":"替换文字"}]}。before必须在原文唯一命中，必要时带少量相邻原文定位；多处修改分列且不重叠。不要返回整篇。删除时after为空。所有before基于同一原稿。',segments:'原文已按空行分段，段ID仅用于定位。返回JSON {"segments":[{"id":"s0","text":"该段修改后的完整正文"}]}，只返回需要修改的段。段内其他文字也须保留；程序按原位置拼接，未返回段及段间换行保持原样。'};
 const data=method==='segments'?{segments:blocks(c.original).filter((_,i)=>i%2===0).map((text,i)=>({id:'s'+i,text}))}:{original:c.original};
 return [{role:'system',content:promptVersions[version]+'\n'+instructions[method]},{role:'user',content:JSON.stringify({source:'test_original',...data,request:c.user})}];
}
export function check(c,content){
 if(c.target===undefined){const edits=c.edits||[{before:c.before,after:c.after}];return {exactExpected:content===applyEdits(c.original,edits).content,semanticReview:'deterministic_requested_substitutions'};}
 const old=blocks(c.original),next=blocks(content);return {outsidePreserved:next.length===old.length&&next.every((v,i)=>i===c.target*2||v===old[i]),targetChanged:next[c.target*2]!==old[c.target*2],semanticReview:'human_required_for_tone_and_facts'};
}
async function main(){
 const args=process.argv.slice(2),arg=(k,d)=>args.find(s=>s.startsWith('--'+k+'='))?.slice(k.length+3)||d;
 if(arg('env'))process.loadEnvFile(arg('env'));const config=brainConfig(),root=resolve(arg('out','evaluation-runs/local-revision-comparison'));
 const stage=arg('stage','compare'),budget=96;
 if(!args.includes('--run')){console.log(JSON.stringify({provider:config.provider,model:config.model,reasoning:config.reasoningEffort,keyConfigured:!!config.key,stage,root,totalCallLimit:budget,comparisonCalls:84,sourceAgentCalls:12,media:false,vision:false},null,2));return;}
 if(config.provider!=='deepseek'||config.model!=='deepseek-flash'||!config.key)throw new Error('Expected configured deepseek-flash');
 if(stage==='compare')await mkdir(root,{recursive:false});
 if(stage==='sources'){for(const name of ['older_long','other_product','selected_short']){let exists=false;try{await access(join(root,name+'.json'));exists=true;}catch{}if(exists)throw new Error('Refusing to overwrite prior source-agent evidence');}}
 const write=(name,data)=>writeFile(join(root,name),JSON.stringify(data,null,2)+'\n');
 const prior=stage==='sources'?JSON.parse(await readFile(join(root,'ledger.json'),'utf8')):{calls:0};let calls=prior.calls,transport=[],current;
 const brain=createBrain(process.env,async(url,options)=>{const e={item:current,request:JSON.parse(options.body),startedAt:new Date().toISOString()};transport.push(e);const r=await fetch(url,options);e.status=r.status;e.response=await r.clone().json();return r;});
 const respond=async(input,tools,signal,options)=>{if(calls>=budget)throw new Error('Shared 96-call limit exhausted');calls++;await write('ledger.json',{calls,budget,model:config.model,authorization:'User requested real prompt comparison and material-selection tests; new run, no prior budget reused'});return brain.respond(input,tools,signal,options);};
 const meta={codeSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),provider:config.provider,model:config.model,reasoning:config.reasoningEffort,media:false,vision:false,stage};
 meta.sourceHashes={};for(const path of ['server/context-agent/prompt.md','server/context-agent/tools.mjs','evals/local-revision-compare.mjs'])meta.sourceHashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
 await write(stage+'-metadata.json',meta);
 if(stage==='compare'){
  await write('fixtures.json',{cases,promptVersions,outputSchemas});const results=[];
  // Rotate method order on the second repeat; every request starts without history.
  for(let repeat=0;repeat<2;repeat++)for(const c of cases)for(const version of Object.keys(promptVersions))for(const method of repeat?['segments','edits','whole']:['whole','edits','segments']){
   current=[c.id,version,method,repeat].join('-');const input=makeInput(c,method,version);let row={id:current,caseId:c.id,method,version,repeat,input};transport=[];
   try{const output=await respond(input,[],new AbortController().signal,{json:true,maxOutputTokens:6000});row.output=output;row.rawText=output.flatMap(p=>p.content||[]).map(p=>p.text||'').join('\n');const parsed=JSON.parse(row.rawText);row.content=reconstruct(method,c.original,parsed);row.check=check(c,row.content);row.usage=brain.lastCall?.usage;}catch(error){row.error={code:error.code,message:error.message};}
   row.transport=transport;await write(current+'.json',row);results.push({id:row.id,method,version,caseId:c.id,check:row.check,error:row.error,usage:row.usage});await write('results.json',results);console.log(JSON.stringify({id:current,call:calls,check:row.check,error:row.error}));
  }
 }else if(stage==='sources'){
  const inputs=[
   {id:'older_long',message:'把青禾最早那篇长稿中的价格改为20元，其他字不动，保存新版本。',expected:'long',change:['18元','20元']},
   {id:'other_product',message:'改松岚那份，售价变89元，其他原样保留并保存。',expected:'candle',change:['79元','89元']},
   {id:'selected_short',message:'把我选中的这版里面的“慢饮”换成“慢慢喝”，其余不动，保存。',selectedAssetIds:['short'],expected:'short',change:['慢饮','慢慢喝']},
  ];
  for(const c of inputs){current=c.id;transport=[];const s=createSession();s.assets={long:{id:'long',type:'text',title:'青禾最早长稿',version:1,content:'青禾桂花乌龙，每杯18元。\n\n午后坐一会，慢饮一杯茶。预约要求待确认。'},short:{id:'short',type:'text',title:'青禾短版',version:2,parentId:'long',content:'青禾18元，午后慢饮。'},candle:{id:'candle',type:'text',title:'松岚蜡烛',version:1,content:'松岚蜡烛79元，燃烧时长待确认。'}};
   appendRecord(s,{kind:'message',role:'user',content:'青禾有原长稿和后来的短版。另有松岚蜡烛，客户不要混在一起。'});
   const agent=new ContextAgent({tools:createTools({mode:'live'}),brain:{respond,get lastCall(){return brain.lastCall;}},memory:{enabled:false},maxSteps:4,maxModelCalls:4});
   const result=await agent.run(s,c.message,()=>{},undefined,{selectedAssetIds:c.selectedAssetIds||[]});const children=Object.values(s.assets).filter(a=>!['long','short','candle'].includes(a.id));const expected=s.assets[c.expected].content.replace(...c.change);
   await write(c.id+'.json',{case:c,result,state:s,transport,checks:{savedCorrectParent:children.length===1&&children[0].parentId===c.expected,savedExpected:children.length===1&&children[0].content===expected}});console.log(JSON.stringify({id:c.id,calls,status:result.status,children:children.map(a=>({id:a.id,parentId:a.parentId,content:a.content}))}));
  }
 }else throw new Error('Unknown stage');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
