import { randomUUID } from 'node:crypto';
export function rememberAssets(state,result,source) {
  state.assets??=[];
  const add=(url,kind)=>{ if(url&&!state.assets.some(a=>a.url===url)) state.assets.push({assetId:randomUUID(),url,kind,source,createdAt:new Date().toISOString()}); };
  for(const item of result.images||[]) add(item.url,'image');
  add(result.videoUrl,'video');add(result.audioUrl,'audio');
  for(const item of result.scenes||[]) add(item.videoUrl,'video');
}
export function rememberUserAssets(state,message) {
  for(const match of message.matchAll(/https:\/\/[^\s<>"，。；）)]+/g)) {
    const url=match[0];let path;try{path=new URL(url).pathname;}catch{continue;}
    const kind=/\.(png|jpe?g|webp|gif)$/i.test(path)?'image':/\.(mp4|mov|webm)$/i.test(path)?'video':/\.(mp3|wav|m4a|ogg)$/i.test(path)?'audio':null;
    if(kind) rememberAssets(state,kind==='image'?{images:[{url}]}:{[kind+'Url']:url},'用户提供');
  }
}
