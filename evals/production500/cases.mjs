import {readFileSync} from 'node:fs';
export const originals=JSON.parse(readFileSync(new URL('./source-cases.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
// Offline evaluation labels only. This map is never passed to the model or router.
const missing={states:['needs_input'],noMedia:true,missing:true};
const text={states:['completed'],text:1,noMedia:true};
const video={states:['simulated'],video:1};
const labels={
 '帮我做一个适合TikTok投放的产品视频':video,
 '分析这个爆款视频为什么有效':missing,
 '用我的产品素材做一个短视频广告':missing,
 '生成10个不同Hook版本':{...text,units:10},
 '继续刚才没有完成的视频':missing,
 '把刚才的视频改得更年轻':missing,
 '我要推广一个新品精华到巴西市场':text,
 '先给营销方案确认后再生成视频':{states:['needs_input'],noMedia:true,waitConfirm:true},
 '没有素材但是想测试广告方向':text,
 '生成15秒9:16护肤广告视频':{states:['blocked'],noMedia:true,gap:true,duration:15},
 '用产品图生成真人使用场景':missing,
 '输出完整营销方案':text,
 '生成5个广告素材':{states:['completed','simulated','needs_input'],flexibleUnits:5},
 '把第二版改成更高级一点':missing,
 '确认刚才的方案':missing,
 '视频生成失败了怎么办':text,
 '刚才任务中断继续':missing,
 '我要最终可以投放的视频':video,
 '优化成品质量':missing,
 '重新生成第3条':missing,
 '素材不存在怎么办':text,
 '做一个品牌新品发布视频':video,
 '把视频中的背景替换掉':missing,
 '用户改成生成图片':{states:['simulated'],image:1},
};
export const cases=originals.map(source=>{
 const queries=source.conversation.filter(m=>m.role==='user').map(m=>m.content),expect=labels[queries.at(-1)];
 if(!expect)throw new Error('Missing explicit evaluation label for '+source.id);
 return{id:source.id,sourceId:source.id,name:queries.at(-1),queries,expect:{...expect},businessContext:source.business_context,original:source,level:source.level};
});
if(cases.length!==500||new Set(cases.map(c=>c.id)).size!==500)throw new Error('Expected exactly 500 unique case IDs');
