import {fieldPatchFor} from './runtime-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {understandGoal} from './intake-compat.mjs';
import {readOperation,normalizeTurnOperation,inspectionGoal} from '../server/turn-operation.mjs';
import {conversationContext,messageEvidence,resolveMessage} from '../server/conversation-query.mjs';
import {revisionSchema,applyRevision} from '../server/document-revision.mjs';
import {bindDelta} from '../server/text-delta.mjs';
import {observeImages,imageObservationInputs} from '../server/observation-contract.mjs';
import {renderStage} from '../server/text-stage.mjs';
import {revisionMediaScope} from '../server/planning-boundary.mjs';
import {loadCatalog} from '../server/catalog.mjs';
const catalog=await loadCatalog(),signal=()=>new AbortController().signal;
const reply=x=>[{type:'message',content:[{type:'output_text',text:JSON.stringify(x)}]}];
const draft=()=>({summary:'Review supplied image',deliverables:[{description:'Review supplied image',kind:'text',action:'respond',count:1,purpose:'general',requiredEvidence:'image',references:[],dependsOn:[],constraints:[],requestEvidence:'Review supplied image'}],gaps:[],assumptions:[],deferred:[],safety:{disposition:'allow',untrustedInstructions:false,reason:''},approval:{required:false,reason:''},continuation:{mode:'new',taskId:''},turnOperation:{kind:'inspect',query:{kind:'artifacts'}}});
test('metadata lookup cannot silently discard an image observation obligation in any language',()=>{
 for(const query of ['Review supplied image','这幅作品看起来如何','任意没有关键词的请求'])assert.throws(()=>normalizeTurnOperation(draft(),query),/素材观察/);
 assert.equal(readOperation('你有哪些工具',{deliverables:[]}),null);
});
test('a contradictory semantic operation is repaired by a field patch without mutating the rejected draft',async()=>{
 const raw=draft(),original=structuredClone(raw);let calls=0;
 const brain={respond:async input=>{
  calls++;if(calls===1)return reply(raw);
  if(calls===2){assert.ok(input.some(m=>m.content?.includes('素材观察')));return reply(fieldPatchFor(input,{...raw,turnOperation:{kind:'observe'}}));}
  return reply({routes:[{deliverableIndex:0,operation:'analyze_image',skills:[]}]});
 }};
 const goal=await understandGoal(brain,catalog,{query:'Review supplied image'},signal());
 assert.equal(goal.tasks[0].operation,'analyze_image');assert.equal(goal.tasks[0].requiredEvidence,'image');assert.deepEqual(raw,original);
 assert.equal(goal.intakeTrace.filter(t=>!t.ok).length,1);
});
test('message resolution follows stored roles, IDs and reply links without paraphrasing',()=>{
 const state={id:'s',messages:[{role:'user',content:'Literal pronoun: you'},{role:'assistant',content:'Literal reply: I'},{role:'user',content:'Another request'},{role:'assistant',content:'Another answer'}]},messages=messageEvidence(state);
 assert.equal(resolveMessage(messages,{speaker:'assistant',position:'anchor',messageId:messages[0].messageId}).content,'Literal reply: I');
 assert.equal(resolveMessage(messages,{speaker:'user',position:'previous'}).content,'Another request');
 assert.throws(()=>resolveMessage(messages,{speaker:'assistant',position:'anchor',messageId:'foreign-session'}),/本会话/);
 const goal=inspectionGoal('arbitrary wording',{turnOperation:{kind:'inspect',query:{kind:'message',speaker:'assistant',position:'previous'}},safety:{disposition:'allow'}},[],messages);
 assert.equal(goal.tasks[0].form,'answer');assert.equal(goal.tasks[0].runtimeQuery.message.content,'Another answer');
});
test('pending system failure retains raw request separately from task focus and model-generated decisions',()=>{
 const context=conversationContext([], [{runId:'failed',rawInput:'Review the attached asset',status:'failed',error:'invalid_schema'}]);
 assert.equal(context.pendingRequest.rawInput,'Review the attached asset');assert.equal(context.pendingRequest.acceptedTaskId,null);
 const other=conversationContext([],[{rawInput:'read',status:'completed',decision:{status:'accepted',semantic:{large:'noise'},operations:[]}}]);
 assert.equal(other.pendingRequest,null);assert.equal(other.recentAttempts[0].decision.semantic,undefined);
});
test('all images need current source-specific observation receipts; partial success is reused on retry',async()=>{
 const a={id:'a',type:'image',url:'https://example.com/a.png',version:1},b={id:'b',type:'image',url:'https://example.com/b.png',version:1};
 const state={id:'s',taskStore:{tasks:{},artifacts:{},inputs:{a,b}}},item={id:'item',description:'Compare composition',requiredEvidence:'image',references:['a','b'],dependsOn:[],observations:[]};
 const calls=[];let fail=true,saves=0;
 const ex={state,runtime:{execute:async(name,args)=>{calls.push(args.urls);if(fail)throw Error('transport failure');return {text:'Observed '+args.urls.join(',')};}},record:async()=>{},save:async()=>{saves++;}};
 await assert.rejects(()=>observeImages(ex,item,signal()),/transport failure/);assert.equal(item.observations.length,0);
 fail=false;await observeImages(ex,item,signal());assert.deepEqual(calls,[[a.url,b.url],[a.url,b.url]]);assert.equal(imageObservationInputs(item,[a,b]).length,2);assert.equal(saves,1);
 assert.throws(()=>imageObservationInputs(item,[{...a,version:2}]),/当前图片版本/);
 assert.throws(()=>imageObservationInputs({...item,description:'Different question'},[a]),/当前图片版本/);
 assert.throws(()=>imageObservationInputs(item,[]),/没有绑定/);
});
test('revision executor can rewrite a whole document while binding its original version',()=>{
 const source={id:'doc',version:3,type:'text',content:'Old audience and channel'},contract={...bindDelta({changeContract:{request:'Adapt the audience and channel',allowNoChange:true}},[source])};
 const proposal={mode:'rewrite',content:'Revised audience and channel'},validate=new Ajv({strict:false}).compile(revisionSchema(source));
 assert.equal(validate(proposal),true);const result=applyRevision(source,contract,proposal,renderStage);
 assert.equal(result.content,proposal.content);assert.equal(result.deltaEvidence.source.version,3);assert.equal(result.deltaEvidence.outsideSpansPreserved,false);
 assert.equal(validate({...proposal,edits:[]}),false);
});
test('local edits preserve outside spans and structured rewrites preserve one authoritative representation',()=>{
 const plain={id:'doc',version:1,type:'text',content:'Tuesday at 3 pm. Online.'},contract={...bindDelta({changeContract:{request:'4 pm, preserve the rest'}},[plain])};
 const result=applyRevision(plain,contract,{mode:'patch',edits:[{before:'3 pm',after:'4 pm'}]},renderStage);
 assert.equal(result.content,'Tuesday at 4 pm. Online.');assert.equal(result.deltaEvidence.outsideSpansPreserved,true);
 const structure={directions:[{title:'Old',content:'A'}],sections:[{title:'Notes',content:'B'}]},source={id:'structured',version:1,structure,content:renderStage(structure)},next={directions:[{title:'New',content:'C'}],sections:[{title:'Notes',content:'D'}]};
 const proposal={mode:'rewrite',structure:next};assert.equal(new Ajv({strict:false}).compile(revisionSchema(source))(proposal),true);
 const rewritten=applyRevision(source,{source:{id:source.id,version:1},original:source.content,request:'Revise all directions'},proposal,renderStage);
 assert.equal(rewritten.content,renderStage(rewritten.structure));assert.equal(rewritten.content.includes('Old'),false);
});
test('identity budget updates require no new authority, real changes still require raw evidence',()=>{
 const previous={goal:{requestContract:{media:{image:0,video:1,audio:0}}}};
 const value=revisionMediaScope({media:{image:0,video:1,audio:0},mediaChanges:[{kind:'image',count:0,evidence:''}]},previous,'Adjust the headline');
 assert.equal(value.media.video,1);
 assert.throws(()=>revisionMediaScope({mediaChanges:[{kind:'video',count:0,evidence:''}]},previous,'Adjust the headline'),/原文证据/);
});
