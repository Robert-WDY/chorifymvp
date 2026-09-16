import pathlib,json,shutil,zipfile,hashlib,re
P=pathlib.Path.cwd();R=P/'data/intermediate-eval-20260914';B=P/'data/focused-eval-v2-text-20260914'
D=pathlib.Path('C:/Users/asus/Desktop/codex-workspace/chorify-intermediate-eval-20260914');D.mkdir(exist_ok=True)
for n in ['评测报告.md','完整Trace.json','summary.audited.json','逐轮审计.json','图片提交与复用账本.json','visual-review.json']:
 shutil.copy2(R/n,D/n)
files=[]
for f in R.rglob('*'):
 if f.is_file() and 'private' not in f.relative_to(R).parts and f.suffix!='.bin':files.append((f,'evidence/'+f.relative_to(R).as_posix()))
for folder in ['source','suite']:
 for f in (B/folder).rglob('*'):
  if f.is_file():files.append((f,'source-version/'+folder+'/'+f.relative_to(B/folder).as_posix()))
files.append((B/'version.json','source-version/version.json'))
for n in ['eval-intermediate.mjs','eval-intermediate-correction.mjs','eval-intermediate-readonly.mjs','collect-intermediate-media.py','report-intermediate-eval.py','export-intermediate-eval.py']:
 files.append((P/'scripts'/n,'harness/'+n))
for n in ['评测报告.md','summary.audited.json']:files.append((R/n,n))
secrets=[]
for line in (P/'.env').read_text(encoding='utf-8').splitlines():
 if '=' not in line or line.lstrip().startswith('#'):continue
 key,value=line.split('=',1);value=value.strip().strip('\"').strip("'")
 if re.search('KEY|TOKEN|SECRET|PASSWORD',key,re.I) and len(value)>=12:secrets.append(value)
manifest=[];json_count=0;jsonl_records=0
for f,arc in files:
 assert not any(p in ['.env','private'] for p in pathlib.PurePosixPath(arc).parts)
 if f.suffix in ['.json','.jsonl','.mjs','.md','.py','.txt']:
  data=f.read_text(encoding='utf-8')
  assert not any(s in data for s in secrets),'Configured secret found in export file '+arc
  assert not re.search(r'\bsk-[a-zA-Z0-9_-]{20,}\b',data),'Possible key in '+arc
  if f.suffix=='.json':json.loads(data);json_count+=1
  if f.suffix=='.jsonl':
   for line in data.splitlines():
    if line.strip():json.loads(line);jsonl_records+=1
 manifest.append({'path':arc,'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
zpath=D/'Chorify-中间态复用评测-20260914.zip'
with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f,arc in files:z.write(f,arc)
 z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
with zipfile.ZipFile(zpath) as z:assert z.testzip() is None
result={'archive':str(zpath),'files':len(files),'zipBytes':zpath.stat().st_size,'zipSha256':hashlib.sha256(zpath.read_bytes()).hexdigest(),'validJSONFiles':json_count,'validJSONLRecords':jsonl_records,'configuredSecretsDetected':0,'privateFilesIncluded':0,'archiveIntegrity':'passed'}
(D/'导出校验.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
