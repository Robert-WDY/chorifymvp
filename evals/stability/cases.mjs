import {cases as originals} from '../production24/cases.mjs';
const ids=['C002-supported','C003','C005','C008-supported','C009','C010','C012','C013','C018','C018-unknown','C018-poll','C019','C020','C021','C023','C024'];
const base=ids.map(id=>structuredClone(originals.find(c=>c.id===id)));
const missing=base.find(c=>c.id==='C019');missing.queries[0]='把刚才图片的背景换成蓝色，输出1:1图片，其余不变。';missing.expect.size='2048x2048';
base.push({id:'S017',name:'文字改写保留源文上下文',queries:['为虚构咖啡品牌松岚写一段介绍，仅输出文字。用户资料代号CTX_RIVER_731。','把刚才的介绍改写为口语风格，仅输出文字，保留品牌资料。'],expect:{text:1,noMedia:true,operations:['rewrite'],revision:true},contextMarker:'CTX_RIVER_731'});
base.push({id:'S018',name:'指定第二个真实图片引用',queries:['以第二张图片为首帧生成一条5秒16:9视频，不使用第一张。第一张：https://fixtures.invalid/first.png 第二张：https://fixtures.invalid/second.png'],expect:{video:1,reference:'https://fixtures.invalid/second.png',duration:5},forbiddenReference:'https://fixtures.invalid/first.png'});
export const cases=base.flatMap(c=>Array.from({length:3},(_,repeat)=>({...structuredClone(c),sourceId:c.id,id:c.id+'-r'+(repeat+1),repeat:repeat+1})));
