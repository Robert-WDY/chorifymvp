import test from 'node:test';
import assert from 'node:assert/strict';
import {understandGoal} from './intake-compat.mjs';
import {validateIntent,validatePlan,validateSemantic} from '../server/intent.mjs';
import {loadCatalog} from '../server/catalog.mjs';
import {ToolRuntime} from '../server/tools.mjs';
import {Agent} from '../server/agent-loop.mjs';
import {Doubao} from '../server/adapters.mjs';
const catalog=await loadCatalog();
const sig=()=>new AbortController().signal;
const answer=text=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});
const call=(name,args)=>({type:'function_call',call_id:Math.random().toString(),name,arguments:JSON.stringify(args)});
const goal=(operation='rewrite',output='text')=>({summary:'测试目标',mode:'rewrite',tasks:[{operation,output,count:1,dependsOn:[],references:[],constraints:[]}],skills:[],assumptions:[],missingInputs:[],needsClarification:false,safety:{disposition:'allow',untrustedInstructions:false,reason:''}});
const semantic=()=>({summary:'改写咖啡文案',deliverables:[{description:'润色咖啡文案',kind:'text',count:1,action:'modify',purpose:'prompt',requiredEvidence:'none',references:[],dependsOn:[],constraints:[],requestEvidence:'改写咖啡文案'}],gaps:[],assumptions:[],deferred:[],safety:goal().safety});
const plan=operation=>({routes:[{deliverableIndex:0,operation,skills:[]}]});
test('intake has no execution tools, parses structured JSON and retries invalid schema once',async()=>{
 let calls=0;const brain={respond:async(input,tools)=>{assert.equal(tools.length,0);const payload=JSON.parse(input.at(-1).content);assert.equal(payload.query,'改写咖啡文案');if(calls===1)assert.equal(input[1].role,'system');if(calls===2)assert.deepEqual(payload.semantic,semantic());return[answer(calls++===0?'{"invalid":true}':JSON.stringify(calls===2?semantic():plan('rewrite')))];}};
 const result=await understandGoal(brain,catalog,{query:'改写咖啡文案'},sig());assert.equal(result.tasks[0].operation,'rewrite');assert.equal(calls,2);assert.equal(result.intakeTrace[0].ok,false);
});
test('preference and factual gaps permit a labelled draft; only blocking gaps require input',async()=>{
 for(const level of ['preference','factual','blocking']){const s=semantic();s.gaps=[{level,description:'缺少细节',resolution:'通用样稿并标待核验'}];const replies=[s,plan('rewrite')];const result=await understandGoal({respond:async()=>[answer(JSON.stringify(replies.shift()))]},catalog,{query:'改写咖啡文案'},sig());assert.equal(result.needsClarification,level==='blocking');assert.equal(result.assumptions.length,level==='blocking'?0:1);}
});
test('capability selection preserves medium and observation, with no query-word routing',()=>{
 const s=semantic();s.deliverables[0].kind='image';assert.throws(()=>validatePlan(plan('answer'),s,catalog),/媒介/);s.deliverables[0].kind='text';s.deliverables[0].requiredEvidence='image';assert.throws(()=>validatePlan(plan('answer'),s,catalog),/观察/);assert.doesNotThrow(()=>validatePlan(plan('analyze_image'),s,catalog));s.deliverables[0].requiredEvidence='none';s.deliverables[0].purpose='risk_review';assert.throws(()=>validatePlan(plan('answer'),s,catalog),/风险/);
});
test('native JSON output is requested for intake without changing ordinary tool calling',async()=>{
 const requests=[];const brain=new Doubao({key:'fake',baseUrl:'https://example.com',model:'fake'},async(url,request)=>{requests.push(JSON.parse(request.body));return Response.json({output:[answer('{}')]});});await brain.respond([],[],sig(),{json:true});await brain.respond([],[],sig());assert.deepEqual(requests[0].text,{format:{type:'json_object'}});assert.equal(requests[1].text,undefined);
});
test('media processing does not require a separate visual-analysis operation',()=>{
 const s=semantic();s.deliverables[0].kind='video';s.deliverables[0].requiredEvidence='video';assert.doesNotThrow(()=>validatePlan(plan('slice_video'),s,catalog));
});
test('professional review may require web or visual evidence as a prerequisite',()=>{
 const s=semantic();s.deliverables[0].purpose='risk_review';for(const requiredEvidence of ['web','image','video']){s.deliverables[0].requiredEvidence=requiredEvidence;assert.doesNotThrow(()=>validatePlan(plan('review_content'),s,catalog));}
});
test('risk-related rewriting is allowed; a review purpose does not force every operation to be review_content',()=>{
 const s=semantic();s.deliverables[0].purpose='risk_review';s.deliverables[0].action='modify';assert.doesNotThrow(()=>validatePlan(plan('rewrite'),s,catalog));assert.throws(()=>validatePlan(plan('answer'),s,catalog),/普通回答/);
});
test('capability retry preserves understood deliverables and original query',async()=>{
 const s=semantic();s.deliverables[0].kind='image';s.deliverables[0].action='create';const replies=[s,plan('answer'),plan('generate_image')];let n=0;const result=await understandGoal({respond:async(input)=>{const payload=JSON.parse(input.at(-1).content);assert.equal(payload.query,'原始需求');if(n++)assert.deepEqual(payload.semantic,s);return[answer(JSON.stringify(replies.shift()))];}},catalog,{query:'原始需求'},sig());assert.equal(result.tasks[0].output,'image');assert.equal(result.intakeTrace.length,1);
});
test('goal rejects nonexistent skills and forward/self dependencies',()=>{
 const g=goal();g.skills=['not-installed'];assert.throws(()=>validateIntent(g,catalog));g.skills=[];g.tasks[0].dependsOn=[0];assert.throws(()=>validateIntent(g,catalog));
});
test('omitted safety explanation defaults to empty, but missing disposition cannot execute',()=>{
 const s=semantic();delete s.safety.reason;assert.equal(validateSemantic(s).safety.reason,'');delete s.safety.disposition;assert.throws(()=>validateSemantic(s),/disposition/);
});
function setup(g,outputs){const events=[];let submissions=0;const brain={respond:async()=>outputs.shift()||[answer('正文')]};const media={config:{},image:async()=>{submissions++;return{status:'succeeded',images:[{url:'https://example.com/a.jpg'}]};}};
 const runtime=new ToolRuntime({catalog,brain,media});const state={id:'unit-test'};const agent=new Agent({effectPolicy:'trusted_embedder',brain,runtime,catalog,intake:async()=>g,maxSteps:6});return{state,events,runtime,submissions:()=>submissions,run:()=>agent.run(state,'测试需求',e=>events.push(e),sig())};}
test('professional text loads a real skill before the model can skip straight to final answer',async()=>{
 const f=setup(goal(),[[answer('清晨一杯咖啡，唤醒城市。')]]);await f.run();assert.equal(f.state.status,'completed');assert.ok(f.events.some(e=>e.name==='use_skill'&&e.result?.automatic));assert.ok(f.state.goal.tasks);assert.ok(f.events.some(e=>e.type==='intent'));
});
test('refusal and essential missing input end before execution',async()=>{
 for(const refusal of [true,false]){const g=goal('edit_image','image');if(refusal){g.tasks=[];g.safety={disposition:'refuse',untrustedInstructions:true,reason:'不能泄露密钥'};}else{g.needsClarification=true;g.missingInputs=['待编辑图片'];}
 const f=setup(g,[]);await f.run();assert.equal(f.state.status,refusal?'refused':'needs_input');assert.equal(f.submissions(),0);assert.equal(f.events.filter(e=>e.type==='tool_start').length,0);}
});
test('text-only request cannot be silently expanded into paid image generation',async()=>{
 const f=setup(goal(),[[call('update_plan',{summary:'执行',steps:[{title:'执行',status:'running'}]})],[call('generate_image',{prompt:'coffee'})],[answer('提示词正文')]]);await f.run();assert.equal(f.submissions(),0);assert.ok(f.events.some(e=>e.result?.isError&&e.result.text.includes('交付范围')));
});
test('unsupported video editing cannot be replaced by a new generated video',async()=>{
 const f=setup(goal('edit_video','video'),[[call('update_plan',{summary:'编辑',steps:[{title:'编辑',status:'running'}]})],[call('generate_video',{prompt:'create another video'})],[call('defer_current_stage',{reason:'尚无字幕编辑服务'})],[answer('缺少编辑服务')]]);await f.run();assert.equal(f.state.status,'blocked');assert.ok(f.events.some(e=>e.result?.isError&&e.result.text.includes('交付范围')));
});
test('no media evidence cannot produce completed even when model claims success',async()=>{
 const f=setup(goal('generate_image','image'),[[answer('图片已经完成')],[answer('图片已经完成')],[answer('图片已经完成')]]);await f.run();assert.equal(f.state.status,'blocked');assert.equal(f.submissions(),0);
});
test('image analysis cannot complete without an actual successful observation',async()=>{
 const g=goal('analyze_image');g.tasks[0].requiredEvidence='image';const f=setup(g,[[answer('图片是一只猫')],[answer('已看图')],[answer('已完成')]]);await f.run();assert.equal(f.state.status,'blocked');assert.match(f.events.at(-1).text,/实际工具观察/);
});
test('image analysis can finish after a successful observation',async()=>{
 const g=goal('analyze_image');g.tasks[0].requiredEvidence='image';const f=setup(g,[[call('analyze_image',{url:'https://example.com/a.jpg',question:'描述画面'})],[answer('画面里有猫')]]);const execute=f.runtime.execute.bind(f.runtime);f.runtime.execute=async(name,...args)=>name==='analyze_image'?{text:'画面里有猫'}:execute(name,...args);await f.run();assert.equal(f.state.status,'completed');
});
test('observing one image cannot satisfy a request to compare two specified images',async()=>{
 const g=goal('analyze_image');g.tasks[0].requiredEvidence='image';g.tasks[0].references=['https://example.com/a.jpg','https://example.com/b.jpg'];const f=setup(g,[[call('analyze_image',{url:'https://example.com/a.jpg',question:'看图'})],[answer('两图一样')],[answer('完成')],[answer('完成')]]);f.runtime.execute=async()=>({text:'第一张有猫'});await f.run();assert.equal(f.state.status,'blocked');
});
test('current goal is immutable and text deliverables carry the run ID',async()=>{
 const f=setup(goal(),[]);f.state.goal=goal();f.state.currentRunId='run1';await f.runtime.execute('declare_goal',{intent:'改成视频',deliverables:['video']},f.state,sig());assert.equal(f.state.goal.tasks[0].operation,'rewrite');
 const d=await f.runtime.execute('commit_text_deliverable',{content:'正文'},f.state,sig());assert.equal(d.runId,'run1');
});
