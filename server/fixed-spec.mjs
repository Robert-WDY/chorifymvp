// Narrow normalization of literal dimension clauses, not natural-language routing.
// Mixed clauses, negations and multiple ratios must be resolved by the model.
import {validationTrace} from './trace-context.mjs';
export function reconcileFixedSpec(deliverable){
 const ratios=[...new Set((deliverable.constraints||[]).flatMap(c=>{
  const match=c.trim().match(/^(?:输出\s*)?(?:画幅|画面比例|图片比例|比例|目标比例|宽高比)?[：:\s]*(\d{1,2}:\d{1,2})\s*(?:比例|图片|画幅|横屏|竖屏|正方形|方形)?[。\s]*$/);
  return match?[match[1]]:[];
 }))];
 if(ratios.length>1)throw new Error('固定比例约束相互冲突，请按用户原始要求修正');
 const raw=deliverable.spec?.ratio;
 const aliases={'竖屏':'9:16','竖版':'9:16',portrait:'9:16',vertical:'9:16','横屏':'16:9','横版':'16:9',landscape:'16:9',horizontal:'16:9','方形':'1:1','正方形':'1:1',square:'1:1'};
 const alias=typeof raw==='string'?aliases[raw.trim().toLowerCase()]:null;
 if(alias){
  const orientation=v=>{const [w,h]=v.split(':').map(Number);return Math.sign(w-h);};
  if(ratios.length&&orientation(ratios[0])!==orientation(alias))throw new Error('画面方向与明确比例约束冲突');
  const chosen=ratios[0]||alias;deliverable.spec.ratio=chosen;
  if(deliverable.specOrigins)deliverable.specOrigins.ratio={...deliverable.specOrigins.ratio,value:chosen,originalRepresentation:raw,origin:ratios.length?'user':'system_default',evidence:ratios.length?ratios[0]:raw,adjustable:!ratios.length};
  validationTrace({phase:'normalize_ratio',from:raw,to:chosen,reason:'将画面方向转换成工具可执行比例，保留原始表达'});
 }
 if(ratios.length){
  deliverable.spec??={};
  if(deliverable.spec.ratio&&deliverable.spec.ratio!==ratios[0])throw new Error('spec.ratio与明确比例约束不一致，请按原始要求修正');
  deliverable.spec.ratio=ratios[0];
 }
 return deliverable;
}
