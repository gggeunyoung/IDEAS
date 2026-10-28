import test from 'node:test';import assert from 'node:assert/strict';
import {pollDelay,hasJobUpdate,waitForPoll} from '../public/polling.js';

test('empty/heartbeat-only polls back off to 15 seconds; real changes reset to 3 seconds',()=>{
 assert.deepEqual([0,1,2,3,4].map(pollDelay),[3000,6000,12000,15000,15000]);
 assert.equal(hasJobUpdate('running',{status:'running',events:[{type:'heartbeat'}]}),false);
 assert.equal(hasJobUpdate('running',{status:'running',events:[{type:'activity'}]}),true);
 assert.equal(hasJobUpdate('running',{status:'done',events:[]}),true);
});
function fixture(hidden){let listener;const timers=[];const document={hidden,addEventListener(type,fn){listener=fn;},removeEventListener(){listener=undefined;}};return {document,timers,clock:{setTimer(fn,ms){const timer={fn,ms};timers.push(timer);return timer;},clearTimer(timer){if(timer)timer.cancelled=true;}},visibility(value){document.hidden=value;listener?.();},listeners(){return !!listener;}};}
test('hidden tabs schedule no polls and resume immediately on becoming visible',async()=>{
 const f=fixture(true);let completed=false;const pending=waitForPoll(f.document,15000,f.clock).then(()=>completed=true);
 assert.equal(f.timers.length,0);assert.equal(completed,false);f.visibility(false);await pending;assert.equal(completed,true);assert.equal(f.listeners(),false);
});
test('hiding cancels a scheduled poll and visibility resumes without leaving timers/listeners',async()=>{
 const f=fixture(false);let completed=false;const pending=waitForPoll(f.document,12000,f.clock).then(()=>completed=true);
 assert.equal(f.timers[0].ms,12000);f.visibility(true);assert.equal(f.timers[0].cancelled,true);await Promise.resolve();assert.equal(completed,false);f.visibility(false);await pending;assert.equal(f.listeners(),false);
 const next=waitForPoll(f.document,3000,f.clock);f.timers.at(-1).fn();await next;assert.equal(f.listeners(),false);
});

test('browser polling module is served as JavaScript by the room server',async()=>{
 const {createServer}=await import('../server.mjs');const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/polling.js`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/export function waitForPoll/);}finally{await new Promise(resolve=>server.close(resolve));}
});
