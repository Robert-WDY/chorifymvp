// Assertions describe observed failures/successes in frozen traces, not product fixes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {countBody} from '../../server/text-measure.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const result={};
const chat=read('retest/CHAT_VERSION/session.json'),wire=read('retest/CHAT_VERSION/transport.json');
const long=chat.records.find(r=>r.id==='c035e031-9359-47b9-92ef-e27c7a027a0d');
const short=chat.records.find(r=>r.id==='8d435411-3038-44d4-8f74-f5fd13efd1b1');
const index=wire.findIndex(w=>w.round===3&&w.response.output.some(o=>o.name==='save_document'));
const request=wire[index].request;
assert.ok(request.input.some(m=>m.role==='assistant'&&m.content===long.content));
assert.ok(!JSON.stringify(request.input).includes(long.id));
assert.ok(JSON.stringify(request.input).includes(short.id));
result.missingLongIdentity={wireIndex:index,longMessageId:long.id,shortMessageId:short.id,longBodyFullyVisible:true,longIdVisible:false,shortIdVisible:true,firstSave:wire[index].response.output};
const savedLong=Object.values(chat.assets).find(a=>a.title==='青禾茶铺·朋友圈文案（正式长版）');
assert.equal(chat.assets[savedLong.parentId].sourceMessageId,short.id);
result.reverseParent={child:savedLong,parent:chat.assets[savedLong.parentId]};
const memory=read('primary/LONG_MEMORY/session.json');
const revised=Object.values(memory.assets).find(a=>a.parentId);
assert.ok(revised.content.includes('18元'));assert.ok(!revised.content.includes('20元'));
const final=memory.records.filter(r=>r.kind==='message'&&r.role==='assistant').at(-1);
assert.ok(final.content.includes('仅“18元”改为“20元”'));
result.savedReplyDisagreement={storedRevision:revised,actualFinal:final};
const summary=Object.values(memory.summaries).at(-1);
for(const text of ['20元','79元','米白','红背景','未知'])assert.ok(summary.summaryText.includes(text));
result.longMemory={summaries:Object.values(memory.summaries).length,summaryFailures:memory.records.filter(r=>r.event==='summary_failed').length,lastSummary:summary};
result.bodyCounts=[];
for(const batch of ['primary','retest']){
 const s=read(batch+'/CHAT_VERSION/session.json');
 for(const m of s.records.filter(r=>r.kind==='message'&&r.role==='assistant').slice(0,2)){
  const body=m.content.split('**正文：**\n\n')[1].split('\n\n---')[0];
  result.bodyCounts.push({batch,messageId:m.id,body,characters:countBody(body,'characters'),nonPunctuation:countBody(body,'non_punctuation_characters')});
 }
}
const approval=read('primary/CONFIRM_LANGUAGE/session.json');
const proposals=Object.values(approval.approvals).filter(a=>a.kind==='proposal');
const replacement=proposals.find(a=>a.replacesProposalId);
result.proposalPreserveReview={original:approval.approvals[replacement.replacesProposalId],replacement};
fs.writeFileSync(path.join(root,'semantic-evidence.json'),JSON.stringify(result,null,2)+'\n');
console.log('Frozen-trace checks passed: missing visible-body ID, reversed parent, saved/replied price mismatch, summary contents and actual body counts. These assert observed facts, not overall acceptance.');
