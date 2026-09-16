import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {intentPrompt,intakeExamples,semanticSchema} from '../server/intent.mjs';
import {operationInputSchema} from '../server/turn-operation.mjs';
import {businessRequestSchema,actionEnabled} from '../server/action-registry.mjs';
import {textInstructions,mediaInstructions,imageObservation,videoObservation} from '../server/prompt-text.mjs';
const ajv=new Ajv({strict:false,allErrors:true});
for(const mode of ['core','shadow','image_edit'])test('prompt revision: real wire examples and explicit input paths '+mode,()=>{
 const nativeMode=mode!=='shadow',legacy=operationInputSchema(semanticSchema),wire=legacy;
 const validate=ajv.compile(wire),examples=intakeExamples({nativeMode,actionMode:mode}),prompt=intentPrompt({nativeMode,actionMode:mode,wireSchema:wire});
 assert.equal(examples.length,5);assert.ok(examples.every(e=>!e.businessActions));
 for(const example of examples){assert.ok(validate(structuredClone(example)),JSON.stringify(validate.errors));for(const action of example.businessActions||[])assert.ok(actionEnabled(action.actionType,mode));}
 assert.equal(prompt.split('当前wire Schema：').length,2);assert.ok(prompt.indexOf('【交付与话题分开】')<prompt.indexOf('当前wire Schema：'));
 assert.ok(prompt.includes(nativeMode?'候选在relevantEvidence.references':'候选在referenceCatalog.entries'));
 assert.equal(validate(wire),false);
});
test('prompt revision: only applicable text and media branch',()=>{
 const structured=textInstructions({properties:{structure:{}}}),content=textInstructions({properties:{content:{},structure:{}}});
 assert.ok(structured.includes('不另加顶层content'));assert.ok(!structured.includes('本次是自由正文'));
 assert.ok(content.includes('content是完整权威正文'));assert.ok(!content.includes('本次是结构文档'));
 const edit=mediaInstructions('edit_image');assert.ok(edit.includes('change'));assert.ok(edit.includes('preserve'));assert.ok(!edit.includes('总时长'));assert.ok(!edit.includes('assignments'));
 assert.ok(mediaInstructions('generate_video').includes('总时长'));assert.ok(mediaInstructions('generate_image',true).includes('sourceUnitIds'));
 assert.ok(imageObservation.includes('资料明确说未知'));assert.ok(videoObservation.includes('实际输入视频'));
});
