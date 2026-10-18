import test from 'node:test';
import assert from 'node:assert/strict';
import {newProgress,progressEvent,progressJob,progressView,replayHistory} from '../public/progress.js';
import {createActivityReporter} from '../agent-activity.mjs';
import {runProcess,subscriptionEnv,callTeamAgent,parseTeamTurn} from '../local-agents.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from '../server.mjs';

const start='2026-10-18T15:00:00.000Z',base=Date.parse(start);
test('진행 상태는 실제 시각으로 복원하고 병렬 참가자와 종료를 구분한다',()=>{
  const p=newProgress();
  progressEvent(p,{type:'pending',provider:'gpt',speaker:'GPT',round:5,at:start});
  progressEvent(p,{type:'pending',provider:'claude',speaker:'Claude',round:5,at:start});
  progressEvent(p,{type:'activity',provider:'gpt',activity:'searching',at:start});
  progressJob(p,{status:'running',createdAt:start},base+120000);
  let view=progressView(p,base+120000);
  assert.equal(view.title,'GPT · Claude 작업 중');assert.match(view.elapsed,/2분 0초/);
  assert.match(view.agents[0].detail,/웹 검색 중/);assert.match(view.agents[0].note,/새 활동 보고/);
  progressEvent(p,{type:'answer',provider:'gpt'});
  assert.equal(progressView(p,base+121000).title,'Claude 작업 중');assert.equal(p.answers,1);
  progressEvent(p,{type:'goal',final:true,status:'budget_exhausted'});progressEvent(p,{type:'done'});
  assert.equal(p.finalLabel,'budget_exhausted');assert.equal(progressView(p,base+121000).state,'finished');
  assert.equal(progressView(p,base+121000).agents.length,0);
});
test('정상 폴링을 AI 활동으로 속이지 않고 연결 지연은 실행 여부 미확인으로 표시한다',()=>{
  const p=newProgress();progressEvent(p,{type:'pending',provider:'gpt',speaker:'GPT'});
  progressJob(p,{status:'running'},base);
  const connected=progressView(p,base+1000);assert.equal(connected.state,'running');
  assert.match(connected.elapsed,/미기록/);assert.match(connected.agents[0].note,/세부 활동 보고 대기/);
  assert.equal(progressView(p,base+16000).state,'unknown');
  p.connection='offline';assert.match(progressView(p,base+1000).title,/실행 여부 미확인/);
  progressJob(p,{status:'running'},base+20000);assert.equal(progressView(p,base+20001).state,'running');
  for(const status of ['failed','cancelled','interrupted']){const failed=newProgress();progressJob(failed,{status},base);assert.equal(progressView(failed,base).state,'finished');assert.equal(failed.terminal,status);}
});
test('작업 재조회는 앞선 대화를 유지하고 이미 저장된 답변을 중복하지 않으며 종료 시각을 복원한다',()=>{
  const old={speaker:'사용자',text:'오래된 대화'},prompt={speaker:'사용자',text:'현재 요청'},answer={speaker:'GPT',text:'답변'};
  assert.deepEqual(replayHistory([old,prompt,answer],[prompt],'subscription','team'),[old,prompt]);
  const p=newProgress(start);progressJob(p,{status:'done',finishedAt:'2026-10-18T15:02:00.000Z'},base+3600000);
  assert.match(progressView(p,base+3600000).elapsed,/2분 0초/);
});
test('파일 협업의 이름만 포함한 오류도 실패한 참가자의 작업 중 표시를 해제한다',()=>{
  const p=newProgress();progressEvent(p,{type:'pending',provider:'claude',speaker:'Claude'});
  progressEvent(p,{type:'pending',provider:'gpt',speaker:'GPT'});
  progressEvent(p,{type:'error',speaker:'Claude',text:'호출 실패'});
  progressJob(p,{status:'running'},base);
  assert.equal(progressView(p,base).title,'GPT 작업 중');assert.equal(p.answers,0);
});
test('CLI 활동은 나뉜 JSON 줄을 복원하고 원문·도구 인자·추론을 전달하지 않는다',()=>{
  const events=[];let now=base;const report=createActivityReporter('claude',e=>events.push(e),{now:()=>now});
  const raw=JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'WebSearch',input:{query:'PRIVATE_SECRET'}}]}})+'\n';
  report(raw.slice(0,20));assert.equal(events.length,0);report(raw.slice(20));report(raw);
  assert.equal(events.length,1);assert.deepEqual(events[0],{activity:'searching',at:start});
  now+=3000;report(raw);assert.equal(events.length,2);
  report(JSON.stringify({type:'assistant',message:{content:[{type:'thinking',thinking:'PRIVATE_SECRET'}]}})+'\n');
  report('invalid\n');assert.ok(!JSON.stringify(events).includes('PRIVATE_SECRET'));
  const gpt=[];const g=createActivityReporter('gpt',e=>gpt.push(e));
  g(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'cat private.env'}})+'\n');
  g(JSON.stringify({type:'item.completed',item:{type:'file_change',changes:[{path:'private.env'}]}})+'\n');
  g(JSON.stringify({type:'error',message:'Reconnecting... 1/5 PRIVATE_SECRET'})+'\n');
  assert.deepEqual(gpt.map(e=>e.activity),['command','editing','retrying']);assert.ok(!JSON.stringify(gpt).includes('private'));
});
test('실제 자식 프로세스 출력의 활동은 프로세스 종료 전에 전달된다',async()=>{
  let observed=false,complete=false;
  const reporter=createActivityReporter('gpt',()=>{assert.equal(complete,false);observed=true;});
  const result=await runProcess(process.execPath,['-e',`console.log(JSON.stringify({type:'item.started',item:{type:'web_search'}}));setTimeout(()=>console.log('done'),100);`],{env:subscriptionEnv(),onStdout:reporter});
  complete=true;assert.equal(result.code,0);assert.equal(observed,true);assert.match(result.stdout,/done/);
});
test('Claude 팀 스트림의 최종 보고·세션·사용량을 보존하며 실시간 도구 활동을 전달한다',async()=>{
  const result={type:'result',session_id:'session',structured_output:{message:'완료',status:'done',next:'',question:''},usage:{input_tokens:5,output_tokens:7}};
  const raw=[{type:'system',subtype:'init'},{type:'assistant',message:{content:[{type:'tool_use',name:'Write'}]}},result].map(JSON.stringify).join('\n')+'\n';
  const activities=[];
  const answer=await callTeamAgent('claude',{system:'지시',user:'요청'},{cwd:process.cwd(),outputSchema:{},onActivity:e=>activities.push(e),runner:async(command,args,options)=>{
    assert.equal(args[args.indexOf('--output-format')+1],'stream-json');assert.ok(args.includes('--verbose'));options.onStdout(raw);return {code:0,stdout:raw};
  }});
  assert.equal(answer.report.status,'done');assert.equal(answer.session,'session');assert.equal(answer.usage.outputTokens,7);
  assert.deepEqual(activities.map(e=>e.activity),['waiting','editing']);
  assert.equal(parseTeamTurn('claude',JSON.stringify(result)).report.status,'done');
});
test('회의 HTTP 스트림은 최종 답변 전에 활동과 실제 시각을 브라우저로 전달한다',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ideas-progress-'));let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const server=createServer({projectRoot:dir,artifactDir:path.join(dir,'artifacts'),deliverableDir:path.join(dir,'outputs'),status:async()=>[{id:'gpt',ready:true}],invokeLocal:async(id,prompt,options)=>{
    options.onActivity({activity:'searching',at:start});await gate;return {provider:id,speaker:'GPT',text:'시험 답변'};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(url+'/api/meeting',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({history:[{speaker:'사용자',text:'검증'}],participants:['gpt'],mode:'subscription',workflow:'discuss',review:false})});
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
    while(!text.includes('"type":"activity"')){const {value,done}=await reader.read();assert.equal(done,false);text+=decoder.decode(value);}
    const events=text.trim().split('\n').map(JSON.parse);
    assert.ok(events.some(e=>e.type==='pending'&&Number.isFinite(Date.parse(e.at))));assert.equal(events.find(e=>e.type==='activity').activity,'searching');assert.ok(!events.some(e=>e.type==='answer'));
    release();while(true){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value);}
    assert.ok(text.includes('"type":"done"'));
    assert.equal((await fetch(url+'/progress.js')).status,200);
  }finally{release();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
