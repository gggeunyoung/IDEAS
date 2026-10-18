import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRemoteWorker,prepareRemoteSecrets} from '../remote-worker.mjs';
import {createRemoteProxy,workerAddress} from '../remote-proxy.mjs';
import {setRemotePassword} from '../scripts/remote-password.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
async function workerFixture(t,handle,{initializeDirectory,...workerOptions}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'ideas-remote-test-'));const secrets=await prepareRemoteSecrets(directory),password=(await readFile(path.join(directory,'remote-login.txt'),'utf8')).split('\n')[1];
  const local=http.createServer(handle),localUrl=await listen(local);if(initializeDirectory)await initializeDirectory(path.join(directory,'jobs'));let worker=await createRemoteWorker({secrets,localUrl,directory:path.join(directory,'jobs'),...workerOptions}),url=await listen(worker);
  t.after(async()=>{await close(worker);await close(local);await rm(directory,{recursive:true,force:true});});
  const request=(route,{cookie,bridge=secrets.bridgeToken,body,method=body?'POST':'GET'}={})=>fetch(url+route,{method,headers:{Authorization:'Bearer '+bridge,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  const login=async()=>{const response=await request('/api/auth/login',{body:{password}});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
  return {directory,secrets,request,login,restart:async()=>{await close(worker);worker=await createRemoteWorker({secrets,localUrl,directory:path.join(directory,'jobs'),...workerOptions});url=await listen(worker);}};
}
async function eventually(fn){for(let i=0;i<150;i++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('작업 대기 시간 초과');}
async function fragmentedPost(url,headers,body){
  const bytes=Buffer.from(JSON.stringify(body)),first=bytes.indexOf(Buffer.from('한글'));
  assert.ok(first>=0);
  return new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.on('error',reject);req.write(bytes.subarray(0,first+1));setTimeout(()=>req.end(bytes.subarray(first+1)),15);});
}
test('remote worker rejects public, forged, logged-out access and arbitrary routes',async t=>{
  let calls=0;const f=await workerFixture(t,(req,res)=>{calls++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"items":[]}');});
  assert.equal((await f.request('/api/rooms',{bridge:'wrong'})).status,401);assert.equal((await f.request('/api/rooms')).status,401);assert.equal(calls,0);
  assert.equal((await f.request('/api/auth/login',{body:{password:'wrong'}})).status,401);
  const response=await f.request('/api/auth/login',{body:{password:(await readFile(path.join(f.directory,'remote-login.txt'),'utf8')).split('\n')[1]}}),cookie=response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await f.request('/api/rooms',{cookie})).status,200);assert.equal(calls,1);
  assert.equal((await f.request('/.env',{cookie})).status,404);assert.equal((await f.request('/api/config',{cookie:'__Host-ideas_session='+'a'.repeat(43)})).status,401);
  assert.equal((await f.request('/api/auth/logout',{cookie,body:{}})).status,200);assert.equal((await f.request('/api/rooms',{cookie})).status,401);
  const another=await f.login();await f.restart();assert.equal((await f.request('/api/rooms',{cookie:another})).status,401);
});
test('remote login is throttled before brute-force requests reach the local server',async t=>{
  const f=await workerFixture(t,()=>assert.fail('로그인 요청은 로컬 서버에 전달하지 않는다'));
  for(let i=0;i<10;i++)assert.equal((await f.request('/api/auth/login',{body:{password:'bad'}})).status,401);
  assert.equal((await f.request('/api/auth/login',{body:{password:'bad'}})).status,429);
});
test('remote jobs continue after submit disconnect, reject duplicates and resume after worker restart',async t=>{
  let calls=0;const f=await workerFixture(t,(req,res)=>{calls++;assert.match(req.headers.origin,/^http:\/\/127\.0\.0\.1:/);res.writeHead(200,{'Content-Type':'application/x-ndjson'});setTimeout(()=>res.end('{"type":"answer","speaker":"GPT","text":"result"}\n{"type":"done"}\n'),80);});
  let cookie=await f.login();const id=randomUUID(),body={id,type:'meeting',request:{roomId:'test-room',history:[{speaker:'사용자',text:'test'}],mode:'demo',workflow:'discuss'}};
  assert.equal((await f.request('/api/jobs',{cookie,body})).status,202);assert.equal((await f.request('/api/jobs',{cookie,body})).status,200);
  assert.equal((await f.request('/api/jobs',{cookie,body:{...body,request:{different:true}}})).status,409);
  assert.equal((await f.request('/api/jobs',{cookie,body:{...body,id:randomUUID()}})).status,409);
  const result=await eventually(async()=>{const job=await (await f.request('/api/jobs/'+id,{cookie})).json();return job.status==='done'&&job;});assert.equal(calls,1);assert.equal(result.events[0].text,'result');assert.equal(result.history[0].text,'test');
  assert.ok(Number.isFinite(Date.parse(result.createdAt)));assert.ok(Number.isFinite(Date.parse(result.finishedAt)));assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  const completedCancel=await (await f.request('/api/jobs/'+id+'/cancel',{cookie,body:{}})).json();assert.deepEqual(completedCancel,{cancelled:false,status:'done'});
  assert.deepEqual((await (await f.request('/api/jobs/'+id+'?after=1',{cookie})).json()).events,[{type:'done'}]);
  await f.restart();cookie=await f.login();assert.equal((await (await f.request('/api/jobs/'+id,{cookie})).json()).status,'done');
});
test('queued cancellation prevents starting a provider even before submission receipt',async t=>{
  let release,entered;const paused=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});t.after(()=>release());let calls=0;
  const f=await workerFixture(t,(req,res)=>{calls++;res.end('{}');},{persistJob:async job=>{if(job.status==='queued'){entered();await paused;}}});
  const cookie=await f.login(),id=randomUUID();const submission=f.request('/api/jobs',{cookie,body:{id,type:'meeting',request:{roomId:'test'}}});await ready;
  assert.equal((await f.request('/api/jobs/'+id+'/cancel',{cookie,body:{}})).status,200);release();assert.equal((await submission).status,202);
  const cancelled=await eventually(async()=>{const job=await (await f.request('/api/jobs/'+id,{cookie})).json();return job.status==='cancelled'&&job;});assert.equal(calls,0);assert.deepEqual(cancelled.events,[]);
});
test('failed job persistence releases the worker and Git operations reject cancellation',async t=>{
  let fail=true,calls=0;const f=await workerFixture(t,(req,res)=>{calls++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"saved":true}');},{persistJob:async()=>{if(fail){fail=false;throw new Error('disk full');}}});
  const cookie=await f.login(),failedId=randomUUID();assert.equal((await f.request('/api/jobs',{cookie,body:{id:failedId,type:'save-room',request:{roomId:'test'}}})).status,503);
  assert.equal((await f.request('/api/jobs/'+failedId,{cookie})).status,404);assert.equal((await (await f.request('/api/auth/status',{cookie})).json()).activeJob,null);
  const id=randomUUID();assert.equal((await f.request('/api/jobs',{cookie,body:{id,type:'save-room',request:{roomId:'test'}}})).status,202);await eventually(async()=>{const job=await (await f.request('/api/jobs/'+id,{cookie})).json();return job.status==='done';});assert.equal(calls,1);assert.equal((await f.request('/api/jobs/'+id+'/cancel',{cookie,body:{}})).status,409);
});
test('one corrupt job record cannot prevent login or recovery of valid interrupted jobs',async t=>{
  const corruptId=randomUUID(),finishedId=randomUUID(),runningId=randomUUID();let calls=0;
  const f=await workerFixture(t,()=>{calls++;},{initializeDirectory:async directory=>{await mkdir(directory,{recursive:true});await writeFile(path.join(directory,corruptId+'.json'),'{"id":');for(const [id,status] of [[finishedId,'done'],[runningId,'running']])await writeFile(path.join(directory,id+'.json'),JSON.stringify({id,type:'meeting',status,request:{roomId:'test'},events:[]}));}});
  const cookie=await f.login();assert.equal((await (await f.request('/api/auth/status',{cookie})).json()).recoveryWarnings,1);assert.equal((await (await f.request('/api/jobs/'+finishedId,{cookie})).json()).status,'done');assert.equal((await (await f.request('/api/jobs/'+runningId,{cookie})).json()).status,'interrupted');assert.equal(calls,0);
  const files=await readdir(path.join(f.directory,'jobs','quarantine'));assert.equal(files.length,1);assert.equal(await readFile(path.join(f.directory,'jobs','quarantine',files[0]),'utf8'),'{"id":');
});
test('remote cancellation aborts the running local request and preserves prior events',async t=>{
  let closed=false;const f=await workerFixture(t,(req,res)=>{res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.write('{"type":"answer","text":"partial"}\n');res.on('close',()=>{closed=true;});});
  const cookie=await f.login(),id=randomUUID();await f.request('/api/jobs',{cookie,body:{id,type:'meeting',request:{roomId:'test'}}});
  await eventually(async()=>{const job=await (await f.request('/api/jobs/'+id,{cookie})).json();return job.events.length;});
  assert.equal((await f.request('/api/jobs/'+id+'/cancel',{cookie,body:{}})).status,200);
  const result=await eventually(async()=>{const job=await (await f.request('/api/jobs/'+id,{cookie})).json();return job.status==='cancelled'&&job;});assert.equal(result.events[0].text,'partial');assert.equal(closed,true);
});
test('Vercel proxy protects origin, URL boundaries, cookie and worker registration',async t=>{
  const env={IDEAS_BRIDGE_TOKEN:'bridge',IDEAS_PUBLIC_ORIGIN:'https://ideas.example',BLOB_STORE_ID:'fake'};let connection=null,calls=0,lastRequest;
  const handler=createRemoteProxy({env,connectionStore:{read:async()=>connection,write:async value=>{connection=value;}},fetchImpl:async(url,options)=>{calls++;lastRequest={url:String(url),options};return new Response('{"ok":true}',{headers:{'Content-Type':'application/json'}});}});
  const server=http.createServer(handler),url=await listen(server);t.after(()=>close(server));
  assert.equal((await fetch(url+'/api/rooms')).status,401);assert.equal(calls,0);
  assert.equal((await fetch(url+'/api/auth/login',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/worker/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const register=address=>fetch(url+'/api/worker/register',{method:'POST',headers:{Authorization:'Bearer bridge','Content-Type':'application/json'},body:JSON.stringify({url:address})});
  assert.equal((await register('https://127.0.0.1/')).status,503);assert.equal((await register('https://test-worker.trycloudflare.com')).status,200);
  const response=await fetch(url+'/api/rooms?roomId=abc&arbitrary=bad',{headers:{Cookie:'__Host-ideas_session='+'a'.repeat(43)}});assert.equal(response.status,200);assert.equal(calls,1);assert.equal(lastRequest.url,'https://test-worker.trycloudflare.com/api/rooms?roomId=abc');assert.equal(lastRequest.options.headers.Authorization,'Bearer bridge');
  assert.equal((await fetch(url+'/api/remote?route=../../.env')).status,404);
  for(const address of ['http://test.trycloudflare.com','https://test.trycloudflare.com:8443','https://test.trycloudflare.com@evil.com','https://test.trycloudflare.com/path','https://test.trycloudflare.com?x=y'])assert.throws(()=>workerAddress(address));
});
test('Korean JSON survives split UTF-8 bytes through proxy and worker',async t=>{
  const f=await workerFixture(t,async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({name:body.name}));});
  const cookie=await f.login(),id=randomUUID();
  // Exercise the actual worker socket with one Korean character split across chunks.
  const serverAddress=await f.request('/api/auth/status',{cookie});const workerUrl=new URL(serverAddress.url).origin;
  const created=await fragmentedPost(workerUrl+'/api/jobs',{Authorization:'Bearer '+f.secrets.bridgeToken,Cookie:cookie},{id,type:'connect-room',request:{name:'한글 뒤에 남는 대화'}});assert.equal(created.status,202);
  const result=await eventually(async()=>{const job=await (await f.request('/api/jobs/'+id,{cookie})).json();return job.status==='done'&&job;});assert.equal(result.result.name,'한글 뒤에 남는 대화');
  let forwarded;const proxy=http.createServer(createRemoteProxy({env:{IDEAS_BRIDGE_TOKEN:'bridge',IDEAS_WORKER_URL:'https://test.trycloudflare.com',IDEAS_PUBLIC_ORIGIN:'https://ideas.example'},fetchImpl:async(url,options)=>{forwarded=JSON.parse(options.body);return new Response('{}');}}));const proxyUrl=await listen(proxy);t.after(()=>close(proxy));
  assert.equal((await fragmentedPost(proxyUrl+'/api/auth/login',{Origin:'https://ideas.example'},{password:'한글 비밀번호'})).status,200);assert.equal(forwarded.password,'한글 비밀번호');
});
test('사용자가 정한 웹 비밀번호로 바꾸면 이전 비밀번호는 거절하고 중계 키는 유지함',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'ideas-remote-password-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const before=await prepareRemoteSecrets(directory),old=(await readFile(path.join(directory,'remote-login.txt'),'utf8')).split('\n')[1];
  for(const value of ['short',undefined,'x'.repeat(129)])await assert.rejects(setRemotePassword(value,directory));
  await assert.rejects(setRemotePassword('my-own-password-1',path.join(directory,'missing')),/원격 인증 설정/);
  await setRemotePassword('my-own-password-1',directory);
  const after=await prepareRemoteSecrets(directory);assert.equal(after.bridgeToken,before.bridgeToken);assert.notEqual(after.salt,before.salt);
  await assert.rejects(readFile(path.join(directory,'remote-login.txt')));assert.ok(!(await readFile(path.join(directory,'remote-secrets.json'),'utf8')).includes('my-own-password-1'));
  const worker=await createRemoteWorker({secrets:after,localUrl:'http://127.0.0.1:9/',directory:path.join(directory,'jobs')}),url=await listen(worker);t.after(()=>close(worker));
  const login=password=>fetch(url+'/api/auth/login',{method:'POST',headers:{Authorization:'Bearer '+after.bridgeToken,'Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.equal((await login(old)).status,401);assert.equal((await login('my-own-password-1')).status,200);
});
test('Google login uses the existing protected worker session and keeps password fallback',async t=>{
  const clientId='123456789-test.apps.googleusercontent.com';let nonce;
  const f=await workerFixture(t,(req,res)=>{res.end('{"items":[]}');},{googleSettings:{clientId,allowedEmail:'owner@gmail.com'},verifyGoogleToken:async()=>({aud:clientId,iss:'https://accounts.google.com',exp:Math.floor(Date.now()/1000)+600,email:'owner@gmail.com',email_verified:true,sub:'owner-id',nonce})});
  const challenge=await f.request('/api/auth/config');nonce=(await challenge.json()).google.nonce;const challengeCookie=challenge.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/auth/google',{body:{credential:'token'}})).status,401);
  const loggedIn=await f.request('/api/auth/google',{cookie:challengeCookie,body:{credential:'token'}});assert.equal(loggedIn.status,200);const cookie=loggedIn.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/rooms',{cookie})).status,200);assert.equal((await f.request('/api/auth/google',{cookie:challengeCookie,body:{credential:'token'}})).status,401);
  await f.login();await f.request('/api/auth/logout',{cookie,body:{}});assert.equal((await f.request('/api/rooms',{cookie})).status,401);
});
test('proxy allows only Google bootstrap routes without session and enforces same origin for credential POST',async t=>{
  let calls=0,forwarded;const server=http.createServer(createRemoteProxy({env:{IDEAS_BRIDGE_TOKEN:'bridge',IDEAS_WORKER_URL:'https://test.trycloudflare.com',IDEAS_PUBLIC_ORIGIN:'https://ideas.example'},fetchImpl:async(url,options)=>{calls++;forwarded=options;return new Response('{}',{headers:{'Set-Cookie':'__Host-ideas_google=test; Path=/; HttpOnly; Secure'}});}}));const url=await listen(server);t.after(()=>close(server));
  assert.equal((await fetch(url+'/api/auth/config')).status,200);assert.equal((await fetch(url+'/api/rooms')).status,401);
  assert.equal((await fetch(url+'/api/auth/google',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  const cookie='__Host-ideas_google='+'a'.repeat(43);const response=await fetch(url+'/api/auth/google',{method:'POST',headers:{Origin:'https://ideas.example','Content-Type':'application/json',Cookie:cookie},body:'{"credential":"test-token"}'});assert.equal(response.status,200);assert.equal(forwarded.headers.Cookie,cookie);assert.equal(calls,2);assert.match(response.headers.get('set-cookie'),/HttpOnly; Secure/);
  assert.equal((await fetch(url+'/api/auth/google')).status,405);assert.equal((await fetch(url+'/api/auth/config',{method:'POST'})).status,405);
});
test('worker health requires bridge auth and bypasses user sessions without consuming login challenges',async t=>{
  const f=await workerFixture(t,()=>assert.fail('health must not reach project server'));
  assert.equal((await f.request('/api/worker/health',{bridge:'wrong'})).status,401);
  const a=await f.request('/api/worker/health'),b=await f.request('/api/worker/health');assert.equal(a.status,200);const first=await a.json();assert.equal(first.healthy,true);assert.ok(first.instanceId);assert.equal((await b.json()).instanceId,first.instanceId);assert.equal(a.headers.get('set-cookie'),null);
  await f.restart();assert.notEqual((await (await f.request('/api/worker/health')).json()).instanceId,first.instanceId);
});
test('public health route accepts only bridge bearer authentication and GET',async t=>{
  let calls=0;const server=http.createServer(createRemoteProxy({env:{IDEAS_BRIDGE_TOKEN:'bridge',IDEAS_WORKER_URL:'https://test.trycloudflare.com'},fetchImpl:async(url,options)=>{calls++;assert.ok(String(url).endsWith('/api/worker/health'));assert.equal(options.headers.Authorization,'Bearer bridge');return new Response('{"healthy":true,"instanceId":"worker-1"}');}}));const url=await listen(server);t.after(()=>close(server));
  assert.equal((await fetch(url+'/api/worker/health')).status,401);assert.equal((await fetch(url+'/api/worker/health',{headers:{Authorization:'Bearer wrong'}})).status,401);assert.equal((await fetch(url+'/api/worker/health',{method:'POST',headers:{Authorization:'Bearer bridge'}})).status,401);assert.equal(calls,0);
  const response=await fetch(url+'/api/worker/health',{headers:{Authorization:'Bearer bridge'}});assert.equal(response.status,200);assert.equal((await response.json()).healthy,true);assert.equal(calls,1);
});
test('authenticated GitHub account route added on Windows reaches the worker through the same proxy',async t=>{
  let calls=0;const server=http.createServer(createRemoteProxy({env:{IDEAS_BRIDGE_TOKEN:'bridge',IDEAS_WORKER_URL:'https://test.trycloudflare.com'},fetchImpl:async url=>{calls++;assert.ok(String(url).endsWith('/api/github'));return new Response('{"available":true}');}}));const url=await listen(server);t.after(()=>close(server));
  assert.equal((await fetch(url+'/api/github')).status,401);assert.equal(calls,0);assert.equal((await fetch(url+'/api/github',{headers:{Cookie:'__Host-ideas_session='+'a'.repeat(43)}})).status,200);assert.equal(calls,1);
});
