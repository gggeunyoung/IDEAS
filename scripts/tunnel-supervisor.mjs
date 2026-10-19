import {workerAddress} from '../remote-proxy.mjs';

// Keep the worker and its jobs alive when only the public tunnel has stopped working.
export function createTunnelSupervisor({origin,bridgeToken,spawnTunnel,saveConnection=async()=>{},log=()=>{},fetchImpl=fetch,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,startupGraceMs=20000,startupTimeoutMs=90000,addressReadyTimeoutMs=180000,failureLimit=3}={}){
  let current=null,stopped=false,retryTimer,busy=false;
  const active=session=>!stopped&&current===session&&!session.restarting;
  const request=(url,options={})=>fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+bridgeToken,...options.headers}});
  async function register(session,force=false){
    if(!active(session)||!session.url||session.registering||!force&&session.registered)return;
    session.registering=true;const address=session.url;
    try{
      const response=await request(origin+'/api/worker/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:address})});
      if(!response.ok)throw new Error();
      if(!active(session)||session.url!==address)return;
      await saveConnection({url:address,origin,registeredAt:new Date(now()).toISOString()});
      if(!active(session))return;
      session.registered=true;log('외부 응답을 확인한 맥 워커 주소 등록 완료');
    }catch{if(active(session)){session.registered=false;log('Vercel 연결 등록 대기 중 · 다음 점검에서 재시도');}}
    finally{session.registering=false;}
  }
  function schedule(){if(!stopped&&!retryTimer)retryTimer=setTimer(()=>{retryTimer=null;start();},5000);}
  function restart(session,reason){
    if(!active(session))return;
    session.restarting=true;log(reason+' · 중계만 다시 연결합니다. 진행 중인 맥 작업은 유지됩니다.');
    // SIGTERM can wait indefinitely if the tunnel's network stack is stuck.
    session.killTimer=setTimer(()=>{if(current===session)session.child.kill('SIGKILL');},10000);
    session.child.kill('SIGTERM');
  }
  function start(){
    if(stopped)return;
    if(current)return;
    let child;try{child=spawnTunnel();}catch{log('중계 프로그램 실행 실패 · 다시 시도합니다.');schedule();return;}
    const session={child,url:null,registered:false,registering:false,startedAt:now(),failures:0,restarting:false,killTimer:null};current=session;
    let buffer='';child.stderr.on('data',chunk=>{
      if(!active(session))return;
      buffer+=chunk.toString();const match=/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|]|$)/.exec(buffer);
      if(match&&!session.url){session.url=workerAddress(match[0]);session.addressAt=now();log('맥 중계 주소 발급 · 외부 응답 확인 중');void tick(true);}
      buffer=buffer.slice(-8000);
    });
    const ended=()=>{if(current!==session)return;clearTimer(session.killTimer);current=null;if(!stopped){log('맥 중계 연결 종료 · 5초 후 다시 연결');schedule();}};
    child.on('error',()=>{log('중계 프로그램 실행 오류');ended();});child.on('exit',ended);
  }
  async function health(base){
    const response=await request(base+'/api/worker/health');if(!response.ok)throw new Error();
    const data=await response.json();if(data.healthy!==true||typeof data.instanceId!=='string'||!data.instanceId)throw new Error();return data.instanceId;
  }
  async function tick(initial=false){
    if(stopped||busy||!current)return;
    const session=current;
    if(!active(session))return;
    if(!session.url){if(now()-session.startedAt>=startupTimeoutMs)restart(session,'중계 주소 발급 시간 초과');return;}
    if(!initial&&now()-session.addressAt<startupGraceMs)return;
    busy=true;
    try{
      let direct;
      try{direct=await health(session.url);}
      catch(error){
        if(!active(session))return;
        if(!session.verified&&now()-session.addressAt<addressReadyTimeoutMs){
          const dnsFailure=['ENOTFOUND','EAI_AGAIN'].includes(error.cause?.code||error.code);
          log(dnsFailure?'중계 주소 DNS 응답 대기 · 로그인 연결 준비 중':'새 중계의 외부 응답 대기 · 아직 연결 완료가 아닙니다.');return;
        }
        session.failures++;log(`외부 중계 응답 실패 ${session.failures}/${failureLimit}`);
        if(session.failures>=failureLimit)restart(session,'외부 중계 연결 끊김 감지');return;
      }
      if(!active(session))return;
      session.verified=true;session.failures=0;
      if(!session.registered)await register(session);
      if(!active(session))return;
      try{const routed=await health(origin);if(routed!==direct)throw new Error();session.registered=true;}
      catch{if(active(session)){session.registered=false;await register(session,true);}}
    }finally{busy=false;}
  }
  function stop(){stopped=true;clearTimer(retryTimer);retryTimer=null;if(current){clearTimer(current.killTimer);current.child.kill('SIGTERM');}}
  return {start,tick,stop};
}
