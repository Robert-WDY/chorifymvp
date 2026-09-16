import pathlib,json,urllib.request,io,hashlib
from PIL import Image,ImageOps,ImageDraw
root=pathlib.Path('data/intermediate-eval-20260914');dest=root/'media';dest.mkdir(exist_ok=True)
receipts=json.loads((root/'private/media-receipts.json').read_text(encoding='utf-8'));entries=[]
for r in receipts:
    for i,d in enumerate(r.get('response',{}).get('data',[])):
        if not d.get('url'):continue
        name=f"{r['postIndex']:02d}-{i+1}.bin";p=dest/name
        if not p.exists():
            with urllib.request.urlopen(d['url'],timeout=40) as res:p.write_bytes(res.read(32*1024*1024))
        raw=p.read_bytes()
        with Image.open(io.BytesIO(raw)) as im:
            im.load();fmt=im.format;size=im.size;thumb=ImageOps.contain(im.convert('RGB'),(360,330))
        actual=p.with_suffix('.'+('jpg' if fmt=='JPEG' else fmt.lower()));actual.write_bytes(raw)
        entries.append({'postIndex':r['postIndex'],'context':r['context'],'receiptId':r['id'],'path':actual.as_posix(),'format':fmt,'size':size,'sha256':hashlib.sha256(raw).hexdigest(),'referenceCount':len(r['request'].get('image',[]))})
for page in range((len(entries)+7)//8):
    batch=entries[page*8:(page+1)*8];sheet=Image.new('RGB',(1440,780),'#efefef');draw=ImageDraw.Draw(sheet)
    for n,e in enumerate(batch):
        with Image.open(e['path']) as im:im=ImageOps.contain(im.convert('RGB'),(350,345))
        x=(n%4)*360;y=(n//4)*390;sheet.paste(im,(x+(360-im.width)//2,y+30));draw.text((x+8,y+8),f"#{e['postIndex']} {e['context']} refs={e['referenceCount']}",fill='black')
    sheet.save(dest/f'contact-{page+1}.jpg')
(dest/'index.json').write_text(json.dumps(entries,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'downloaded':len(entries),'posts':[e['postIndex'] for e in entries]}))
