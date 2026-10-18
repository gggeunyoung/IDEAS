import {newProgress,progressEvent,progressJob,progressView,replayHistory} from './progress.js';
const $=id=>document.getElementById(id);
// Shown by default in index.html; only a page actually served by the room server reaches this line.
$('boot-warning')?.remove();
let messages=[],config,running=false,controller,currentRoom='platform',rooms=[],remoteJob=null;
const apiUrl=route=>route+(route.includes('?')?'&':'?')+'roomId='+encodeURIComponent(currentRoom);
const api=async(route,options)=>{const response=await fetch(apiUrl(route),options);if(response.status===401&&!localServer)showLogin();return response;};
try{const saved=JSON.parse(localStorage.getItem('ideas-room')||'[]');if(Array.isArray(saved))messages=saved.filter(m=>m&&typeof m.text==='string'&&typeof m.speaker==='string');}catch{}
function artifactLink(artifact){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(artifact?.id||''))return;
  $('artifact').href=apiUrl(`/api/artifacts/${artifact.id}`);$('artifact').download=`ideas-${artifact.id}.md`;$('artifact').hidden=false;
}
try{artifactLink(JSON.parse(localStorage.getItem('ideas-artifact')||'null'));}catch{}
let preferences={};
try{preferences=JSON.parse(localStorage.getItem('ideas-settings')||'{}')||{};}catch{}
for(const [id,key,values] of [['mode','mode',['subscription','live','demo']],['workflow','workflow',['discuss','draft','files','goal','team']]])if(values.includes(preferences[key]))$(id).value=preferences[key];
if(['research','build'].includes(preferences.teamFocus))$('team-focus').value=preferences.teamFocus;
if(typeof preferences.review==='boolean')$('review').checked=preferences.review;
if(typeof preferences.webSearch==='boolean')$('web-search').checked=preferences.webSearch;
function savePreferences(){preferences={workflowVersion:2,teamFocus:$('team-focus').value,mode:$('mode').value,workflow:$('workflow').value,writer:$('writer').value,review:$('review').checked,webSearch:$('web-search').checked};try{localStorage.setItem('ideas-settings',JSON.stringify(preferences));}catch{}}

const goalLabels={complete:'완료',field_pending:'현장 검증 대기',blocked:'해결 장애',budget_exhausted:'실행 예산 도달',stalled:'진전 없이 반복',cancelled:'사용자 중단',failed:'실행 실패',goal_running:'목표 실행 중',need_user:'사용자 결정 필요'};
const phases={team:'팀 작업',implement:'실제 구현',execute:'실제 작업 상태',plan:'작업 계획',draft:'파일 초안',review:'다른 AI 검토',final:'검토 반영 수정본'};
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
function state(active){running=active;for(const id of ['send','clear','mode','review','workflow','writer','refresh','refresh-results','home','save-project','logout','resume-job','goal-minutes','goal-calls','team-minutes','team-turns','team-new','team-focus'])$(id).disabled=active;searchState();document.querySelectorAll('[name=participant],[name=file]').forEach(e=>e.disabled=active);$('stop').hidden=!active;}
let executionProgress=null;
function renderProgress(){
  $('execution-progress').hidden=!executionProgress;if(!executionProgress)return;
  const view=progressView(executionProgress);$('execution-progress').dataset.state=view.state;
  const label=executionProgress.finalLabel?goalLabels[executionProgress.finalLabel]:'';
  const title=view.title+(label?' · '+label:'');if($('progress-title').textContent!==title)$('progress-title').textContent=title;
  $('progress-meta').textContent=[view.elapsed,view.answers,view.connection].join(' · ');
  $('progress-agents').replaceChildren();
  for(const agent of view.agents){const row=document.createElement('div');row.className='progress-agent';const name=document.createElement('strong');name.textContent=agent.speaker;const detail=document.createElement('span');detail.textContent=agent.detail;const note=document.createElement('small');note.textContent=agent.note;row.append(name,detail,note);$('progress-agents').append(row);}
  $('progress-hint').textContent=view.state==='running'?'맥에서 작업이 실행 중입니다. 세부 상태는 CLI가 실제로 보고한 활동만 표시합니다.':view.state==='unknown'?'작업은 맥에서 계속될 수 있습니다. 연결 상태와 AI 실행 상태는 별개입니다.':executionProgress.terminal==='done'?'이번 실행이 끝났습니다. 종료 사유와 결과물을 확인하세요.':'종료 사유를 확인한 뒤 다시 시작하거나 이전 작업을 조회하세요.';
}
function startProgress(startedAt=null){executionProgress=newProgress(startedAt);renderProgress();}
function progressFailure(terminal='unknown'){if(!executionProgress)return;if(terminal==='unknown')executionProgress.connection='offline';else executionProgress.terminal=terminal;renderProgress();}
setInterval(()=>{if(executionProgress&&!executionProgress.terminal)renderProgress();},1000);
function selected(){return [...document.querySelectorAll('[name=participant]:checked')].map(e=>e.value);}
function updateWriter(){
  const previous=$('writer').value||preferences.writer;$('writer').replaceChildren();
  for(const id of selected()){const option=document.createElement('option');option.value=id;option.textContent=config.participants.find(p=>p.id===id).name;$('writer').append(option);}
  if(selected().includes(previous))$('writer').value=previous;
  $('writer-field').hidden=!['draft','files','goal','team'].includes($('workflow').value);
  $('writer-field').firstChild.textContent=$('workflow').value==='team'?'먼저 시작할 에이전트':'초안 작성자';
  $('team-budget').hidden=$('workflow').value!=='team';$('review').closest('label').hidden=$('workflow').value==='team';
  for(const option of $('team-turns').options)option.disabled=$('team-focus').value==='research'&&Number(option.value)<6;
  if($('team-focus').value==='research'&&Number($('team-turns').value)<6)$('team-turns').value='16';
  $('goal-budget').hidden=$('workflow').value!=='goal';
  $('limits').textContent=$('workflow').value==='team'?($('team-focus').value==='research'?'시간·차례 예산 안에서 조사·대안·반론·보완을 계속합니다. 파일 수정이 없다고 3차례 만에 끝내지 않습니다. 근거·분석·기획 파일과 두 사람의 검토가 필요합니다.':'두 에이전트가 설정한 시간·차례 안에서 교대로 구현하고 확인합니다.'):$('workflow').value==='goal'?'목표 실행은 설정한 시간·호출 예산 안에서 반복합니다. 실제 테스트와 다른 AI 검토를 거쳐 종료 상태를 남깁니다.':$('workflow').value==='files'?'구독 참가자 2명 · 최대 5회 호출 · 검토 필수. 파일은 별도 폴더에 저장하며 원본에 적용하지 않습니다.':'한 번에 최대 6회 호출. 자동 반복하지 않습니다. 원본 파일은 수정하지 않습니다.';
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
      const info=document.createElement('p');const actor=id=>config?.participants.find(p=>p.id===id)?.name||id;info.textContent=`작성: ${actor(item.writer)} · 검토: ${(item.participants||[]).filter(id=>id!==item.writer).map(actor).join(', ')}\n`+new Date(item.createdAt).toLocaleString('ko-KR')+' · '+(goalLabels[item.status]|| (item.status==='revised'?'검토 반영 수정본 · 재검토 전':item.status==='draft'?'검토 전 초안':'작성 시작'));card.append(info);
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
  if(!executionProgress)startProgress();
  progressEvent(executionProgress,e);if(['pending','activity','answer','error','goal','done','heartbeat'].includes(e.type)){if(localServer){executionProgress.checkedAt=Date.now();executionProgress.connection='online';}renderProgress();}
  if(e.type==='pending')$('status').textContent=`${stage({...e,workflow})} 진행 중 · ${e.speaker}`;
  if(e.type==='answer'||e.type==='error'||e.type==='goal'){messages.push({...e,mode,workflow,error:e.type==='error'});save();render();}
  if(e.type==='notice')$('status').textContent=e.text;
  if(e.type==='goal')$('status').textContent=e.final?`${workflow==='team'?'팀 작업':'목표 실행'} 종료 · ${goalLabels[e.status]||e.status}`:e.text;
  if(e.type==='deliverable'){refreshResults();}
  if(e.type==='artifact'){artifactLink(e);try{localStorage.setItem('ideas-artifact:'+currentRoom,JSON.stringify({id:e.id}));}catch{}}
  if(e.type==='done'){$('status').textContent=['goal','team'].includes(workflow)?`${workflow==='team'?'팀 작업':'목표 실행'} 종료 · ${goalLabels[messages.findLast(m=>m.type==='goal'&&m.final)?.status]||'결과 확인 필요'}`:'회의가 끝났습니다. 결과물을 다운로드하거나 다음 방향을 입력하세요.';}
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function remoteJson(route,options){const response=await fetch(route,{...options,signal:options?.signal||AbortSignal.timeout(15000)});let data;try{data=await response.json();}catch{throw new Error('원격 연결 응답을 읽지 못했습니다. 잠시 후 다시 조회하세요.');}if(!response.ok){if(response.status===401)showLogin();const error=new Error(data.error||'원격 요청에 실패했습니다.');error.status=response.status;throw error;}return data;}
async function pollJob(id,onUpdate){
  let cursor=0,failures=0;
  while(true){
    let job;try{job=await remoteJson(`/api/jobs/${id}?after=${cursor}`);failures=0;}catch(error){progressFailure();if(error.status===401)throw new Error('로그인이 만료됐습니다. 다시 로그인한 뒤 이전 작업을 조회하세요.');if(error.status===404){localStorage.removeItem('ideas-pending-job');$('resume-job').hidden=true;remoteJob=null;throw error;}if(++failures>=5)throw new Error(error.message+' 작업은 맥에서 계속 실행될 수 있습니다. 상단의 이전 작업 다시 조회를 누르세요.');$('status').textContent=`결과 연결 재시도 ${failures}/5 · 맥의 작업 완료 여부는 아직 확인되지 않았습니다.`;await pause(3000);continue;}
    await onUpdate?.(job);if(executionProgress&&job.type==='meeting'){progressJob(executionProgress,job);renderProgress();}cursor=job.cursor;
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
  if(workflow==='team'&&(mode!=='subscription'||ids.length!==2||ids.some(id=>!['gpt','claude'].includes(id)))){$('status').textContent='팀 모드는 구독 연결의 GPT와 Claude를 함께 선택하세요.';return;}
  if(['files','goal'].includes(workflow)&&(mode!=='subscription'||ids.length!==2||!$('review').checked)){$('status').textContent='파일 협업은 구독 참가자 2명을 선택하고 다른 참가자의 검토를 켜세요.';return;}
  if(!ids.length){$('status').textContent='참가자를 한 명 이상 선택하세요.';return;}
  const people=mode==='subscription'?config.local:config.participants;
  if(mode!=='demo'&&ids.some(id=>!people.find(p=>p.id===id).ready)){$('status').textContent=mode==='subscription'?'선택한 참가자의 계정으로 CLI에 로그인하고 상태를 새로고침하세요.':'선택한 참가자의 API 키를 .env에 설정하고 서버를 재시작하세요.';return;}
  // Seed a new team with the recent discussion; resumed teams also keep their own durable record.
  const history=workflow==='team'?[]:messages.filter(m=>!m.error&&m.mode!=='demo'&&(m.type!=='goal'||m.final)).map(m=>({speaker:m.speaker,text:m.text}));
  if(workflow==='team'){let remaining=Math.max(0,23000-text.length);for(const m of messages.filter(m=>!m.error&&m.mode!=='demo'&&m.type!=='goal').slice(-8).reverse()){if(remaining<100)break;const excerpt=m.text.slice(0,Math.min(3000,remaining));history.unshift({speaker:m.speaker,text:excerpt});remaining-=excerpt.length;}}
  history.push({speaker:'사용자',text});
  if(history.length>100||history.reduce((n,m)=>n+m.text.length,0)>24000){$('status').textContent='대화가 길어졌습니다. 회의록을 내보낸 후 새 회의를 시작하세요.';return;}
  const files=[...document.querySelectorAll('[name=file]:checked')].map(e=>e.value);
  if(files.length>8){$('status').textContent='자료 파일은 최대 8개입니다.';return;}
  controller=new AbortController();startProgress(new Date().toISOString());state(true);$('status').textContent=mode==='subscription'?'구독 CLI를 호출합니다. 앱 화면을 조작하지 않습니다.':mode==='live'?'별도 과금 API 호출을 시작합니다.':'무료 데모를 시작합니다.';
  let failures=0,lastNotice='';$('artifact').hidden=true;
  try{
    const request={roomId:currentRoom,history,participants:ids,mode,review:$('review').checked,workflow,writer:$('writer').value,files,webSearch:mode==='subscription'&&$('web-search').checked,...(workflow==='goal'?{budget:{minutes:Number($('goal-minutes').value),maxCalls:Number($('goal-calls').value)}}:{}),...(workflow==='team'?{teamFocus:$('team-focus').value,budget:{minutes:Number($('team-minutes').value),maxTurns:Number($('team-turns').value)},newTeam:$('team-new').checked}:{})};
    if(!localServer){
      messages.push({speaker:'사용자',text,mode,workflow});save();render();$('message').value='';$('status').textContent=workflow==='team'?`맥에서 팀 작업 시작 · 최대 ${request.budget.minutes}분 / ${request.budget.maxTurns}차례. 웹을 닫아도 맥에서 진행하며 나중에 다시 조회할 수 있습니다.`:workflow==='goal'?`맥에서 목표 실행 시작 · 최대 ${request.budget.minutes}분 / ${request.budget.maxCalls}회. 웹을 닫아도 맥에서 진행하며 나중에 다시 조회할 수 있습니다.`:'맥에서 회의를 시작합니다. 토론은 보통 1~5분, 파일 협업은 최대 10분 걸릴 수 있습니다.';
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
  }catch(error){progressFailure(localServer?(error.name==='AbortError'?'cancelled':'failed'):'unknown');$('status').textContent=error.name==='AbortError'?'회의를 중단했습니다. 이미 사용한 계정 한도나 API 비용은 되돌릴 수 없습니다.':error.message;}
  finally{state(false);$('message').focus();}
});
$('stop').onclick=async()=>{if(localServer)controller?.abort();else if(remoteJob){try{await remoteJson(`/api/jobs/${remoteJob}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});$('status').textContent='맥에 중단을 요청했습니다.';}catch(error){$('status').textContent=error.message;}}};
$('refresh-results').onclick=refreshResults;
$('refresh').onclick=()=>refresh(false);
$('team-focus').onchange=updateWriter;
$('workflow').onchange=()=>{if(['files','goal'].includes($('workflow').value))$('review').checked=true;updateWriter();};
for(const id of ['mode','workflow','writer','review','web-search','team-focus'])$(id).addEventListener('change',savePreferences);
$('mode').onchange=()=>{if(config)showParticipants();$('status').textContent=$('mode').value==='subscription'?'기존 계정으로 로그인한 CLI를 사용합니다. API 키를 사용하지 않습니다.':$('mode').value==='demo'?'무료 데모 · 실제 AI 답변을 생성하지 않습니다.':'API 모드 · 대화와 선택한 자료를 전송하고 별도 과금합니다.';};
$('example').onclick=()=>{$('message').value='나와 AI 동료들이 일주일 동안 함께 시도할 생산적인 실험 3개를 제안해줘. 하루에 30분만 쓸 수 있어.';$('message').focus();};
$('clear').onclick=async()=>{if(messages.length&&!confirm('현재 대화를 새로 시작할까요? 이미 저장한 회의록과 결과 파일은 남습니다.'))return;try{const response=await api('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reset:true})});if(!response.ok)throw new Error((await response.json()).error);messages=[];executionProgress=null;renderProgress();save();render();$('artifact').hidden=true;localStorage.removeItem('ideas-artifact:'+currentRoom);$('status').textContent='새 대화를 시작하세요.';}catch(error){$('status').textContent=error.message;}};
$('export').onclick=()=>{const markdown='# IDEAS 공동 회의록\n\n'+messages.map(m=>`## ${m.speaker} · ${m.mode==='demo'?'데모':m.speaker==='사용자'?'사용자':stage(m)}${m.error?' · 오류':''}\n\n${m.text}\n${m.model?'\n모델: '+m.model:''}`).join('\n\n');const url=URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='ideas-meeting.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const localServer=['127.0.0.1','localhost','::1','[::1]'].includes(location.hostname)&&!document.querySelector('meta[name="ideas-hosting"][content="static"]');
async function loadFiles(){
  $('files').replaceChildren();try{const response=await api('/api/files');const data=await response.json();if(!response.ok)throw new Error(data.error);for(const name of data.files){const label=document.createElement('label');label.className='file';const input=document.createElement('input');input.type='checkbox';input.name='file';input.value=name;const text=document.createElement('span');text.textContent=name;label.append(input,text);$('files').append(label);}}catch(error){$('files').textContent=error.message;}
}
async function loadRooms(){
  const response=await fetch('/api/rooms');if(response.status===401&&!localServer){showLogin();throw new Error('세션이 만료됐습니다. 다시 로그인하세요.');}if(!response.ok)throw new Error('회의실 목록을 읽지 못했습니다.');rooms=(await response.json()).items;$('room-grid').replaceChildren();
  for(const room of rooms){const card=document.createElement('article');card.className='room-card';const kind=document.createElement('span');kind.className='room-kind';kind.textContent=room.kind==='platform'?'회의실 프로그램 개발':'프로젝트 작업 공간';const title=document.createElement('h2');title.textContent=room.name;const root=document.createElement('code');root.textContent=room.root;const status=document.createElement('p');status.textContent=room.git.branch?`${room.git.branch} · 변경 ${room.git.changes}개 · ${room.git.commit}`:'Git 상태 확인 필요';card.append(kind,title,root,status);if(room.repo){const repo=document.createElement('a');repo.href=room.repo;repo.target='_blank';repo.rel='noopener noreferrer';repo.textContent=room.repo.replace('https://github.com/','');card.append(repo);}const button=document.createElement('button');button.textContent='회의실 열기 →';button.onclick=()=>openRoom(room.id);card.append(button);$('room-grid').append(card);}
  $('dashboard-status').textContent=`연결된 회의실 ${rooms.length}개 · 방마다 자료·대화·결과가 분리됩니다.`;$('worker-state').textContent=localServer?'로컬 맥 워커 연결됨':'원격 맥 워커 연결됨';
}
async function openRoom(id,{autoResume=true}={}){
  if(running)return;executionProgress=null;renderProgress();currentRoom=id;config=null;$('dashboard').hidden=true;$('room-view').hidden=false;$('artifact').hidden=true;$('message').value='';location.hash='room='+id;
  const room=rooms.find(r=>r.id===id);if(room.kind==='project'&&preferences.workflowVersion!==2){$('workflow').value='team';$('team-focus').value='research';$('web-search').checked=true;}else if(room.kind!=='project'&&$('workflow').value==='team')$('workflow').value='discuss';$('room-title').textContent=room.name;$('active-room-name').textContent=room.name;$('active-room-path').textContent=room.root;$('git-state').textContent=room.git.branch?`${room.git.branch} · 변경 ${room.git.changes}개`:'Git 상태 확인 필요';
  try{const response=await api('/api/session');if(!response.ok)throw new Error();messages=(await response.json()).messages;if(!messages.length){const key=id==='platform'?'ideas-room':'ideas-room:'+id;try{messages=JSON.parse(localStorage.getItem(key)||'[]');}catch{messages=[];}}}catch{messages=[];$('status').textContent='저장된 대화를 읽지 못했습니다.';}
  try{artifactLink(JSON.parse(localStorage.getItem('ideas-artifact:'+id)||(id==='platform'?localStorage.getItem('ideas-artifact'):'null')||'null'));}catch{}
  render();await refresh(false);await Promise.all([refreshResults(),loadFiles()]);
  if(!localServer&&autoResume){try{const auth=await remoteJson('/api/auth/status');if(auth.activeJob?.type==='meeting'&&auth.activeJob.roomId===id){localStorage.setItem('ideas-pending-job',auth.activeJob.id);void resumeMeetingJob(auth.activeJob.id,false);}}catch(error){$('status').textContent=error.message;}}
}
let googlePreparing=false,googlePrepared=false,googleScriptPromise;
function loadGoogleScript(){
  if(window.google?.accounts?.id)return Promise.resolve();
  if(googleScriptPromise)return googleScriptPromise;
  googleScriptPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
    const timer=setTimeout(()=>{script.remove();googleScriptPromise=null;reject(new Error('Google 로그인 로딩이 지연됩니다. 다시 시도하거나 비밀번호로 로그인하세요.'));},15000);
    script.onload=()=>{clearTimeout(timer);resolve();};script.onerror=()=>{clearTimeout(timer);script.remove();googleScriptPromise=null;reject(new Error('Google 로그인 화면을 불러오지 못했습니다. 다시 시도하세요.'));};document.head.append(script);
  });return googleScriptPromise;
}
async function prepareGoogleLogin(force=false){
  if(localServer||googlePreparing||googlePrepared&&!force)return;
  googlePreparing=true;googlePrepared=false;$('google-retry').hidden=true;$('google-login').hidden=false;$('google-button').replaceChildren();$('google-status').textContent='맥 워커 연결과 Google 로그인 설정을 확인하고 있습니다.';
  try{
    const response=await fetch('/api/auth/config');const auth=await response.json();if(!response.ok)throw new Error(auth.error||'로그인 설정을 읽지 못했습니다.');
    if(!auth.google?.enabled){$('google-login').hidden=true;$('google-status').textContent='Google 로그인 연결 준비 중입니다. 현재는 회의실 비밀번호로 로그인하세요.';return;}
    $('google-login').hidden=false;$('google-status').textContent='Google 로그인 버튼을 준비하고 있습니다.';
    await loadGoogleScript();window.google.accounts.id.initialize({client_id:auth.google.clientId,nonce:auth.google.nonce,auto_select:false,callback:async result=>{
      $('google-status').textContent='Google 계정을 확인하고 있습니다.';
      try{await remoteJson('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:result.credential})});googlePrepared=false;await initializeRooms();}
      catch(error){googlePrepared=false;$('google-status').textContent=error.message;$('google-retry').hidden=false;}
    }});
    $('google-button').replaceChildren();window.google.accounts.id.renderButton($('google-button'),{type:'standard',theme:'outline',size:'large',text:'signin_with',locale:'ko',width:280});
    $('password-fallback').open=false;googlePrepared=true;$('google-status').textContent='내 Google 계정을 선택하세요. 로그인 요청은 10분 동안 유효합니다.';
  }catch(error){$('google-status').textContent=error.message;$('google-retry').textContent='회의실 연결 다시 확인';$('google-retry').hidden=false;}
  finally{googlePreparing=false;}
}
$('google-retry').onclick=()=>prepareGoogleLogin(true);
function showLogin(){void prepareGoogleLogin();$('login-view').hidden=false;$('dashboard').hidden=true;$('room-view').hidden=true;$('logout').hidden=true;$('resume-job').hidden=true;$('worker-state').textContent='회의실 로그인 필요';}
async function initializeRooms(){
  if(!localServer){const auth=await remoteJson('/api/auth/status');$('logout').hidden=false;if(auth.activeJob)localStorage.setItem('ideas-pending-job',auth.activeJob.id);}
  $('login-view').hidden=true;$('dashboard').hidden=false;$('local-access').hidden=true;await loadRooms();const id=new URLSearchParams(location.hash.slice(1)).get('room');if(rooms.some(r=>r.id===id))await openRoom(id);else if(location.hash==='#new-room')$('new-room').click();$('resume-job').hidden=localServer||!localStorage.getItem('ideas-pending-job');
}
$('login-form').onsubmit=async event=>{event.preventDefault();$('login-submit').disabled=true;$('login-status').textContent='맥 워커에 로그인하고 있습니다.';try{await remoteJson('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('login-password').value})});$('login-password').value='';await initializeRooms();}catch(error){$('login-status').textContent=error.message;}finally{$('login-submit').disabled=false;}};
$('logout').onclick=async()=>{if(running)return;try{await remoteJson('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});googlePrepared=false;window.google?.accounts?.id.disableAutoSelect();showLogin();messages=[];rooms=[];config=null;$('log').querySelectorAll('.bubble').forEach(e=>e.remove());$('room-grid').replaceChildren();$('login-status').textContent='로그아웃했습니다.';}catch(error){$('status').textContent=error.message;}};
$('home').onclick=async()=>{if(running)return;$('room-view').hidden=true;$('dashboard').hidden=false;history.replaceState(null,'',location.pathname);try{await loadRooms();$('resume-job').hidden=localServer||!localStorage.getItem('ideas-pending-job');}catch(error){$('dashboard-status').textContent=error.message;}};
let repoNameEdited=false,github=null;
const repoSlug=value=>value.toLowerCase().trim().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-._]+|-+$/g,'').slice(0,100);
function roomMode(){
  const create=$('room-mode').value==='create';$('room-repo-name-field').hidden=!create;$('room-repo-field').hidden=create;$('room-repo-name').required=create;$('room-repo').required=!create;
  $('connect-room').textContent=create?'만들고 연결':'클론하고 연결';$('room-account').hidden=!create;$('connect-room').disabled=create&&github?.ready===false;
  $('room-hint').textContent=create?'로그인한 GitHub 계정에 README가 있는 비공개 저장소를 새로 만들고, 작업 컴퓨터의 홈 폴더로 받아 회의실로 연결합니다.':'README가 있는 기존 저장소를 작업 컴퓨터로 받아 연결합니다. 기존 폴더는 덮어쓰지 않습니다.';
}
$('room-mode').onchange=roomMode;roomMode();
// A Korean-only room name has no English slug, so a dated name is suggested instead of an empty required field.
$('room-name').oninput=()=>{if(!repoNameEdited){const d=new Date(),pad=n=>String(n).padStart(2,'0');$('room-repo-name').value=$('room-name').value.trim()?repoSlug($('room-name').value)||`project-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`:'';}};
$('room-repo-name').oninput=()=>{repoNameEdited=!!$('room-repo-name').value;};
// The account check runs on the computer that does the work, so the form says where the repository will be created.
async function checkGithub(){
  github=null;$('room-account').textContent='GitHub 계정을 확인하는 중입니다.';roomMode();
  try{const response=await fetch('/api/github');github=response.ok?await response.json():{ready:false,error:response.status===404?'작업 컴퓨터(맥)의 회의실이 이전 버전이라 새 프로젝트 만들기를 아직 지원하지 않습니다. 맥에서 IDEAS를 한 번 업데이트(git pull 후 서비스 재시작)해야 합니다.':'GitHub 계정 상태를 확인하지 못했습니다. 회의실 서버를 다시 시작하세요.'};}
  catch{github={ready:false,error:'회의실 서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인하세요.'};}
  $('room-account').textContent=github.ready?`GitHub 계정 ${github.account}에 비공개 저장소로 만들어집니다.`:github.error;roomMode();
}
$('new-room').onclick=()=>{$('room-form').hidden=false;$('room-status').textContent='';$('room-name').focus();checkGithub();};$('cancel-room').onclick=()=>{$('room-form').hidden=true;};
$('room-form').onsubmit=async event=>{event.preventDefault();if(running)return;
  // The form skips the browser's silent tooltips; every problem is written under the button instead.
  const invalid=[...$('room-form').querySelectorAll('input')].find(input=>!input.closest('[hidden]')&&!input.checkValidity());
  if(invalid){$('room-status').textContent=`${invalid.closest('label').firstChild.textContent.trim()}: ${invalid.id==='room-repo-name'?'영문·숫자와 - _ . 로 적어 주세요.':invalid.validationMessage}`;invalid.focus();return;}
  // An address with only the account means "make a new repository in my account".
  if($('room-mode').value==='connect'&&/^https:\/\/github\.com\/[A-Za-z0-9-]+\/?$/.test($('room-repo').value.trim())){$('room-mode').value='create';if(!$('room-repo-name').value)$('room-name').oninput();roomMode();}
  if($('room-mode').value==='create'&&github&&!github.ready){$('room-status').textContent=github.error;return;}state(true);$('stop').hidden=true;$('connect-room').disabled=true;$('new-room').disabled=true;const create=$('room-mode').value==='create',where=localServer?'이 컴퓨터':'맥';$('room-status').textContent=create?'GitHub에 저장소를 만들고 있습니다…':'저장소를 받아 오고 있습니다…';$('dashboard-status').textContent=create?`내 GitHub에 비공개 저장소를 만들고 ${where}로 받아 연결하고 있습니다. 1~2분 걸릴 수 있습니다.`:`${where}에서 저장소를 클론하고 연결하고 있습니다. 네트워크에 따라 1~2분 걸릴 수 있습니다.`;try{const request=create?{name:$('room-name').value,create:true,repoName:$('room-repo-name').value}:{name:$('room-name').value,repo:$('room-repo').value};let data;if(localServer){const response=await fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});data=await response.json();if(!response.ok)throw new Error(data.error);}else data=await submitRemoteJob('connect-room',request);await loadRooms();$('room-form').hidden=true;state(false);await openRoom(data.room.id);}catch(error){$('dashboard-status').textContent=error.message;$('room-status').textContent=error.message;}finally{state(false);$('connect-room').disabled=false;$('new-room').disabled=false;roomMode();}};
$('save-project').onclick=async()=>{if(running)return;state(true);$('stop').hidden=true;$('status').textContent='맥에서 이 프로젝트의 대화·결과를 검사하고 커밋·푸시하고 있습니다.';try{let data;if(localServer){const response=await api('/api/room-save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomId:currentRoom})});data=await response.json();if(!response.ok)throw new Error(data.error);}else data=await submitRemoteJob('save-room',{roomId:currentRoom});$('status').textContent=`GitHub 저장 완료 · ${data.branch} · ${data.commit} · 변경 파일 ${data.files}개`;await loadRooms();const room=rooms.find(r=>r.id===currentRoom);$('git-state').textContent=`${room.git.branch} · 변경 ${room.git.changes}개 · ${room.git.commit}`;}catch(error){$('status').textContent=error.message;}finally{state(false);}};
let resumingJob=false;
async function resumeMeetingJob(id,open=true){
  if(running||resumingJob)return;resumingJob=true;
  try{
    const job=await remoteJson(`/api/jobs/${id}?after=0`);
    if(job.type==='meeting'){
      if(open){await loadRooms();await openRoom(job.roomId,{autoResume:false});}
      messages=replayHistory(messages,job.history,job.mode,job.workflow);render();startProgress(job.createdAt);state(true);remoteJob=id;
      await pollJob(id,data=>{for(const e of data.events)onEvent(e,job.mode,job.workflow);});
    }else{remoteJob=id;await pollJob(id);await loadRooms();$('dashboard-status').textContent='이전 작업 결과를 확인했습니다.';}
  }catch(error){progressFailure();if(error.status===404){localStorage.removeItem('ideas-pending-job');$('resume-job').hidden=true;remoteJob=null;}$('status').textContent=error.message;$('dashboard-status').textContent=error.message;}finally{resumingJob=false;state(false);}
}
$('resume-job').onclick=()=>{const id=localStorage.getItem('ideas-pending-job');if(id)void resumeMeetingJob(id);};
try{await initializeRooms();}catch(error){if(!localServer){showLogin();$('login-status').textContent=error.message;}else{$('dashboard-status').textContent=error.message;$('worker-state').textContent='연결 확인 필요';}}
