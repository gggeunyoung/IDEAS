import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequest,runMeeting} from '../room.mjs';
import {callProvider,publicConfig} from '../providers.mjs';
import {createServer} from '../server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const env={OPENAI_API_KEY:'test-openai',ANTHROPIC_API_KEY:'test-anthropic',GEMINI_API_KEY:'test-gemini'};
const request={history:[{speaker:'사용자',text:'실험 하나를 제안해줘'}],participants:['gpt','claude','gemini'],mode:'live',review:true};

test('모든 독립 답변 완료 후 동일한 기록으로 상호 검토하며 최대 6회 호출',async()=>{
  const calls=[],events=[];
  await runMeeting(request,e=>events.push(e),{env,invoke:async(id,prompt)=>{
    const review=prompt.user.includes('아래는 이번 라운드');calls.push({id,prompt,review});
    if(id==='claude'&&!review) await new Promise(resolve=>setTimeout(resolve,20));
    if(review){assert.equal(calls.filter(c=>!c.review).length,3);for(const name of ['GPT','Claude','Gemini'])assert.ok(prompt.user.includes(`${name}: ${name} 독립`));}
    const speaker={gpt:'GPT',claude:'Claude',gemini:'Gemini'}[id];return{provider:id,speaker,text:`${speaker} ${review?'검토':'독립'}`,costUSD:.001};
  }});
  assert.equal(calls.length,6);assert.equal(events.filter(e=>e.type==='answer').length,6);assert.equal(events.at(-1).type,'done');
});
test('한 제공자 실패에도 다른 답변을 유지하고 실패 참가자의 검토를 호출하지 않음',async()=>{
  const calls=[],events=[];
  await runMeeting(request,e=>events.push(e),{env,invoke:async(id)=>{calls.push(id);if(id==='claude')throw new Error('테스트 실패');return{provider:id,speaker:id==='gpt'?'GPT':'Gemini',text:'성공'};}});
  assert.equal(calls.length,5);assert.equal(events.filter(e=>e.type==='error').length,1);assert.equal(events.filter(e=>e.type==='answer').length,4);
});
test('데모는 키와 외부 호출 없이 동작',async()=>{
  const events=[];await runMeeting({...request,mode:'demo'},e=>events.push(e),{env:{},invoke:()=>assert.fail('데모에서 API 호출됨')});
  assert.equal(events.filter(e=>e.type==='answer').length,6);assert.ok(events.filter(e=>e.type==='answer').every(e=>e.mode==='demo'&&e.costUSD===0));
});
test('부족한 키는 첫 호출 전에 거절하고 중복 참가자·과도한 입력 거절',async()=>{
  await assert.rejects(runMeeting(request,()=>{}, {env:{},invoke:()=>assert.fail()}),/API 키/);
  assert.throws(()=>validateRequest({...request,participants:['gpt','gpt']}));
  assert.throws(()=>validateRequest({...request,history:[{speaker:'사용자',text:'x'.repeat(24001)}]}));
});
test('실제 API 어댑터 요청 형식과 제공자별 사용량 해석',async()=>{
  for(const id of request.participants){
    let outgoing;
    const payload=id==='gpt'?{output:[{content:[{type:'output_text',text:'답변'}]}],usage:{input_tokens:100,output_tokens:20}}:id==='claude'?{content:[{type:'text',text:'답변'}],usage:{input_tokens:100,output_tokens:20}}:{candidates:[{content:{parts:[{text:'답변'}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:15,thoughtsTokenCount:5}};
    const result=await callProvider(id,{system:'지침',user:'질문'},{env,fetchImpl:async(url,options)=>{outgoing={url,...options,body:JSON.parse(options.body)};return new Response(JSON.stringify(payload));}});
    assert.equal(result.text,'답변');assert.equal(result.inputTokens,100);assert.equal(result.outputTokens,20);assert.ok(result.costUSD>0);
    assert.equal(outgoing.method,'POST');assert.ok(!outgoing.url.includes('test-'));
    if(id==='gpt'){assert.equal(outgoing.body.max_output_tokens,1024);assert.equal(outgoing.body.store,false);}
    if(id==='claude'){assert.equal(outgoing.body.system,'지침');assert.equal(outgoing.body.max_tokens,1024);}
    if(id==='gemini')assert.equal(outgoing.headers['x-goog-api-key'],'test-gemini');
  }
});
test('API 오류 응답의 비밀정보를 숨기고 모델 변경 시 비용을 미확인으로 표시',async()=>{
  await assert.rejects(callProvider('gpt',{system:'s',user:'u'},{env,fetchImpl:async()=>new Response('secret test-openai',{status:401})}),error=>error.message.includes('401')&&!error.message.includes('test-openai'));
  assert.equal(publicConfig({...env,OPENAI_MODEL:'custom'})[0].rates,null);
  assert.ok(!JSON.stringify(publicConfig(env)).includes('test-openai'));
});
test('HTTP 통합: 화면 제공, 같은 출처 데모, 외부 출처 및 비밀 파일 거절',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ideas-http-test-'));
  const server=createServer({env:{},projectRoot:dir,artifactDir:path.join(dir,'artifacts'),deliverableDir:path.join(dir,'deliverables')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(url)).status,200);
    assert.equal((await fetch(url+'/.env')).status,404);
    const options={method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({...request,mode:'demo'})};
    const response=await fetch(url+'/api/meeting',options);assert.equal(response.status,200);
    const events=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));assert.equal(events.filter(e=>e.type==='answer').length,6);
    assert.equal((await fetch(url+'/api/meeting',{...options,headers:{...options.headers,Origin:'https://other.example'}})).status,403);
    assert.equal((await fetch(url+'/api/meeting',{...options,body:JSON.stringify(request)})).status,400);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
