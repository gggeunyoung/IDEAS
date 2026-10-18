export const activityLabels={waiting:'AI 응답 대기',working:'도구 결과 처리 중',searching:'웹 검색 중',fetching:'웹 자료 확인 중',reading:'프로젝트 자료 읽는 중',editing:'파일 작성·수정 중',command:'명령 실행 중',responding:'답변 생성 중',retrying:'AI 연결 재시도 중'};
const time=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function newProgress(startedAt=null){return {startedAt:time(startedAt),finishedAt:null,agents:{},answers:0,connection:'checking',checkedAt:null,terminal:null,finalLabel:null};}
export function progressEvent(p,e){
  const at=time(e.at);
  const agent=()=>p.agents[e.provider||e.speaker]||Object.values(p.agents).find(a=>a.speaker===e.speaker);
  if(e.type==='pending')p.agents[e.provider||e.speaker]={speaker:e.speaker,round:e.round,phase:e.phase,startedAt:at,activity:'waiting',lastActivity:null,active:true};
  if(e.type==='activity'){
    const a=agent();if(a?.active&&activityLabels[e.activity]){a.activity=e.activity;a.lastActivity=at;}
  }
  if(e.type==='answer'||e.type==='error'){
    const a=agent();if(a){a.active=false;a.activity=e.type==='error'?'failed':'done';}if(e.type==='answer')p.answers++;
  }
  if(e.type==='goal'&&e.final)p.finalLabel=e.status;
  if(e.type==='done'){p.terminal='done';p.finishedAt=at;for(const a of Object.values(p.agents))a.active=false;}
  return p;
}
export function progressJob(p,job,now=Date.now()){
  p.startedAt??=time(job.createdAt);p.checkedAt=now;p.connection='online';
  if(['done','failed','cancelled','interrupted'].includes(job.status)){p.terminal=job.status;p.finishedAt=time(job.finishedAt)||p.finishedAt||now;for(const a of Object.values(p.agents))a.active=false;}
  return p;
}
export function duration(ms){const seconds=Math.max(0,Math.floor(ms/1000));return seconds<60?`${seconds}초`:`${Math.floor(seconds/60)}분 ${seconds%60}초`;}
export function progressView(p,now=Date.now()){
  const active=Object.values(p.agents).filter(a=>a.active),stale=p.connection!=='online'||!p.checkedAt||now-p.checkedAt>(p.staleAfterMs||15000);
  const state=p.terminal?'finished':stale?'unknown':'running';
  const title=p.terminal?({done:'작업 종료',failed:'작업 실패',cancelled:'사용자 중단',interrupted:'워커 재시작으로 중단'}[p.terminal]||'실행 상태 확인 필요'):stale?'연결 확인 중 · 실행 여부 미확인':active.length?`${active.map(a=>a.speaker).join(' · ')} 작업 중`:'맥에서 다음 단계 진행 중';
  return {state,title,elapsed:p.startedAt?`전체 경과 ${duration((p.finishedAt||now)-p.startedAt)}`:'전체 시작 시각 미기록',connection:p.checkedAt?`마지막 연결 확인 ${duration(now-p.checkedAt)} 전`:'맥 연결 확인 대기',answers:`답변 ${p.answers}개 수신`,agents:active.map(a=>({
    speaker:a.speaker,detail:`${a.round?`${a.round}번째 차례 · `:''}${activityLabels[a.activity]}${a.startedAt?` · ${duration(now-a.startedAt)} 경과`:''}`,
    note:stale?'웹 연결이 끊겨 현재 AI 활동을 확인할 수 없습니다.':a.lastActivity?`마지막 AI 활동 ${duration(now-a.lastActivity)} 전${now-a.lastActivity>90000?' · 새 활동 보고를 기다리고 있습니다.':''}`:'세부 활동 보고 대기 · 응답 생성과 도구 작업을 아직 구분할 수 없습니다.'
  }))};
}
export function replayHistory(saved,history=[],mode,workflow){
  const prompt=history.at(-1),index=prompt?saved.findLastIndex(m=>m.speaker==='사용자'&&m.text===prompt.text):-1;
  return index>=0?saved.slice(0,index+1):history.map(m=>({...m,mode,workflow}));
}
export function jobFailureMessage(job){
  return job.error==='terminated'?'맥의 응답 연결이 끊겨 작업이 중단됐습니다. 저장된 답변과 파일은 남아 있습니다. 같은 팀으로 이어서 진행할 수 있습니다.':job.error||'작업이 완료되지 않았습니다.';
}
