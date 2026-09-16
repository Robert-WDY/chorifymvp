import test from 'node:test';
import assert from 'node:assert/strict';
import {imageDimensions,inheritedImageSize} from '../server/image-metadata.mjs';
import {specializeMediaSchema,restoreContractConstants} from '../server/goal-compiler.mjs';
import {mediaSkills} from '../server/media-skill-contracts.mjs';
test('source dimensions and edit schema preserve canvas',async()=>{
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1728,16);png.writeUInt32BE(2304,20);assert.deepEqual(imageDimensions(png),{width:1728,height:2304});
 const jpeg=Buffer.from([255,216,255,192,0,8,8,9,0,6,192,0]);assert.deepEqual(imageDimensions(jpeg),{width:1728,height:2304});
 const size=await inheritedImageSize('https://example.test/a',{a:{url:'https://example.test/a',metadata:{provider:{size:'1728x2304'}}}});assert.equal(size,'1728x2304');
 assert.equal(specializeMediaSchema(mediaSkills[0],{spec:{}},1,size).properties.items.items.properties.size.const,size);
 assert.equal(specializeMediaSchema(mediaSkills[0],{spec:{ratio:'1:1'}},1).properties.items.items.properties.size.const,undefined);
 await assert.rejects(inheritedImageSize('https://example.test/a',{}, {fetcher(){throw new Error('should not fetch');}}),/原图宽高/);
});

test('omitted image size is materialized before persistence so later edits inherit it',async()=>{
 const schema=specializeMediaSchema(mediaSkills[0],{spec:{}},1),plan=restoreContractConstants({items:[{prompt:'coffee'}]},schema);
 assert.equal(plan.items[0].size,'2048x2048');
 assert.equal(await inheritedImageSize('https://fixtures.invalid/image.png',{a:{url:'https://fixtures.invalid/image.png',metadata:{args:plan.items[0]}}}),'2048x2048');
});
