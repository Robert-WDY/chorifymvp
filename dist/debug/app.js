import {flowView,historyView,globalView} from './focus-view.mjs';
import {label} from './readable.mjs';
const app=document.querySelector('#app');let current=null,tab='flow',version=0;
const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const link=(text,url)=>{const n=el('a',text);n.href=url;return n;};
const button=(text,fn)=>{const n=el('button',text);n.type='button';n.addEventListener('click',fn);return n;};
const card=(title,content)=>{const n=el('section','','card');n.append(el('h2',title),content);return n;};
const identity=r=>new URLSearchParams({runId:r.runId,sessionId:r.sessionId,source:r.source});
const address=r=>'#detail?'+identity(r);
async function api(path){const res=await fetch(path),data=await res.json();if(!res.ok)throw Error(data.error||'读取失败');return data;}
async function runs(params,v){
 const data=await api('/api/debug/runs?'+params);if(v!==version)return;
 app.append(el('h1','对话记录'));const form=el('form','','toolbar'),q=el('input');q.placeholder='搜索用户需求';q.setAttribute('aria-label','搜索用户需求');q.value=params.get('q')||'';const go=el('button','搜索');form.append(q,go);form.addEventListener('submit',e=>{e.preventDefault();location.hash='runs?'+new URLSearchParams({q:q.value});});app.append(form);
 for(const r of data.runs){const row=el('article','','run-row');row.append(link(r.query||'未记录用户需求',address(r)),el('span',label(r.status),'muted'),el('small',r.createdAt?new Date(r.createdAt).toLocaleString():''));app.append(row);}
 const offset=Number(params.get('offset')||0),pager=el('div','','pager');for(const [title,next,disabled] of [['上一页',offset-50,offset===0],['下一页',offset+50,offset+50>=data.total]]){const b=button(title,()=>{const p=new URLSearchParams(params);p.set('offset',String(next));location.hash='runs?'+p;});b.disabled=disabled;pager.append(b);}app.append(pager);
}
function render(r){
 current=r;app.replaceChildren();document.querySelector('#detail-link').href=address(r);
 const top=el('div','','toolbar');top.append(link('← 对话记录','#runs'));
 const rounds=el('select');rounds.setAttribute('aria-label','选择会话轮次');for(const t of r.sessionView?.rounds||[])rounds.add(new Option(`第 ${t.number} 轮 · ${t.query}`,t.runId));rounds.value=r.runId;rounds.addEventListener('change',()=>{location.hash=address({...r,runId:rounds.value});});top.append(rounds,button('继续这个会话',()=>window.dispatchEvent(new CustomEvent('debug:continue-session',{detail:r}))));app.append(top);
 const outcome=el('div','','outcome');outcome.append(card('用户需求',el('div',r.userInput.content,'query-text')),card('最终结果',el('div',r.finalResponse.text??(r.status==='running'?'正在执行，尚未返回。':'本轮没有保存最终回答。'),'query-text')));app.append(outcome,el('p','本轮状态：'+label(r.status),'run-status'));
 if(r.evaluation?.cutoff)app.append(el('p','这条评测记录在需求接受后主动停止，后续执行没有发生。','muted'));
 const nav=el('div','','tabs'),host=el('div');const views={flow:['子意图流程',flowView],history:['历史上下文',historyView],global:['全局 State',globalView]};
 const show=key=>{tab=key;host.replaceChildren();for(const b of nav.children)b.classList.toggle('active',b.dataset.key===key);views[key][1](r,host);};for(const [key,[title]] of Object.entries(views)){const b=button(title,()=>show(key));b.dataset.key=key;nav.append(b);}app.append(nav,host);show(tab);
}
async function route(){const v=++version,[page,query='']=(location.hash.slice(1)||'runs').split('?'),p=new URLSearchParams(query);app.replaceChildren(el('p','正在读取…'));try{if(page==='runs')return await runs(p,v);if(!p.get('runId')){app.replaceChildren(link('请选择一条对话记录','#runs'));return;}const r=await api('/api/debug/run/'+p.get('runId')+'?'+new URLSearchParams({sessionId:p.get('sessionId')||'',source:p.get('source')||''}));if(v===version)render(r);}catch(e){if(v===version)app.replaceChildren(el('p',e.message),link('返回对话记录','#runs'));}}
window.addEventListener('hashchange',route);
window.addEventListener('debug:trace',event=>{
 const r=event.detail,p=new URLSearchParams(location.hash.split('?')[1]);if(p.get('runId')!==r.runId||p.get('sessionId')!==r.sessionId||p.get('source')!==r.source)return;
 const y=scrollY,opened=new Map([...app.querySelectorAll('details[data-read-key]')].map(d=>[d.dataset.readKey,d.open])),selectors=new Map([...app.querySelectorAll('select[aria-label]')].map(n=>[n.getAttribute('aria-label'),n.value]));
 ++version;render(r);for(const n of app.querySelectorAll('select[aria-label]')){const value=selectors.get(n.getAttribute('aria-label'));if(value!==undefined&&n.getAttribute('aria-label')!=='选择会话轮次'&&[...n.options].some(o=>o.value===value)){n.value=value;n.dispatchEvent(new Event('change'));}}
 for(const d of app.querySelectorAll('details[data-read-key]'))if(opened.has(d.dataset.readKey))d.open=opened.get(d.dataset.readKey);window.scrollTo(0,y);
});
route();
