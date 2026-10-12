const $=id=>document.getElementById(id);
let messages=[],config,running=false,controller,currentRoom='platform',rooms=[],remoteJob=null;
const apiUrl=route=>route+(route.includes('?')?'&':'?')+'roomId='+encodeURIComponent(currentRoom);
const api=(route,options)=>fetch(apiUrl(route),options);
try{const saved=JSON.parse(localStorage.getItem('ideas-room')||'[]');if(Array.isArray(saved))messages=saved.filter(m=>m&&typeof m.text==='string'&&typeof m.speaker==='string');}catch{}
function artifactLink(artifact){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(artifact?.id||''))return;
  $('artifact').href=apiUrl(`/api/artifacts/${artifact.id}`);$('artifact').download=`ideas-${artifact.id}.md`;$('artifact').hidden=false;
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
function save(){try{localStorage.setItem('ideas-room:'+currentRoom,JSON.stringify(messages));}catch{$('status').textContent='브라우저 저장에 실패했습니다. 회의록을 내보내세요.';}}
function renderText(root,text){
  let code=null;
  for(const line of text.split('\n')){
    if(line.startsWith('```')){if(code)code=null;else{code=document.createElement('pre');root.append(code);}continue;}
    if(code){code.textContent+=line+'\n';continue;}if(!line.trim())continue;
    const heading=/^#{1,3}\s+(.+)$/.exec(line);const paragraph=document.createElement(heading?'h3':'p');const value=heading?heading[1]:line;
    const parts=value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g);
    for(const part of parts){if(part.startsWith('**')&&part.endsWith('**')){const strong=document.createElement('strong');strong.textContent=part.slice(2,-2);paragraph.append(strong);}else if(part.startsWith('`')&&part.endsWith('`')){const inline=document.createElement('code');inline.textContent=part.slice(1,-1);paragraph.append(inline);}else{const link=/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);if(link){const a=document.createElement('a');a.href=link[2];a.textContent=link[1];a.target='_blank';a.rel='noopener noreferrer';paragraph.append(a);}else paragraph.append(document.createTextNode(part));}}
    root.append(paragraph);
  }
}
function render(){
  $('log').querySelectorAll('.bubble').forEach(e=>e.remove());$('welcome').hidden=messages.length>0;
  for(const m of messages){
    const card=document.createElement('article');card.className='bubble'+(m.speaker==='사용자'?' user':'')+(m.error?' error':'');
    const meta=document.createElement('div');meta.className='meta';const speaker=document.createElement('strong');speaker.textContent=m.speaker;meta.append(speaker);
    const label=document.createElement('span');label.textContent=m.speaker==='사용자'?'방향 제시':`${m.mode==='demo'?'데모 · ':''}${stage(m)}${m.error?' · 실패':''}`;meta.append(label);card.append(meta);
    const body=document.createElement('div');body.className='body';renderText(body,m.text);card.append(body);
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
function state(active){running=active;for(const id of ['send','clear','mode','review','workflow','writer','refresh','refresh-results','home','save-project','logout','resume-job'])$(id).disabled=active;searchState();document.querySelectorAll('[name=participant],[name=file]').forEach(e=>e.disabled=active);$('stop').hidden=!active;}
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
  try{const response=await api('/api/config');if(!response.ok)throw new Error('연결 상태를 읽지 못했습니다.');config=await response.json();showParticipants(preserve);$('project-name').textContent=`자료 폴더: ${config.projectName}`;
    $('status').textContent=$('mode').value==='subscription'?`구독 연결 준비 ${config.local.filter(p=>p.ready).length}/3 · 로그인한 참가자를 선택해 시작하세요.`:'연결 상태를 갱신했습니다.';
  }catch(error){$('status').textContent=error.message;}finally{$('refresh').disabled=running;}
}

async function refreshResults(){
  try{
    const response=await api('/api/deliverables');const data=await response.json();if(!response.ok)throw new Error(data.error);
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
            const url=`/api/deliverables/${item.id}/${version}/bundle`;const response=await api(url);if(!response.ok)throw new Error('파일을 읽지 못했습니다.');const bundle=await response.json();contents.replaceChildren();
            const summary=document.createElement('p');summary.textContent=bundle.summary;contents.append(summary);
            const all=document.createElement('a');all.href=apiUrl(url);all.textContent='전체 파일 묶음(JSON) 다운로드';all.className='result-link';contents.append(all);
            for(const file of bundle.files){const detail=document.createElement('details');const name=document.createElement('summary');name.textContent=file.path;detail.append(name);const link=document.createElement('a');link.className='result-link';link.href=apiUrl(`/api/deliverables/${item.id}/${version}/file?path=${encodeURIComponent(file.path)}`);link.textContent='파일 다운로드';detail.append(link);const preview=document.createElement('pre');preview.textContent=file.content;detail.append(preview);contents.append(detail);}
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
  if(e.type==='artifact'){artifactLink(e);try{localStorage.setItem('ideas-artifact:'+currentRoom,JSON.stringify({id:e.id}));}catch{}}
  if(e.type==='done')$('status').textContent='회의가 끝났습니다. 결과물을 다운로드하거나 다음 방향을 입력하세요.';
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function remoteJson(route,options){const response=await fetch(route,options);let data;try{data=await response.json();}catch{throw new Error('원격 연결 응답을 읽지 못했습니다. 잠시 후 다시 조회하세요.');}if(!response.ok){if(response.status===401)showLogin();const error=new Error(data.error||'원격 요청에 실패했습니다.');error.status=response.status;throw error;}return data;}
async function pollJob(id,onUpdate){
  let cursor=0,failures=0;
  while(true){
    let job;try{job=await remoteJson(`/api/jobs/${id}?after=${cursor}`);failures=0;}catch(error){if(++failures>=5)throw new Error(error.message+' 작업은 맥에서 계속 실행될 수 있습니다. 모든 회의실에서 이전 작업을 다시 조회하세요.');$('status').textContent=`결과 연결 재시도 ${failures}/5 · 맥의 작업 완료 여부는 아직 확인되지 않았습니다.`;await pause(3000);continue;}
    await onUpdate?.(job);cursor=job.cursor;
    if(['done','failed','cancelled','interrupted'].includes(job.status)){localStorage.removeItem('ideas-pending-job');$('resume-job').hidden=true;remoteJob=null;if(job.status!=='done')throw new Error(job.error||'작업이 완료되지 않았습니다.');return job.result;}
    await pause(2000);
  }
}
async function submitRemoteJob(type,request,onUpdate){
  const id=crypto.randomUUID();remoteJob=id;localStorage.setItem('ideas-pending-job',id);$('resume-job').hidden=false;
  try{await remoteJson('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,type,request})});}catch(error){if(error.status>=400&&error.status<500){remoteJob=null;localStorage.removeItem('ideas-pending-job');$('resume-job').hidden=true;}throw error;}
  return pollJob(id,onUpdate);
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
    const request={roomId:currentRoom,history,participants:ids,mode,review:$('review').checked,workflow,writer:$('writer').value,files,webSearch:mode==='subscription'&&$('web-search').checked};
    if(!localServer){
      messages.push({speaker:'사용자',text,mode,workflow});save();render();$('message').value='';$('status').textContent='맥에서 회의를 시작합니다. 토론은 보통 1~5분, 파일 협업은 최대 10분 걸릴 수 있습니다.';
      await submitRemoteJob('meeting',request,job=>{for(const e of job.events){if(e.type==='error')failures++;if(e.type==='notice')lastNotice=e.text;onEvent(e,mode,workflow);}});
      if(failures||lastNotice)$('status').textContent=`회의 종료${failures?` · 실패한 응답 ${failures}개`:''}${lastNotice?` · ${lastNotice}`:''}`;return;
    }
    const response=await api('/api/meeting',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal});
    if(!response.ok){const data=await response.json();throw new Error(data.error);}
    messages.push({speaker:'사용자',text,mode,workflow});save();render();$('message').value='';
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',doneEvent=false;
    while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line){const e=JSON.parse(line);if(e.type==='done')doneEvent=true;if(e.type==='error')failures++;if(e.type==='notice')lastNotice=e.text;onEvent(e,mode,workflow);}}if(done)break;}
    if(!doneEvent)throw new Error('회의가 완료되지 않았습니다. 응답이 남아 있으면 회의록을 내보내세요.');
    if(failures||lastNotice)$('status').textContent=`회의 종료${failures?` · 실패한 응답 ${failures}개`:''}${lastNotice?` · ${lastNotice}`:''}`;
  }catch(error){$('status').textContent=error.name==='AbortError'?'회의를 중단했습니다. 이미 사용한 계정 한도나 API 비용은 되돌릴 수 없습니다.':error.message;}
  finally{state(false);$('message').focus();}
});
$('stop').onclick=async()=>{if(localServer)controller?.abort();else if(remoteJob){try{await remoteJson(`/api/jobs/${remoteJob}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});$('status').textContent='맥에 중단을 요청했습니다.';}catch(error){$('status').textContent=error.message;}}};
$('refresh-results').onclick=refreshResults;
$('refresh').onclick=()=>refresh(false);
$('workflow').onchange=()=>{if($('workflow').value==='files')$('review').checked=true;updateWriter();};
for(const id of ['mode','workflow','writer','review','web-search'])$(id).addEventListener('change',savePreferences);
$('mode').onchange=()=>{if(config)showParticipants();$('status').textContent=$('mode').value==='subscription'?'기존 계정으로 로그인한 CLI를 사용합니다. API 키를 사용하지 않습니다.':$('mode').value==='demo'?'무료 데모 · 실제 AI 답변을 생성하지 않습니다.':'API 모드 · 대화와 선택한 자료를 전송하고 별도 과금합니다.';};
$('example').onclick=()=>{$('message').value='나와 AI 동료들이 일주일 동안 함께 시도할 생산적인 실험 3개를 제안해줘. 하루에 30분만 쓸 수 있어.';$('message').focus();};
$('clear').onclick=async()=>{if(messages.length&&!confirm('현재 대화를 새로 시작할까요? 이미 저장한 회의록과 결과 파일은 남습니다.'))return;try{const response=await api('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:true})});if(!response.ok)throw new Error((await response.json()).error);messages=[];save();render();$('artifact').hidden=true;localStorage.removeItem('ideas-artifact:'+currentRoom);$('status').textContent='새 대화를 시작하세요.';}catch(error){$('status').textContent=error.message;}};
$('export').onclick=()=>{const markdown='# IDEAS 공동 회의록\n\n'+messages.map(m=>`## ${m.speaker} · ${m.mode==='demo'?'데모':m.speaker==='사용자'?'사용자':stage(m)}${m.error?' · 오류':''}\n\n${m.text}\n${m.model?'\n모델: '+m.model:''}`).join('\n\n');const url=URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='ideas-meeting.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const localServer=['127.0.0.1','localhost','::1','[::1]'].includes(location.hostname)&&!document.querySelector('meta[name="ideas-hosting"][content="static"]');
async function loadFiles(){
  $('files').replaceChildren();try{const response=await api('/api/files');const data=await response.json();if(!response.ok)throw new Error(data.error);for(const name of data.files){const label=document.createElement('label');label.className='file';const input=document.createElement('input');input.type='checkbox';input.name='file';input.value=name;const text=document.createElement('span');text.textContent=name;label.append(input,text);$('files').append(label);}}catch(error){$('files').textContent=error.message;}
}
async function loadRooms(){
  const response=await fetch('/api/rooms');if(!response.ok)throw new Error('회의실 목록을 읽지 못했습니다.');rooms=(await response.json()).items;$('room-grid').replaceChildren();
  for(const room of rooms){const card=document.createElement('article');card.className='room-card';const kind=document.createElement('span');kind.className='room-kind';kind.textContent=room.kind==='platform'?'회의실 프로그램 개발':'프로젝트 작업 공간';const title=document.createElement('h2');title.textContent=room.name;const root=document.createElement('code');root.textContent=room.root;const status=document.createElement('p');status.textContent=room.git.branch?`${room.git.branch} · 변경 ${room.git.changes}개 · ${room.git.commit}`:'Git 상태 확인 필요';card.append(kind,title,root,status);if(room.repo){const repo=document.createElement('a');repo.href=room.repo;repo.target='_blank';repo.rel='noopener noreferrer';repo.textContent=room.repo.replace('https://github.com/','');card.append(repo);}const button=document.createElement('button');button.textContent='회의실 열기 →';button.onclick=()=>openRoom(room.id);card.append(button);$('room-grid').append(card);}
  $('dashboard-status').textContent=`연결된 회의실 ${rooms.length}개 · 방마다 자료·대화·결과가 분리됩니다.`;$('worker-state').textContent=localServer?'로컬 맥 워커 연결됨':'원격 맥 워커 연결됨';
}
async function openRoom(id){
  if(running)return;currentRoom=id;config=null;$('dashboard').hidden=true;$('room-view').hidden=false;$('artifact').hidden=true;$('message').value='';location.hash='room='+id;
  const room=rooms.find(r=>r.id===id);$('room-title').textContent=room.name;$('active-room-name').textContent=room.name;$('active-room-path').textContent=room.root;$('git-state').textContent=room.git.branch?`${room.git.branch} · 변경 ${room.git.changes}개`:'Git 상태 확인 필요';
  try{const response=await api('/api/session');if(!response.ok)throw new Error();messages=(await response.json()).messages;if(!messages.length){const key=id==='platform'?'ideas-room':'ideas-room:'+id;try{messages=JSON.parse(localStorage.getItem(key)||'[]');}catch{messages=[];}}}catch{messages=[];$('status').textContent='저장된 대화를 읽지 못했습니다.';}
  try{artifactLink(JSON.parse(localStorage.getItem('ideas-artifact:'+id)||(id==='platform'?localStorage.getItem('ideas-artifact'):'null')||'null'));}catch{}
  render();await refresh(false);await Promise.all([refreshResults(),loadFiles()]);
}
function showLogin(){$('login-view').hidden=false;$('dashboard').hidden=true;$('room-view').hidden=true;$('logout').hidden=true;$('worker-state').textContent='회의실 로그인 필요';}
async function initializeRooms(){
  if(!localServer){const auth=await remoteJson('/api/auth/status');$('logout').hidden=false;if(auth.activeJob)localStorage.setItem('ideas-pending-job',auth.activeJob.id);}
  $('login-view').hidden=true;$('dashboard').hidden=false;$('local-access').hidden=true;await loadRooms();const id=new URLSearchParams(location.hash.slice(1)).get('room');if(rooms.some(r=>r.id===id))await openRoom(id);else if(location.hash==='#new-room')$('new-room').click();$('resume-job').hidden=localServer||!localStorage.getItem('ideas-pending-job');
}
$('login-form').onsubmit=async event=>{event.preventDefault();$('login-submit').disabled=true;$('login-status').textContent='맥 워커에 로그인하고 있습니다.';try{await remoteJson('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('login-password').value})});$('login-password').value='';await initializeRooms();}catch(error){$('login-status').textContent=error.message;}finally{$('login-submit').disabled=false;}};
$('logout').onclick=async()=>{if(running)return;try{await remoteJson('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});showLogin();messages=[];rooms=[];config=null;$('log').querySelectorAll('.bubble').forEach(e=>e.remove());$('room-grid').replaceChildren();$('login-status').textContent='로그아웃했습니다.';}catch(error){$('status').textContent=error.message;}};
$('home').onclick=async()=>{if(running)return;$('room-view').hidden=true;$('dashboard').hidden=false;history.replaceState(null,'',location.pathname);try{await loadRooms();$('resume-job').hidden=localServer||!localStorage.getItem('ideas-pending-job');}catch(error){$('dashboard-status').textContent=error.message;}};
$('new-room').onclick=()=>{$('room-form').hidden=false;$('room-name').focus();};$('cancel-room').onclick=()=>{$('room-form').hidden=true;};
$('room-form').onsubmit=async event=>{event.preventDefault();$('connect-room').disabled=true;$('new-room').disabled=true;$('dashboard-status').textContent='맥에서 저장소를 클론하고 연결하고 있습니다. 네트워크에 따라 1~2분 걸릴 수 있습니다.';try{const request={name:$('room-name').value,repo:$('room-repo').value};let data;if(localServer){const response=await fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});data=await response.json();if(!response.ok)throw new Error(data.error);}else data=await submitRemoteJob('connect-room',request);await loadRooms();$('room-form').hidden=true;await openRoom(data.room.id);}catch(error){$('dashboard-status').textContent=error.message;}finally{$('connect-room').disabled=false;$('new-room').disabled=false;}};
$('save-project').onclick=async()=>{if(running)return;$('save-project').disabled=true;$('status').textContent='맥에서 이 프로젝트의 대화·결과를 검사하고 커밋·푸시하고 있습니다.';try{let data;if(localServer){const response=await api('/api/room-save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:currentRoom})});data=await response.json();if(!response.ok)throw new Error(data.error);}else data=await submitRemoteJob('save-room',{roomId:currentRoom});$('status').textContent=`GitHub 저장 완료 · ${data.branch} · ${data.commit} · 변경 파일 ${data.files}개`;await loadRooms();const room=rooms.find(r=>r.id===currentRoom);$('git-state').textContent=`${room.git.branch} · 변경 ${room.git.changes}개 · ${room.git.commit}`;}catch(error){$('status').textContent=error.message;}finally{$('save-project').disabled=false;}};
$('resume-job').onclick=async()=>{const id=localStorage.getItem('ideas-pending-job');if(!id)return;try{const job=await remoteJson(`/api/jobs/${id}?after=0`);if(job.type==='meeting'){await loadRooms();await openRoom(job.roomId);messages=(job.history||[]).map(m=>({...m,mode:job.mode,workflow:job.workflow}));render();state(true);remoteJob=id;await pollJob(id,data=>{for(const e of data.events)onEvent(e,job.mode,job.workflow);});}else{remoteJob=id;await pollJob(id);await loadRooms();$('dashboard-status').textContent='이전 작업 결과를 확인했습니다.';}}catch(error){$('status').textContent=error.message;$('dashboard-status').textContent=error.message;}finally{state(false);}};
try{await initializeRooms();}catch(error){if(!localServer){showLogin();$('login-status').textContent=error.message;}else{$('dashboard-status').textContent=error.message;$('worker-state').textContent='연결 확인 필요';}}
