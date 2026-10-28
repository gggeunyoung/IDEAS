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
  assert.equal(calls.filter(c=>c.url.endsWith('/register')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/health')).length,3);assert.equal(f.saves.length,1);assert.equal(f.children[0].signals.length,0);
  for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer bridge-secret');assert.equal(call.options.redirect,'error');assert.ok(!call.url.includes('auth/config'));}f.supervisor.stop();
});
test('running but unreachable tunnel restarts after three failures; a new address registers automatically',async()=>{
  let broken=false;const f=fixture(async url=>{if(url.endsWith('/register'))return new Response('{}');if(broken)throw new Error('DNS failed');return healthy();});f.address();await pause();broken=true;f.advance(30000);
  for(let i=0;i<2;i++)await f.supervisor.tick();assert.deepEqual(f.children[0].signals,[]);await f.supervisor.tick();assert.deepEqual(f.children[0].signals,['SIGTERM']);
  f.children[0].emit('exit',0);const retry=f.timers.find(t=>t.ms===5000&&!t.cancelled);retry.callback();broken=false;f.address(1,'replacement-tunnel');await pause();assert.equal(f.children.length,2);assert.ok(f.saves.at(-1).url.includes('replacement-tunnel'));
  broken=false;f.advance(30000);await f.supervisor.tick();assert.deepEqual(f.children[1].signals,[]);f.supervisor.stop();
});
test('one intermittent failure resets after recovery and cannot trigger an unnecessary restart',async()=>{
  let fail=false;const f=fixture(async url=>{if(url.endsWith('/register'))return new Response('{}');if(fail)throw new Error();return healthy();});f.address();await pause();fail=true;f.advance(30000);await f.supervisor.tick();fail=false;await f.supervisor.tick();fail=true;await f.supervisor.tick();await f.supervisor.tick();assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('stale Vercel routing retries registration with backoff while the tunnel stays running',async()=>{
  let registrations=0;const f=fixture(async url=>{if(url.endsWith('/register')){registrations++;return new Response('{}');}return healthy(url.startsWith(origin)?'stale-worker':'current-worker');});f.address();await pause();assert.equal(registrations,1);await f.supervisor.tick();assert.equal(registrations,1);f.advance(30000);await f.supervisor.tick();assert.equal(registrations,2);assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('late registration for a previous tunnel cannot mark the new one registered or overwrite local state',async()=>{
  let release;const oldResponse=new Promise(resolve=>{release=resolve;});let registrations=0;
  const f=fixture(async url=>{if(url.endsWith('/register')){registrations++;return registrations===1?oldResponse:new Response('{}');}return healthy();});
  f.address(0,'old-tunnel');await pause();f.children[0].emit('exit',1);f.timers.find(t=>t.ms===5000).callback();f.address(1,'new-tunnel');await pause();release(new Response('{}'));await pause();await f.supervisor.tick(true);assert.equal(f.saves.length,1);assert.ok(f.saves[0].url.includes('new-tunnel'));f.supervisor.stop();
});
test('startup stalls and SIGTERM stalls are bounded, and stopping cancels restarts',async()=>{
  const f=fixture(async()=>new Response('{}'));f.advance(90000);await f.supervisor.tick();assert.deepEqual(f.children[0].signals,['SIGTERM']);const kill=f.timers.find(t=>t.ms===10000);kill.callback();assert.deepEqual(f.children[0].signals,['SIGTERM','SIGKILL']);f.children[0].emit('exit',1);const retry=f.timers.find(t=>t.ms===5000);f.supervisor.stop();assert.equal(retry.cancelled,true);retry.callback();assert.equal(f.children.length,1);
});
test('overlapping ticks do not double-count an in-flight failure',async()=>{
  let release,broken=false;const waiting=new Promise(resolve=>{release=resolve;});const f=fixture(async url=>url.endsWith('/register')?new Response('{}'):broken?waiting:healthy());f.address();await pause();broken=true;f.advance(30000);const first=f.supervisor.tick();await f.supervisor.tick();await f.supervisor.tick();release(new Response('{}',{status:503}));await first;assert.equal(f.logs.filter(x=>x.includes('응답 실패')).length,1);assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('unresolved tunnel addresses are never published; DNS readiness is bounded and recovery is verified',async()=>{
  let dnsBroken=true,registrations=0;const f=fixture(async url=>{if(url.endsWith('/register')){registrations++;return new Response('{}');}if(dnsBroken)throw Object.assign(new Error('fetch failed'),{cause:{code:'ENOTFOUND'}});return healthy();});
  f.address();await pause();assert.equal(registrations,0);assert.equal(f.saves.length,0);assert.ok(f.logs.some(l=>l.includes('DNS')));
  f.advance(90000);await f.supervisor.tick();assert.deepEqual(f.children[0].signals,[]);assert.equal(registrations,0);
  dnsBroken=false;await f.supervisor.tick();assert.equal(registrations,1);assert.equal(f.saves.length,1);f.supervisor.stop();
});
test('a new tunnel that never becomes reachable is eventually replaced without publishing it',async()=>{
  const f=fixture(async()=>{throw new Error('unreachable');});f.address();await pause();f.advance(180000);for(let i=0;i<3;i++)await f.supervisor.tick();assert.deepEqual(f.children[0].signals,['SIGTERM']);assert.equal(f.saves.length,0);f.supervisor.stop();
});

test('24 hours of healthy idle ticks make zero additional Vercel requests',async()=>{
 const calls=[];const f=fixture(async url=>{calls.push(url);return url.endsWith('/register')?new Response('{}'):healthy();});
 f.address();await pause();const initial=calls.filter(url=>url.startsWith(origin)).length;assert.equal(initial,2);
 for(let i=0;i<2880;i++){f.advance(30000);await f.supervisor.tick();}
 assert.equal(calls.filter(url=>url.startsWith(origin)).length,initial);assert.equal(f.saves.length,1);assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('paused Vercel uses exponential registration backoff without stopping Mac work',async()=>{
 let registrations=0;const f=fixture(async url=>{if(url.startsWith(origin)){registrations++;return new Response('paused',{status:503});}return healthy();});
 f.address();await pause();assert.equal(registrations,1);
 for(let i=0;i<2880;i++){f.advance(30000);await f.supervisor.tick();}
 assert.ok(registrations<60,`registration requests: ${registrations}`);assert.equal(f.saves.length,0);assert.deepEqual(f.children[0].signals,[]);f.supervisor.stop();
});
test('a changed worker instance re-registers once even if the tunnel address is unchanged',async()=>{
 let instance='worker-1',registrations=0;const f=fixture(async url=>{if(url.endsWith('/register')){registrations++;return new Response('{}');}return healthy(instance);});
 f.address();await pause();instance='worker-2';f.advance(30000);await f.supervisor.tick();f.advance(30000);await f.supervisor.tick();assert.equal(registrations,2);assert.equal(f.saves.length,2);f.supervisor.stop();
});
