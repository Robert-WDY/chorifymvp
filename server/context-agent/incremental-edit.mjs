import {GuardError,fingerprint} from './io-guard.mjs';

// Every location is resolved against the same immutable original, never against
// the output of an earlier replacement. Unmentioned bytes remain unchanged.
export function applyEdits(original,edits){
 if(typeof original!=='string'||!Array.isArray(edits)||!edits.length)throw new GuardError('invalid_edits','增量修改需要原文和至少一项替换');
 const ranges=edits.map(({before,after})=>{
  if(typeof before!=='string'||!before.length||typeof after!=='string')throw new GuardError('invalid_edits','before须为非空原文，after为替换文字');
  const start=original.indexOf(before);
  if(start<0)throw new GuardError('edit_source_mismatch','替换片段不在原文中；回读准确原稿，不改为重建整篇');
  if(original.indexOf(before,start+1)>=0)throw new GuardError('ambiguous_edit','替换片段命中多处；提供更长的准确片段定位');
  if(before===after)throw new GuardError('unchanged_edit','替换前后相同，没有实际改动');
  return {start,end:start+before.length,before,after};
 }).sort((a,b)=>a.start-b.start);
 for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw new GuardError('overlapping_edits','替换片段重叠；合并为一个准确原文片段');
 let content=original;for(const r of [...ranges].reverse())content=content.slice(0,r.start)+r.after+content.slice(r.end);
 if(content===original)throw new GuardError('unchanged_edit','合并修改后正文没有变化，不创建假修订');
 return {content,evidence:{mode:'incremental',changed:content!==original,changes:ranges,baseHash:fingerprint(original),resultHash:fingerprint(content)}};
}

// An actual difference, not an interpretation of the user's requested change.
export function actualTextChange(before,after){
 let start=0,end=0;while(start<Math.min(before.length,after.length)&&before[start]===after[start])start++;
 while(end<Math.min(before.length-start,after.length-start)&&before[before.length-1-end]===after[after.length-1-end])end++;
 return {changed:before!==after,changes:before===after?[]:[{start,end:before.length-end,before:before.slice(start,before.length-end),after:after.slice(start,after.length-end)}],baseHash:fingerprint(before),resultHash:fingerprint(after)};
}
