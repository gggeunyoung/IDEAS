import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runGoalWorkflow,verifyGoalBundle,goalBudget} from '../goal-workflow.mjs';
import {validateRequest} from '../room.mjs';
import {createServer} from '../server.mjs';
import {createPreviewServer} from '../scripts/preview-server.mjs';
import {createDeliverable,saveVersion} from '../deliverables.mjs';
const request={mode:'subscription',workflow:'goal',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'동작 감지 시제품과 테스트를 만들어줘'}],budget:{minutes:10,maxCalls:6}};
const bundle=n=>({summary:`실제 구현 ${n}`,files:[{path:'motion.mjs',content:`export const n=${n};`},{path:'motion.test.mjs',content:`import {n} from './motion.mjs';import assert from 'node:assert/strict';assert.equal(n,${n});`}]});
const review=(verdict,remaining=[],fieldChecks=[])=>({verdict,summary:'파일과 서버 검사 결과 검토',remaining,fieldChecks});
async function withRoot(fn){const root=await mkdtemp(path.join(tmpdir(),'ideas-goal-test-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
const answer=(id,value)=>({speaker:id==='gpt'?'GPT':'Claude',provider:id,text:JSON.stringify(value),inputTokens:10,outputTokens:20});
const pass=async()=>({passed:true,hasTests:true,records:[{command:'node --test motion.test.mjs',code:0,output:'pass'}]});
test('goal budget and participant validation rejects invalid/unbounded execution',()=>{
  assert.deepEqual(goalBudget(),{minutes:60,maxCalls:12});
  for(const budget of [{minutes:0},{minutes:121},{maxCalls:100},{maxCalls:3}])assert.throws(()=>validateRequest({...request,budget}));
  assert.throws(()=>validateRequest({...request,mode:'live'}));assert.throws(()=>validateRequest({...request,review:false}));assert.throws(()=>validateRequest({...request,participants:['gpt','gemini']}));
});
test('actual files and test feedback reach other provider; remaining work triggers another implementation',async()=>withRoot(async root=>{
  const events=[],calls=[];let cycle=0;
  await runGoalWorkflow(request,e=>events.push(e),{deliverableDir:root,verify:async(bundle,dir)=>{assert.match(await readFile(path.join(dir,'motion.mjs'),'utf8'),/export const n/);return pass();},invokeLocal:async(id,prompt,options)=>{assert.ok(options.timeoutMs>180000&&options.timeoutMs<=600000);calls.push({id,prompt});return answer(id,id==='gpt'?bundle(++cycle):review(cycle===1?'continue':'field_pending',cycle===1?['오인식 대조군 추가']:[],cycle===1?[]:['실제 웹캠 두 사람 측정']));}});
  assert.equal(cycle,2);assert.deepEqual(calls.map(c=>c.id),['gpt','claude','gpt','claude']);assert.match(calls[1].prompt.user,/node --test/);assert.match(calls[2].prompt.user,/오인식/);
  const end=events.findLast(e=>e.type==='goal');assert.equal(end.status,'field_pending');const m=JSON.parse(await readFile(path.join(root,end.id,'manifest.json'),'utf8'));assert.deepEqual(m.versions,['draft','final']);assert.equal(m.status,'field_pending');assert.ok(events.some(e=>e.type==='done'));
}));
test('review cannot claim completion after failed/missing tests; budget exhaustion preserves latest files',async()=>withRoot(async root=>{
  const events=[];let n=0;
  await runGoalWorkflow({...request,budget:{minutes:10,maxCalls:4}},e=>events.push(e),{deliverableDir:root,verify:async()=>({passed:false,hasTests:false,records:[]}),invokeLocal:async(id)=>answer(id,id==='gpt'?bundle(++n):review('complete'))});
  const end=events.findLast(e=>e.type==='goal');assert.equal(end.status,'budget_exhausted');assert.equal(end.calls,4);assert.equal(n,2);assert.ok((await readFile(path.join(root,end.id,'final','motion.mjs'),'utf8')).includes('n=2'));
}));
test('repeated CLI failures stop after three attempts and keep an honest failure record',async()=>withRoot(async root=>{
  const events=[];let calls=0;await runGoalWorkflow(request,e=>events.push(e),{deliverableDir:root,verify:pass,invokeLocal:async()=>{calls++;throw new Error('account limit');}});
  assert.equal(calls,3);const end=events.findLast(e=>e.type==='goal');assert.equal(end.status,'failed');assert.match(end.text,/생성되지 않음/);assert.equal(JSON.parse(await readFile(path.join(root,end.id,'manifest.json'),'utf8')).status,'failed');
}));
test('cancellation retains generated files without another model call',async()=>withRoot(async root=>{
  const events=[],control=new AbortController();let calls=0;
  await runGoalWorkflow(request,e=>events.push(e),{deliverableDir:root,signal:control.signal,invokeLocal:async id=>{calls++;return answer(id,bundle(1));},verify:async()=>{control.abort();control.signal.throwIfAborted();}});
  const end=events.findLast(e=>e.type==='goal');assert.equal(end.status,'cancelled');assert.equal(calls,1);assert.ok(await readFile(path.join(root,end.id,'final','motion.mjs')));
}));
test('macOS sandbox executes actual Node tests and denies reading a separate project', {skip:process.platform!=='darwin'},async()=>withRoot(async root=>{
  const workspace=path.join(root,'workspace');await mkdir(workspace);const data=bundle(2);for(const f of data.files)await writeFile(path.join(workspace,f.path),f.content);
  const verified=await verifyGoalBundle(data,workspace);assert.equal(verified.passed,true,JSON.stringify(verified));
  // Fixture in the user's home is outside the sandbox's allowed /private/tmp and system paths.
  const outside=await mkdtemp(path.join(process.env.HOME,'ideas-sandbox-fixture-'));
  try{const file=path.join(outside,'private.txt');await writeFile(file,'test-only');const content=`import {readFileSync} from 'node:fs';readFileSync(${JSON.stringify(file)},'utf8');`;await writeFile(path.join(workspace,'escape.test.mjs'),content);const blocked=await verifyGoalBundle({files:[{path:'escape.test.mjs',content}]},workspace);assert.equal(blocked.passed,false);assert.match(blocked.records.at(-1).output,/EPERM|not permitted/);}finally{await rm(outside,{recursive:true,force:true});}
}));
test('HTTP goal execution persists real validation and final status in session/artifact/download', {skip:process.platform!=='darwin'},async()=>withRoot(async root=>{
  const results=path.join(root,'results');const server=createServer({env:{},projectRoot:root,deliverableDir:results,artifactDir:path.join(root,'artifacts'),status:async()=>[{id:'gpt',ready:true},{id:'claude',ready:true}],invokeLocal:async id=>answer(id,id==='gpt'?bundle(3):review('field_pending',[],['실제 카메라 측정']))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try{const response=await fetch(origin+'/api/meeting',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,200);const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.ok(events.some(e=>e.type==='done'));assert.equal(events.findLast(e=>e.type==='goal').status,'field_pending');const result=events.findLast(e=>e.type==='deliverable');assert.match(await (await fetch(origin+result.files[0].url)).text(),/n=3/);const session=await(await fetch(origin+'/api/session')).json();assert.ok(session.messages.some(e=>e.type==='goal'&&e.final));const artifact=events.find(e=>e.type==='artifact');assert.match(await(await fetch(origin+artifact.url)).text(),/현장 검증 대기/);}finally{await new Promise(resolve=>server.close(resolve));}
}));
test('prototype preview uses a separate local origin and serves only files present in the saved bundle',async()=>withRoot(async root=>{
  const dir=path.join(root,'outputs'),id=await createDeliverable(dir,request);await saveVersion(dir,id,'final',{summary:'page',files:[{path:'index.html',content:'<!doctype html><h1>시제품</h1>'},{path:'app.mjs',content:'export const ok=true;'}]});
  const server=createPreviewServer({registry:{resolve:async roomId=>{if(roomId!=='lab')throw new Error();return {id:'lab',root};}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try{const page=await fetch(`${origin}/lab/${id}/final/index.html`);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);assert.match(await page.text(),/시제품/);assert.match((await fetch(`${origin}/lab/${id}/final/app.mjs`)).headers.get('content-type'),/text\/javascript/);assert.equal((await fetch(`${origin}/lab/${id}/final/..%2F.env`)).status,404);assert.equal((await fetch(`${origin}/other/${id}/final/index.html`)).status,404);assert.equal((await fetch(origin+'/api/rooms')).status,404);assert.equal((await fetch(`${origin}/lab/${id}/final/index.html`,{method:'POST'})).status,403);}finally{await new Promise(resolve=>server.close(resolve));}
}));
