import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createTunnelSupervisor} from '../scripts/tunnel-supervisor.mjs';
const origin='https://ideas.example',pause=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(fetchImpl){
  let time=0;const children=[],timers=[],saves=[],logs=[];
  const supervisor=createTunnelSupervisor({origin,bridgeToken:'bridge-secret',fetchImpl,now:()=>time,log:x=>logs.push(x),saveConnection:async value=>saves.push(value),setTimer:(callback,ms)=>{const timer={callback,ms,cancelled:false};timers.push(timer);return timer;},clearTimer:timer=>{if(timer)timer.cancelled=true;},spawnTunnel:()=>{const child=new EventEmitter();child.stderr=new EventEmitter();child.signals=[];child.kill=signal=>{child.signals.push(signal);return true;};children.push(child);return child;}});
  supervisor.start();
  return {supervisor,children,timers,saves,logs,advance(ms){time+=ms;},address(index=0,name='working-tunnel'){children[index].stderr.emit('data',Buffer.from('Visit https://'+name+'.trycloudflare.com |\n'));}};
}
const healthy=(instanceId='worker-1')=>new Response(JSON.stringify({healthy:true,instanceId}));
test('healthy tunnel probes authenticated full route without login challenges or redundant registration',async()=>{
  const calls=[];const f=fixture(async(url,options)=>{calls.push({url,options});return url.endsWith('/register')?new Response('{}'):healthy();});f.address();await pause();f.advance(30000);await f.supervisor.tick();
  assert.equal(calls.filter(c=>c.url.endsWith('/register')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/health')).length,2);assert.equal(f.saves.length,1);assert.equal(f.children[0].signals.length,0);
  for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer bridge-secret');assert.equal(call.options.redirect,'error');assert.ok(!call.url.includes('auth/config'));}f.supervisor.stop();
});
test('running but unreachable tunnel restarts after three failures; a new address registers automatically',async()=>{
  let broken=true;const f=fixture(async url=>{if(url.endsWith('/register'))return new Response('{}');if(broken)throw new Error('DNS failed');return healthy();});f.address();await pause();f.advance(30000);
  for(let i=0;i<2;i++)await f.supervisor.tick();assert.deepEqual(f.children[0].signals,[]);await f.supervisor.tick();assert.deepEqual(f.children[0].signals,['SIGTERM']);
  f.children[0].emit('exit',0);const retry=f.timers.find(t=>t.ms===5000&&!t.cancelled);retry.callback();f.address(1,'replacement-tunnel');await pause();assert.equal(f.children.length,2);assert.ok(f.saves.at(-1).url.includes('replacement-tunnel'));
  broken=false;f.advance(30000);await f.supervisor.tick();assert.deepEqual(f.children[1].signals,[]);f.supervisor.stop();
});
test('one intermittent failure resets after recovery and cannot trigger an unnecessary restart',async()=>{
  let fail=true;const f=fixture(async url=>{if(url.endsWith('/register'))return new Response('{}');if(fail)throw new Error();return healthy();});f.address();await pause();f.advance(30000);await f.supervisor.tick();fail=false;await f.supervisor.tick();fail=true;await f.supervisor.tick();await f.supervisor.tick();assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('stale Vercel routing is re-registered while the healthy tunnel and worker stay running',async()=>{
  let registrations=0;const f=fixture(async url=>{if(url.endsWith('/register')){registrations++;return new Response('{}');}return healthy(url.startsWith(origin)?'stale-worker':'current-worker');});f.address();await pause();f.advance(30000);await f.supervisor.tick();assert.equal(registrations,2);assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('late registration for a previous tunnel cannot mark the new one registered or overwrite local state',async()=>{
  let release;const oldResponse=new Promise(resolve=>{release=resolve;});let registrations=0;
  const f=fixture(async url=>{if(url.endsWith('/register')){registrations++;return registrations===1?oldResponse:new Response('{}');}return healthy();});
  f.address(0,'old-tunnel');f.children[0].emit('exit',1);f.timers.find(t=>t.ms===5000).callback();f.address(1,'new-tunnel');await pause();release(new Response('{}'));await pause();assert.equal(f.saves.length,1);assert.ok(f.saves[0].url.includes('new-tunnel'));f.supervisor.stop();
});
test('startup stalls and SIGTERM stalls are bounded, and stopping cancels restarts',async()=>{
  const f=fixture(async()=>new Response('{}'));f.advance(90000);await f.supervisor.tick();assert.deepEqual(f.children[0].signals,['SIGTERM']);const kill=f.timers.find(t=>t.ms===10000);kill.callback();assert.deepEqual(f.children[0].signals,['SIGTERM','SIGKILL']);f.children[0].emit('exit',1);const retry=f.timers.find(t=>t.ms===5000);f.supervisor.stop();assert.equal(retry.cancelled,true);retry.callback();assert.equal(f.children.length,1);
});
test('overlapping ticks do not double-count an in-flight failure',async()=>{
  let release;const waiting=new Promise(resolve=>{release=resolve;});const f=fixture(async url=>url.endsWith('/register')?new Response('{}'):waiting);f.address();await pause();f.advance(30000);const first=f.supervisor.tick();await f.supervisor.tick();await f.supervisor.tick();release(new Response('{}',{status:503}));await first;assert.equal(f.logs.filter(x=>x.includes('응답 실패')).length,1);assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
