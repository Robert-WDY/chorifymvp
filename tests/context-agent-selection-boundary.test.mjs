import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,appendRecord} from '../server/context-agent/history.mjs';
import {createTools} from '../server/context-agent/tools.mjs';
import {cases,blocks,reconstruct,check,makeInput} from '../evals/local-revision-compare.mjs';
const context=s=>({state:s,ownerId:s.ownerId,turnId:'turn',callId:'call',fromModel:true,save:async()=>{}});
test('material reference validates existence and type without vetoing an Agent semantic choice',async()=>{
 const s=createSession(),tools=createTools();s.assets.a={id:'a',type:'text',title:'another product',content:'原价79元，容量未知。',version:7};s.assets.img={id:'img',type:'image',version:1};
 appendRecord(s,{kind:'message',role:'user',turnId:'turn',content:'请改茶饮文稿。'});
 assert.equal((await tools.execute('read_asset',{id:'missing'},context(s))).error.code,'asset_not_found');
 assert.equal((await tools.execute('save_document',{parentId:'img',content:'正文'},context(s))).error.code,'asset_type_mismatch');
 const r=await tools.execute('save_document',{parentId:'a',edits:[{before:'79元',after:'89元'}]},context(s));
 assert.equal(r.ok,true);assert.equal(r.asset.parentId,'a');assert.equal(r.asset.version,8);assert.equal(r.parentEvidence.version,7);assert.equal(r.asset.content,'原价89元，容量未知。');
 // Deliberately wrong meaning, valid reference: the runtime must not infer intent.
});
test('whole chat original can be revised without compulsory recitation',async()=>{
 const s=createSession(),tools=createTools(),m=appendRecord(s,{kind:'message',role:'assistant',content:'原文79元。'});
 const r=await tools.execute('save_document',{parentMessageId:m.id,edits:[{before:'79元',after:'89元'}]},context(s));
 assert.equal(r.ok,true);assert.equal(r.parentEvidence.sourceMessageId,m.id);assert.equal(r.parentEvidence.content,m.content);assert.equal(r.asset.content,'原文89元。');
});
test('media reference checks enforce selected file types while provenance does not force visual selection',async()=>{
 const s=createSession(),tools=createTools({observeImages:async()=>({text:'test observation'})});s.assets.text={id:'text',type:'text',content:'容量未知',version:1};s.assets.img={id:'img',type:'image',url:'https://example.com/a.png',version:1};
 assert.equal((await tools.execute('analyze_image',{imageIds:['text'],question:'看图'},context(s))).error.code,'asset_type_mismatch');
 assert.equal((await tools.execute('generate_image',{prompt:'静物',size:'1K',referenceImages:['text']},context(s))).error.code,'asset_type_mismatch');
 assert.equal((await tools.execute('generate_image',{prompt:'静物',size:'1K',referenceImages:['missing']},context(s))).error.code,'asset_not_found');
 const p=await tools.execute('generate_image',{prompt:'静物',size:'1K',sourceIds:['img']},context(s));assert.equal(p.ok,true);assert.deepEqual(p.inputEvidence.visualSources,[]);assert.equal(p.submitted,false);
});
test('comparison reconstruction keeps untouched blocks and rejects invalid outputs without semantic shortcuts',()=>{
 const c=cases.find(c=>c.id==='two_places');const edits=c.edits;
 const patched=reconstruct('edits',c.original,{edits});assert.equal(check(c,patched).exactExpected,true);
 const p=blocks(c.original);const seg=reconstruct('segments',c.original,{segments:[{id:'s1',text:p[2].replace('18元','20元')},{id:'s3',text:p[6].replace('11点','12点')}]});assert.equal(seg,patched);
 assert.throws(()=>reconstruct('segments',c.original,{segments:[{id:'s99',text:'x'}]}));
 assert.throws(()=>reconstruct('edits',c.original,{edits:[{before:'not here',after:'x'}]}));
 assert.throws(()=>reconstruct('whole',c.original,{content:patched,extra:'not allowed'}));
 for(const method of ['whole','edits','segments'])for(const v of ['concise','explicit'])assert.equal(makeInput(c,method,v).length,2);
});
