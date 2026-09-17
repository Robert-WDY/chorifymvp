import {GuardError} from './io-guard.mjs';

// Same supported message representation for both archival and revision.
// Mixed media must not be flattened into an apparently complete text original.
export function originalMessageText(content){
 if(typeof content==='string')return content;
 if(Array.isArray(content)&&content.every(part=>part&&['text','input_text','output_text'].includes(part.type)&&typeof part.text==='string'))return content.map(part=>part.text).join('\n');
 throw new GuardError('text_original_required','原消息不是完整文字；不能省略图片等非文字部分来构造原稿');
}

// Select exact original wording. No model paraphrase, heuristic instruction removal,
// or mutation of the source message. Offsets are JS string (UTF-16) offsets.
export function selectOriginal(original,sourceText){
 if(typeof original!=='string'||!original.trim())throw new GuardError('text_original_required','需要完整文字原稿');
 if(sourceText===undefined)return {content:original};
 const start=original.indexOf(sourceText);
 if(!sourceText.trim()||start<0)throw new GuardError('original_content_mismatch','sourceText不是所选对象的连续原文；核对消息/资产ID与实际正文，不能用修改稿冒充原稿');
 if(original.indexOf(sourceText,start+1)>=0)throw new GuardError('ambiguous_source_text','同一片段出现多次；提供更完整的原文以唯一定位');
 return {content:sourceText,sourceRange:{start,end:start+sourceText.length,unit:'utf16'}};
}

export function documentReceipt(state,asset){
 const parent=asset.parentId?state.assets[asset.parentId]:null;
 return {ok:true,asset:structuredClone(asset),...(parent?{parentEvidence:{id:parent.id,version:parent.version,sourceMessageId:parent.sourceMessageId,sourceRange:parent.sourceRange,
  characters:parent.content.length,content:parent.content,readMore:{tool:'read_asset',arguments:{id:parent.id}}}}:{})};
}
