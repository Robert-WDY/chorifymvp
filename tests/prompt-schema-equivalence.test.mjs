import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {compactPromptSchema} from '../server/prompt-schema.mjs';
import {businessRequestSchema} from '../server/action-registry.mjs';
import {semanticSchema} from '../server/intent.mjs';
import {operationInputSchema} from '../server/turn-operation.mjs';
const ajv=new Ajv({strict:false});
const safety={disposition:'allow',untrustedInstructions:false,reason:''};
function equivalent(schema,samples){const before=ajv.compile(schema),after=ajv.compile(compactPromptSchema(schema));for(const value of samples)assert.equal(after(structuredClone(value)),before(structuredClone(value)),JSON.stringify(value));}
test('schema compression preserves business properties named type and ordinary schema-looking data',()=>{
 const item={type:'object',additionalProperties:false,required:['type','id','version'],properties:{type:{type:'string',enum:['IMAGE','TEXT']},id:{type:'string',minLength:1},version:{type:'integer',minimum:1}}};
 const schema={type:'object',properties:{a:item,b:structuredClone(item),data:{const:{type:'object',properties:{type:'data, not a schema'},other:'x'.repeat(150)}}},required:['a','b']};
 const valid={a:{type:'IMAGE',id:'a',version:1},b:{type:'TEXT',id:'b',version:2}};
 equivalent(schema,[valid,{...valid,a:{type:'IMAGE',version:1}},{...valid,a:{type:'VIDEO',id:'a',version:1}},{...valid,b:{type:'TEXT',id:'b',version:0}},{...valid,data:schema.properties.data.const}]);
});
test('native actions retain identical validity before and after prompt compression',()=>{
 const schema=businessRequestSchema(semanticSchema.properties.safety,semanticSchema.properties.gaps);
 const base={summary:'修改图片',safety,businessActions:[{id:'a',actionType:'EDIT_IMAGE',intent:'背景改红',target:{type:'IMAGE',id:'real-image',version:1},modification:{change:['背景改红'],preserve:['主体']}}]};
 equivalent(schema,[base,{...base,businessActions:[{...base.businessActions[0],target:{type:'IMAGE',id:'real-image'}}]},{...base,businessActions:[{...base.businessActions[0],target:{type:'ACTION_OUTPUT',actionId:'b'}}]}, {...base,businessActions:[{...base.businessActions[0],tool:'invented'}]}]);
});
test('legacy contracts retain validity for valid and invalid operations',()=>{
 const valid={summary:'一个方向',safety,approval:{required:false,reason:''},turnOperation:{kind:'create'},deliverables:[{description:'一个方向',kind:'text',action:'create',count:1,form:'directions'}]};
 equivalent(operationInputSchema(semanticSchema),[valid,{...valid,turnOperation:{kind:'invented'}},{...valid,deliverables:[{description:'图片',kind:'image',action:'create',count:0}]},{...valid,deliverables:[]}]);
});
test('reference scopes, booleans and existing definitions are preserved',()=>{
 const schema={$defs:{shared0:{type:'string'}},type:'object',properties:{a:{$ref:'#/$defs/shared0'},b:true,c:false}};
 equivalent(schema,[{a:'x',b:9},{a:9},{c:null},{}]);
 assert.deepEqual(compactPromptSchema({const:{oneOf:[{type:'object'}]},examples:[{type:'object'}]}),{const:{oneOf:[{type:'object'}]},examples:[{type:'object'}]});
});
