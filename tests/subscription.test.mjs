import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,readFile,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {subscriptionEnv,callLocalAgent,parseLocalAnswer,localStatus,runProcess,executableFor} from '../local-agents.mjs';
import {projectFiles,snapshotFiles,readArtifact} from '../project-context.mjs';
import {runMeeting,validateRequest} from '../room.mjs';
import {createServer} from '../server.mjs';
const request={history:[{speaker:'사용자',text:'제공된 이력으로 자기소개서 초안을 만들어줘'}],participants:['gpt','claude','gemini'],mode:'subscription',review:true,workflow:'draft',writer:'claude'};
const fixture=async fn=>{const dir=await mkdtemp(path.join(tmpdir(),'ideas-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};

test('구독 실행 환경은 API 키·과금 인증 변수·개인 실행 설정을 물려주지 않음',()=>{
  const env=subscriptionEnv({HOME:'/account',PATH:'/bin',OPENAI_API_KEY:'secret',ANTHROPIC_AUTH_TOKEN:'secret',GEMINI_API_KEY:'secret',GOOGLE_APPLICATION_CREDENTIALS:'/billing.json',CLAUDE_CODE_OAUTH_TOKEN:'secret',NODE_OPTIONS:'--require evil.js',GEMINI_CLI_SYSTEM_SETTINGS_PATH:'/bad.json'});
  assert.deepEqual(env,{HOME:'/account',PATH:'/bin'});
});
test('CLI 응답 파서가 제공자별 실제 출력 포맷을 읽고 오류 원문은 숨김',()=>{
  const gpt=parseLocalAnswer('gpt','{"type":"thread.started"}\n{"type":"item.completed","item":{"type":"agent_message","text":"답변"}}\n{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":9}}\n');
  assert.equal(gpt.text,'답변');assert.equal(gpt.inputTokens,120);
  assert.equal(parseLocalAnswer('claude','{"result":"초안","usage":{"input_tokens":4,"output_tokens":8}}').text,'초안');
  assert.deepEqual(JSON.parse(parseLocalAnswer('claude',JSON.stringify({result:'',structured_output:{summary:'s',files:[{path:'x.md',content:'x'}]}})).text).files,[{path:'x.md',content:'x'}]);
  const gemini=parseLocalAnswer('gemini','{"response":"검토","stats":{"models":{"model":{"tokens":{"input":7,"candidates":2,"thoughts":3}}}}}');
  assert.equal(gemini.outputTokens,5);assert.equal(gemini.model,'model');
  assert.equal(parseLocalAnswer('gemini','{"response":"답변","stats":{"models":{"model":{"tokens":{}}}}}').inputTokens,undefined);
  assert.throws(()=>parseLocalAnswer('gpt','{"type":"turn.failed","error":{"message":"sk-secret"}}'),e=>!e.message.includes('sk-secret'));
});
test('로그인 검사에서 API 인증을 구독 준비 상태로 인정하지 않음',async()=>{
  const status=await localStatus({env:{HOME:'/missing',PATH:'/bin'},runner:async(command,args)=>({code:0,stdout:args[0]==='--version'?'version':command.includes('claude')?'{"loggedIn":true,"authMethod":"apiKey"}':'Logged in using an API key',stderr:''})});
  assert.ok(status.every(p=>!p.ready));assert.ok(!JSON.stringify(status).includes('apiKey'));
});
test('로컬 어댑터는 분리된 임시 작업공간·읽기 제한을 사용하고 원문/키를 명령 인자에 넣지 않음',async()=>{
  for(const id of ['gpt','claude']){
    let directory;
    const answer=await callLocalAgent(id,{system:'지침',user:'개인자료-질문'},{env:{HOME:'/account',PATH:process.env.PATH,OPENAI_API_KEY:'do-not-use'},runner:async(command,args,options)=>{
      directory=options.cwd;assert.ok(directory.startsWith(tmpdir()));assert.ok(!args.join(' ').includes('개인자료-질문'));assert.ok(options.input.includes('개인자료-질문'));assert.equal(options.env.OPENAI_API_KEY,undefined);
      if(id==='gpt'){assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('read-only'));}
      if(id==='claude'){assert.ok(args.includes('--safe-mode'));assert.ok(args.includes('--strict-mcp-config'));assert.ok(!args.includes('--bare'));}
      return {code:0,stdout:id==='gpt'?'{"type":"item.completed","item":{"type":"agent_message","text":"완료"}}':id==='claude'?'{"result":"완료"}':'{"response":"완료"}',stderr:''};
    }});
    assert.equal(answer.billing,'subscription');assert.equal(answer.costUSD,null);await assert.rejects(readFile(path.join(directory,'system.json')));
  }
});
test('지원 종료된 Gemini 개인 구독 경로는 실행하거나 API로 대체하지 않음',async()=>{
  await assert.rejects(callLocalAgent('gemini',{system:'s',user:'u'},{runner:()=>assert.fail('지원 종료 CLI가 실행됨')}),/지원이 종료/);
});
test('사용자가 중단하면 실행 중인 CLI가 종료됨',async()=>{
  const controller=new AbortController();const running=runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{env:subscriptionEnv(),signal:controller.signal,timeout:3000});
  setTimeout(()=>controller.abort(),50);await assert.rejects(running,/중단/);
});
test('초안은 한 작성자만 만들고 모든 독립 제안 완료 후 다른 참가자가 검토함',async()=>{
  const calls=[],events=[];
  await runMeeting(request,e=>events.push(e),{context:'이력 자료',invoke:()=>assert.fail('구독에서 API 호출'),invokeLocal:async(id,prompt)=>{
    const draft=prompt.user.includes('유일한 작성자'),review=prompt.user.includes('마지막 참가자 답변이 작성자 초안');
    if(draft){assert.equal(id,'claude');assert.equal(calls.length,3);}
    if(review){assert.notEqual(id,'claude');assert.ok(prompt.user.includes('작성된 초안'));}
    assert.ok(prompt.user.includes('이력 자료'));calls.push({id,draft,review});
    return {provider:id,speaker:{gpt:'GPT',claude:'Claude',gemini:'Gemini'}[id],text:draft?'작성된 초안':review?'검토 의견':'독립 의견',billing:'subscription'};
  }});
  assert.equal(calls.length,6);assert.equal(calls.filter(c=>c.draft).length,1);assert.equal(events.filter(e=>e.round===3&&e.type==='answer').length,2);
  assert.throws(()=>validateRequest({...request,writer:'other'}));
});
test('파일 스냅샷은 선택된 자료만 읽고 환경 파일·외부 링크·비밀정보를 거절함',async()=>fixture(async dir=>{
  await writeFile(path.join(dir,'bio.md'),'실제 이력');await writeFile(path.join(dir,'.env'),'PRIVATE=secret');await mkdir(path.join(dir,'node_modules'));await writeFile(path.join(dir,'node_modules','hidden.md'),'숨김');
  // Windows without symlink privilege: a directory junction is still an outside link.
  try{await symlink('/etc/hosts',path.join(dir,'outside.txt'));}catch(e){if(e.code!=='EPERM')throw e;await symlink(tmpdir(),path.join(dir,'outside.txt'),'junction');}await writeFile(path.join(dir,'bad.txt'),'-----BEGIN PRIVATE KEY-----');
  assert.deepEqual(await projectFiles(dir),['bad.txt','bio.md']);assert.match(await snapshotFiles(dir,['bio.md']),/실제 이력/);
  for(const name of ['.env','../outside.md','outside.txt','node_modules/hidden.md','bad.txt'])await assert.rejects(snapshotFiles(dir,[name]));
  assert.equal(await snapshotFiles(dir,[]),'');
}));
test('HTTP 구독 회의는 로그인 전 차단하며 완료 결과를 안전한 다운로드로 제공함',async()=>fixture(async dir=>{
  await writeFile(path.join(dir,'bio.md'),'확인된 이력');let ready=false,calls=0;
  const server=createServer({env:{},projectRoot:dir,artifactDir:path.join(dir,'results'),status:async()=>[{id:'gpt',ready}],invokeLocal:async(id,prompt)=>{calls++;assert.ok(prompt.user.includes('확인된 이력'));return {provider:id,speaker:'GPT',text:'검증 결과',billing:'subscription'};}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  const body={...request,participants:['gpt'],workflow:'discuss',files:['bio.md']};const options={method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify(body)};
  try{
    assert.equal((await fetch(url+'/api/meeting',options)).status,400);assert.equal(calls,0);ready=true;
    const response=await fetch(url+'/api/meeting',options);const events=(await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(calls,1);assert.equal(events.at(-1).type,'done');const artifact=events.find(e=>e.type==='artifact');assert.ok(artifact);
    assert.match(await (await fetch(url+artifact.url)).text(),/検証結果|검증 결과/);
    await assert.rejects(readArtifact(path.join(dir,'results'),'../../.env'));
    assert.equal((await fetch(url+'/api/artifacts/not-an-id')).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
}));

test('웹 검색 기록은 도구 이벤트로 집계하고 답변 출처 URL을 안전하게 추출함',()=>{
  const answer='[공식 문서](https://nodejs.org/api/test.html) https://nodejs.org/api/test.html https://user:pass@bad.example/';
  const gpt=parseLocalAnswer('gpt',[{type:'item.completed',item:{type:'web_search'}},{type:'item.completed',item:{type:'agent_message',text:answer}}].map(JSON.stringify).join('\n'));
  assert.equal(gpt.webSearchCount,1);assert.deepEqual(gpt.sources,['https://nodejs.org/api/test.html']);
  const tool={type:'assistant',message:{content:[{type:'tool_use',id:'search-1',name:'WebSearch'},{type:'tool_use',id:'fetch-1',name:'WebFetch'}]}};
  const claude=parseLocalAnswer('claude',[tool,tool,{type:'result',result:answer}].map(JSON.stringify).join('\n'));
  assert.equal(claude.webSearchCount,1);assert.equal(claude.webFetchCount,1);
  assert.throws(()=>parseLocalAnswer('claude',JSON.stringify(tool)),/텍스트 답변/);
});
test('검색을 허용해도 셸·파일·MCP 도구를 열지 않고 끄면 검색 도구도 차단함',async()=>{
  for(const id of ['gpt','claude'])for(const webSearch of [true,false]){
    await callLocalAgent(id,{system:'지침',user:'검색 요청'},{webSearch,runner:async(command,args,options)=>{
      if(id==='gpt'){assert.ok(args.includes(`web_search="${webSearch?'live':'disabled'}"`));assert.ok(args.includes('shell_tool'));assert.ok(args.includes('read-only'));}
      else{assert.equal(args[args.indexOf('--tools')+1],webSearch?'WebSearch,WebFetch':'');assert.ok(args.includes('--strict-mcp-config'));assert.ok(!args.includes('--dangerously-skip-permissions'));}
      assert.equal(options.timeout,webSearch?120000:90000);
      return {code:0,stdout:id==='gpt'?'{"type":"item.completed","item":{"type":"agent_message","text":"완료"}}':'{"result":"완료"}',stderr:''};
    }});
  }
});
test('검색 옵션은 모든 구독 회의 단계에 전달되고 API/데모에서는 거절함',async()=>{
  let calls=0;
  await runMeeting({...request,participants:['gpt','claude'],webSearch:true},()=>{},{invokeLocal:async(id,prompt,options)=>{
    assert.equal(options.webSearch,true);assert.ok(!prompt.system.includes('웹 검색 도구가 연결되지 않았으므로'));calls++;
    return {provider:id,speaker:id==='gpt'?'GPT':'Claude',text:'답변'};
  }});
  assert.equal(calls,4);
  for(const mode of ['live','demo'])assert.throws(()=>validateRequest({...request,mode,webSearch:true}),/기존 구독 모드/);
  assert.throws(()=>validateRequest({...request,webSearch:'true'}),/웹 검색 여부/);
});
test('Windows는 데스크톱 앱에 포함된 최신 CLI 실행 파일을 찾고 명시 경로를 우선함',async()=>fixture(async dir=>{
  const local=path.join(dir,'local'),roaming=path.join(dir,'roaming'),profile=path.join(dir,'profile');
  const exe=async(file,seconds)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'');await utimes(file,seconds,seconds);return file;};
  await exe(path.join(local,'OpenAI','Codex','bin','old','codex.exe'),1000);const codex=await exe(path.join(local,'OpenAI','Codex','bin','new','codex.exe'),2000);
  await mkdir(path.join(local,'OpenAI','Codex','bin','rg-only'),{recursive:true});
  await exe(path.join(roaming,'Claude','claude-code','2.1.289','a1','claude.exe'),1000);const claude=await exe(path.join(roaming,'Claude','claude-code','2.1.295','b2','claude.exe'),2000);
  const env={LOCALAPPDATA:local,APPDATA:roaming,USERPROFILE:profile};
  assert.equal(await executableFor('gpt',env,'win32'),codex);assert.equal(await executableFor('claude',env,'win32'),claude);
  const native=await exe(path.join(profile,'.local','bin','claude.exe'),3000);assert.equal(await executableFor('claude',env,'win32'),native);
  assert.equal(await executableFor('claude',{...env,LOCAL_CLAUDE_BIN:'C:\custom\claude.exe'},'win32'),'C:\custom\claude.exe');
  assert.equal(await executableFor('gpt',{},'win32'),'codex');
}));
test('macOS 밖에서는 목표 실행을 AI 호출 전에 거절함',{skip:process.platform==='darwin'},async()=>fixture(async dir=>{
  let calls=0;const server=createServer({projectRoot:dir,artifactDir:path.join(dir,'a'),deliverableDir:path.join(dir,'d'),status:async()=>[{id:'gpt',ready:true},{id:'claude',ready:true}],invokeLocal:async()=>{calls++;throw new Error('호출되면 안 됨');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(base+'/api/meeting',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({mode:'subscription',workflow:'goal',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'목표'}],budget:{minutes:10,maxCalls:4}})});
    assert.equal(response.status,400);assert.match((await response.json()).error,/macOS/);assert.equal(calls,0);
  }finally{server.close();}
}));
test('Windows Store(MSIX) Claude 앱의 패키지 전용 AppData에서도 CLI를 찾음',async()=>fixture(async dir=>{
  const local=path.join(dir,'local');const file=path.join(local,'Packages','Claude_pzs8sxrjxfjjc','LocalCache','Roaming','Claude','claude-code','2.1.295','d2','claude.exe');
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'');await mkdir(path.join(local,'Packages','Other_x','LocalCache','Roaming','Claude','claude-code','9','z'),{recursive:true});
  assert.equal(await executableFor('claude',{LOCALAPPDATA:local,APPDATA:path.join(dir,'roaming'),USERPROFILE:path.join(dir,'p')},'win32'),file);
}));
