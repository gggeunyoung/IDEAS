// Heartbeats confirm connectivity, not new AI activity.
export function pollDelay(idleRounds){return Math.min(15000,3000*2**Math.min(Math.max(0,idleRounds),3));}
export function hasJobUpdate(previousStatus,job){return previousStatus!==job.status||(job.events||[]).some(e=>e.type!=='heartbeat');}
// No requests while hidden. Becoming visible interrupts an outstanding delay.
export function waitForPoll(document,delay=0,{setTimer=setTimeout,clearTimer=clearTimeout}={}){
  return new Promise(resolve=>{
    let timer;
    const finish=()=>{clearTimer(timer);document.removeEventListener('visibilitychange',changed);resolve();};
    const changed=()=>{if(document.hidden){clearTimer(timer);timer=undefined;}else finish();};
    document.addEventListener('visibilitychange',changed);
    if(!document.hidden)timer=setTimer(finish,delay);
  });
}
