const $=id=>document.getElementById(id);
let messages=[],config,running=false,controller;
try{const saved=JSON.parse(localStorage.getItem('ideas-room')||'[]');if(Array.isArray(saved))messages=saved.filter(m=>m&&typeof m.text==='string'&&typeof m.speaker==='string');}catch{}
function artifactLink(artifact){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(artifact?.id||''))return;
  $('artifact').href=`/api/artifacts/${artifact.id}`;$('artifact').download=`ideas-${artifact.id}.md`;$('artifact').hidden=false;
}
try{artifactLink(JSON.parse(localStorage.getItem('ideas-artifact')||'null'));}catch{}
let preferences={};
try{preferences=JSON.parse(localStorage.getItem('ideas-settings')||'{}')||{};}catch{}
for(const [id,key,values] of [['mode','mode',['subscription','live','demo']],['workflow','workflow',['discuss','draft','files']]])if(values.includes(preferences[key]))$(id).value=preferences[key];
if(typeof preferences.review==='boolean')$('review').checked=preferences.review;
if(typeof preferences.webSearch==='boolean')$('web-search').checked=preferences.webSearch;
function savePreferences(){try{localStorage.setItem('ideas-settings',JSON.stringify({mode:$('mode').value,workflow:$('workflow').value,writer:$('writer').value,review:$('review').checked,webSearch:$('web-search').checked}));}catch{}}

const phases={plan:'작업 계획',draft:'파일 초안',review:'다른 AI 검토',final:'검토 반영 수정본'};
const stage=m=>phases[m.phase]|| (m.round===3?'초안 검토':m.round===2?(m.workflow==='draft'?'작성자 초안':'상호 검토'):'독립 제안');
function save(){try{localStorage.setItem('ideas-room',JSON.stringify(messages));}catch{$('status').textContent='브라우저 저장에 실패했습니다. 회의록을 내보내세요.';}}
function render(){
  $('log').querySelectorAll('.bubble').forEach(e=>e.remove());$('welcome').hidden=messages.length>0;
  for(const m of messages){
    const card=document.createElement('article');card.className='bubble'+(m.speaker==='사용자'?' user':'')+(m.error?' error':'');
    const meta=document.createElement('div');meta.className='meta';const speaker=document.createElement('strong');speaker.textContent=m.speaker;meta.append(speaker);
    const label=document.createElement('span');label.textContent=m.speaker==='사용자'?'방향 제시':`${m.mode==='demo'?'데모 · ':''}${stage(m)}${m.error?' · 실패':''}`;meta.append(label);card.append(meta);
    const body=document.createElement('div');body.className='body';body.textContent=m.text;card.append(body);
    if(m.model){const usage=document.createElement('div');usage.className='usage';usage.textContent=m.model+(Number.isFinite(m.inputTokens)?` · 입력 ${m.inputTokens} / 출력 ${m.outputTokens??'미확인'} 토큰`:'')+(m.mode==='subscription'?' · 계정 사용량 한도 적용':m.costUSD!=null?` · 추정 $${m.costUSD.toFixed(5)}`:' · API 비용 미확인')+(m.truncated?' · 생성 한도 도달':'');card.append(usage);}
    if(m.webSearchEnabled){const research=document.createElement('div');research.className='usage';research.textContent=`검색 도구 호출 ${m.webSearchCount||0}회 · 페이지 확인 도구 호출 ${m.webFetchCount||0}회`+(!m.webSearchCount&&!m.webFetchCount?' · 이 답변에서는 도구 호출이 기록되지 않았습니다.':'');card.append(research);}
    if(Array.isArray(m.sources)&&m.sources.length){const sources=document.createElement('div');sources.className='sources';const title=document.createElement('span');title.textContent='답변의 출처 링크';sources.append(title);for(const href of m.sources.slice(0,12)){try{const url=new URL(href);if(url.protocol!=='https:'||url.username||url.password)continue;const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=url.hostname+url.pathname;sources.append(link);}catch{}}card.append(sources);}
    $('log').append(card);
  }
  const total=messages.reduce((sum,m)=>sum+(m.costUSD||0),0),unknown=messages.some(m=>m.mode==='live'&&(m.error||m.costUSD==null));
  $('cost').textContent=$('mode').value==='subscription'?'구독 계정의 사용량 한도 적용':`API 토큰 비용 추정 $${total.toFixed(4)}${unknown?' + 미확인 비용':''}`;
  $('log').scrollTop=$('log').scrollHeight;
}
function searchState(){$('web-search').disabled=running||$('mode').value!=='subscription';$('search-hint').textContent=$('mode').value==='subscription'?'조사가 필요하면 검색합니다. 검색어는 외부 검색 서비스로 전송됩니다.':'웹 검색 연결은 현재 기존 구독 모드에서 사용할 수 있습니다.';}
function state(active){running=active;for(const id of ['send','clear','mode','review','workflow','writer','refresh','refresh-results'])$(id).disabled=active;searchState();document.querySelectorAll('[name=participant],[name=file]').forEach(e=>e.disabled=active);$('stop').hidden=!active;}
function selected(){return [...document.querySelectorAll('[name=participant]:checked')].map(e=>e.value);}
function updateWriter(){
  const previous=$('writer').value||preferences.writer;$('writer').replaceChildren();
  for(const id of selected()){const option=document.createElement('option');option.value=id;option.textContent=config.participants.find(p=>p.id===id).name;$('writer').append(option);}
  if(selected().includes(previous))$('writer').value=previous;
  $('writer-field').hidden=!['draft','files'].includes($('workflow').value);
  $('limits').textContent=$('workflow').value==='files'?'구독 참가자 2명 · 최대 5회 호출 · 검토 필수. 파일은 별도 폴더에 저장하며 원본에 적용하지 않습니다.':'한 번에 최대 6회 호출. 자동 반복하지 않습니다. 원본 파일은 수정하지 않습니다.';
}
function showParticipants(preserve=false){
  const prior=selected(),mode=$('mode').value,people=mode==='subscription'?config.local:config.participants;
  $('participants').replaceChildren();
  for(const p of people){
    const label=document.createElement('label');label.className='person';const input=document.createElement('input');input.type='checkbox';input.name='participant';input.value=p.id;
    input.checked=preserve?prior.includes(p.id):mode==='demo'||p.ready;input.onchange=updateWriter;label.append(input);
    const name=document.createElement('strong');name.textContent=p.name;label.append(name);
    const sub=document.createElement('small');sub.textContent=mode==='subscription'?p.status:mode==='demo'?'실제 AI 호출 없음':`${p.model} · ${p.ready?'API 키 설정됨':'API 키 필요'}`;label.append(sub);$('participants').append(label);
  }
  updateWriter();searchState();render();
}
async function refresh(preserve=true){
  $('refresh').disabled=true;
  try{const response=await fetch('/api/config');if(!response.ok)throw new Error('연결 상태를 읽지 못했습니다.');config=await response.json();showParticipants(preserve);$('project-name').textContent=`자료 폴더: ${config.projectName}`;
    $('status').textContent=$('mode').value==='subscription'?`구독 연결 준비 ${config.local.filter(p=>p.ready).length}/3 · 로그인한 참가자를 선택해 시작하세요.`:'연결 상태를 갱신했습니다.';
  }catch(error){$('status').textContent=error.message;}finally{$('refresh').disabled=running;}
}

async function refreshResults(){
  try{
    const response=await fetch('/api/deliverables');const data=await response.json();if(!response.ok)throw new Error(data.error);
    $('deliverables').replaceChildren();
    if(!data.items.length){$('deliverables').textContent='아직 저장된 파일이 없습니다.';return;}
    for(const item of data.items){
      const card=document.createElement('details');card.className='result';const title=document.createElement('summary');title.textContent=item.task.slice(0,70);card.append(title);
      const info=document.createElement('p');const actor=id=>config?.participants.find(p=>p.id===id)?.name||id;info.textContent=`작성: ${actor(item.writer)} · 검토: ${(item.participants||[]).filter(id=>id!==item.writer).map(actor).join(', ')}\n`+new Date(item.createdAt).toLocaleString('ko-KR')+' · '+(item.status==='revised'?'검토 반영 수정본 · 재검토 전':item.status==='draft'?'검토 전 초안':'작성 시작');card.append(info);
      for(const version of item.versions){
        const button=document.createElement('button');button.className='secondary';button.textContent=(version==='final'?'수정본':'초안')+' 파일 보기';const contents=document.createElement('div');card.append(button,contents);
        button.onclick=async()=>{
          button.disabled=true;
          try{
            const url=`/api/deliverables/${item.id}/${version}/bundle`;const response=await fetch(url);if(!response.ok)throw new Error('파일을 읽지 못했습니다.');const bundle=await response.json();contents.replaceChildren();
            const summary=document.createElement('p');summary.textContent=bundle.summary;contents.append(summary);
            const all=document.createElement('a');all.href=url;all.textContent='전체 파일 묶음(JSON) 다운로드';all.className='result-link';contents.append(all);
            for(const file of bundle.files){const detail=document.createElement('details');const name=document.createElement('summary');name.textContent=file.path;detail.append(name);const link=document.createElement('a');link.className='result-link';link.href=`/api/deliverables/${item.id}/${version}/file?path=${encodeURIComponent(file.path)}`;link.textContent='파일 다운로드';detail.append(link);const preview=document.createElement('pre');preview.textContent=file.content;detail.append(preview);contents.append(detail);}
          }catch(error){contents.textContent=error.message;}finally{button.disabled=false;}
        };
      }
      $('deliverables').append(card);
    }
  }catch(error){$('deliverables').textContent=error.message;}
}

function onEvent(e,mode,workflow){
  if(e.type==='pending')$('status').textContent=`${stage({...e,workflow})} 진행 중 · ${e.speaker}`;
  if(e.type==='answer'||e.type==='error'){messages.push({...e,mode,workflow,error:e.type==='error'});save();render();}
  if(e.type==='notice')$('status').textContent=e.text;
  if(e.type==='deliverable'){refreshResults();}
  if(e.type==='artifact'){artifactLink(e);try{localStorage.setItem('ideas-artifact',JSON.stringify({id:e.id}));}catch{}}
  if(e.type==='done')$('status').textContent='회의가 끝났습니다. 결과물을 다운로드하거나 다음 방향을 입력하세요.';
}
$('composer').addEventListener('submit',async event=>{
  event.preventDefault();if(running||!config)return;
  const text=$('message').value.trim(),ids=selected(),mode=$('mode').value,workflow=$('workflow').value;
  if(!text)return;
  if(workflow==='files'&&(mode!=='subscription'||ids.length!==2||!$('review').checked)){$('status').textContent='파일 협업은 구독 참가자 2명을 선택하고 다른 참가자의 검토를 켜세요.';return;}
  if(!ids.length){$('status').textContent='참가자를 한 명 이상 선택하세요.';return;}
  const people=mode==='subscription'?config.local:config.participants;
  if(mode!=='demo'&&ids.some(id=>!people.find(p=>p.id===id).ready)){$('status').textContent=mode==='subscription'?'선택한 참가자의 계정으로 CLI에 로그인하고 상태를 새로고침하세요.':'선택한 참가자의 API 키를 .env에 설정하고 서버를 재시작하세요.';return;}
  const history=messages.filter(m=>!m.error&&m.mode!=='demo').map(m=>({speaker:m.speaker,text:m.text}));history.push({speaker:'사용자',text});
  if(history.length>100||history.reduce((n,m)=>n+m.text.length,0)>24000){$('status').textContent='대화가 길어졌습니다. 회의록을 내보낸 후 새 회의를 시작하세요.';return;}
  const files=[...document.querySelectorAll('[name=file]:checked')].map(e=>e.value);
  if(files.length>8){$('status').textContent='자료 파일은 최대 8개입니다.';return;}
  controller=new AbortController();state(true);$('status').textContent=mode==='subscription'?'구독 CLI를 호출합니다. 앱 화면을 조작하지 않습니다.':mode==='live'?'별도 과금 API 호출을 시작합니다.':'무료 데모를 시작합니다.';
  let failures=0,lastNotice='';$('artifact').hidden=true;
  try{
    const response=await fetch('/api/meeting',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({history,participants:ids,mode,review:$('review').checked,workflow,writer:$('writer').value,files,webSearch:mode==='subscription'&&$('web-search').checked}),signal:controller.signal});
    if(!response.ok){const data=await response.json();throw new Error(data.error);}
    messages.push({speaker:'사용자',text,mode,workflow});save();render();$('message').value='';
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',doneEvent=false;
    while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line){const e=JSON.parse(line);if(e.type==='done')doneEvent=true;if(e.type==='error')failures++;if(e.type==='notice')lastNotice=e.text;onEvent(e,mode,workflow);}}if(done)break;}
    if(!doneEvent)throw new Error('회의가 완료되지 않았습니다. 응답이 남아 있으면 회의록을 내보내세요.');
    if(failures||lastNotice)$('status').textContent=`회의 종료${failures?` · 실패한 응답 ${failures}개`:''}${lastNotice?` · ${lastNotice}`:''}`;
  }catch(error){$('status').textContent=error.name==='AbortError'?'회의를 중단했습니다. 이미 사용한 계정 한도나 API 비용은 되돌릴 수 없습니다.':error.message;}
  finally{state(false);$('message').focus();}
});
$('stop').onclick=()=>controller?.abort();
$('refresh-results').onclick=refreshResults;
$('refresh').onclick=()=>refresh(false);
$('workflow').onchange=()=>{if($('workflow').value==='files')$('review').checked=true;updateWriter();};
for(const id of ['mode','workflow','writer','review','web-search'])$(id).addEventListener('change',savePreferences);
$('mode').onchange=()=>{if(config)showParticipants();$('status').textContent=$('mode').value==='subscription'?'기존 계정으로 로그인한 CLI를 사용합니다. API 키를 사용하지 않습니다.':$('mode').value==='demo'?'무료 데모 · 실제 AI 답변을 생성하지 않습니다.':'API 모드 · 대화와 선택한 자료를 전송하고 별도 과금합니다.';};
$('example').onclick=()=>{$('message').value='나와 AI 동료들이 일주일 동안 함께 시도할 생산적인 실험 3개를 제안해줘. 하루에 30분만 쓸 수 있어.';$('message').focus();};
$('clear').onclick=()=>{if(messages.length&&!confirm('이 브라우저의 현재 회의를 지울까요? 필요한 기록은 먼저 내보내세요.'))return;messages=[];save();render();$('artifact').hidden=true;try{localStorage.removeItem('ideas-artifact');}catch{}$('status').textContent='새 회의를 시작하세요.';};
$('export').onclick=()=>{const markdown='# IDEAS 공동 회의록\n\n'+messages.map(m=>`## ${m.speaker} · ${m.mode==='demo'?'데모':m.speaker==='사용자'?'사용자':stage(m)}${m.error?' · 오류':''}\n\n${m.text}\n${m.model?'\n모델: '+m.model:''}`).join('\n\n');const url=URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='ideas-meeting.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const localServer=['127.0.0.1','localhost','::1','[::1]'].includes(location.hostname)&&!document.querySelector('meta[name="ideas-hosting"][content="static"]');
if(!localServer){
  config=null;
  $('status').textContent='웹 화면 배포 단계입니다. 원격 AI 서버 연결은 아직 준비되지 않았습니다.';
  $('participants').textContent='맥 워커 연결 후 GPT·Claude를 사용할 수 있습니다.';
  $('files').textContent='원격 서버 연결 후 자료를 선택할 수 있습니다.';
  $('deliverables').textContent='이 배포에는 맥의 회의 기록이나 결과 파일이 포함되지 않습니다.';
  $('cost').textContent='AI 서버 미연결 · 실제 호출 없음';
  for(const id of ['send','refresh','refresh-results','mode','workflow','writer','review','web-search','example'])$(id).disabled=true;
}else{
await refresh(false);
await refreshResults();
try{const response=await fetch('/api/files');const data=await response.json();if(!response.ok)throw new Error(data.error);for(const name of data.files){const label=document.createElement('label');label.className='file';const input=document.createElement('input');input.type='checkbox';input.name='file';input.value=name;const text=document.createElement('span');text.textContent=name;label.append(input,text);$('files').append(label);}}catch(error){$('files').textContent=error.message;}
}
render();
if(!localServer)$('cost').textContent='AI 서버 미연결 · 실제 호출 없음';
