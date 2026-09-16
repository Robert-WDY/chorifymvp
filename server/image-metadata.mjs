import {tools} from './tool-schemas.mjs';
export function imageDimensions(bytes){
 const b=Buffer.from(bytes);
 if(b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
 if(b.length<4||b[0]!==255||b[1]!==216)return null;
 for(let p=2;p+4<=b.length;){if(b[p++]!==255)return null;while(b[p]===255)p++;const marker=b[p++];if(marker===217||marker===218)return null;const length=b.readUInt16BE(p);if(length<2||p+length>b.length)return null;if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)return {width:b.readUInt16BE(p+5),height:b.readUInt16BE(p+3)};p+=length;}return null;
}
export async function inheritedImageSize(url,artifacts,{fetcher=fetch}={}){
 const source=Object.values(artifacts).find(a=>a.url===url);
 let size=source?.metadata?.provider?.size||source?.metadata?.args?.size;
 if(!/^\d+x\d+$/.test(size||'')){
  const parsed=new URL(url);if(parsed.protocol!=='https:'||!['ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com','ark-content-generation-cn-beijing.tos-cn-beijing.volces.com'].includes(parsed.hostname))throw new Error('无法读取原图尺寸，请提供原图宽高或明确目标比例');
  const response=await fetcher(url,{headers:{Range:'bytes=0-131071'},redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('原图尺寸读取失败');
  const reader=response.body.getReader();let bytes=Buffer.alloc(0),dimensions;
  try{while(bytes.length<131072){const {done,value}=await reader.read();if(done)break;bytes=Buffer.concat([bytes,Buffer.from(value).subarray(0,131072-bytes.length)]);dimensions=imageDimensions(bytes);if(dimensions)break;}}finally{await reader.cancel();}
  if(!dimensions?.width||!dimensions?.height)throw new Error('无法确认原图尺寸，编辑尚未提交');size=dimensions.width+'x'+dimensions.height;
 }
 const supported=tools.find(t=>t.name==='generate_image').parameters.properties.size.enum;
 if(!supported.includes(size))throw new Error('当前编辑不支持保持原图尺寸 '+size+'，请明确目标比例');
 return size;
}
