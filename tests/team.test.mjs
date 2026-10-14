import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runTeamWorkflow,teamBudget,turnSchema} from '../team-workflow.mjs';
import {callTeamAgent,parseTeamTurn} from '../local-agents.mjs';
import {validateRequest} from '../room.mjs';
import {createRoomRegistry,git} from '../room-registry.mjs';
import {createServer} from '../server.mjs';

const fixture=async fn=>{const dir=await realpath(await mkdtemp(path.join(tmpdir(),'ideas-team-')));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:3});}};
async function project(dir,name='proj'){
  const root=path.join(dir,name);await mkdir(root);await git(root,['init','-q','-b','main']);
  for(const [k,v] of [['user.name','Owner'],['user.email','owner@example.invalid'],['core.autocrlf','false']])await git(root,['config',k,v]);
  await git(root,['remote','add','origin',`https://github.com/test-owner/${name}.git`]);
  await writeFile(path.join(root,'README.md'),'# 프로젝트\n');await git(root,['add','.']);await git(root,['commit','-q','-m','init']);return root;
}
const request=(text,extra={})=>({mode:'subscription',workflow:'team',participants:['claude','gpt'],writer:'claude',review:true,history:[{speaker:'사용자',text}],budget:{minutes:10,maxTurns:6},...extra});
const turn=(message,status='continue',extra={})=>({session:extra.session,report:{message,status,next:extra.next||'',question:extra.question||''},usage:{inputTokens:100,cachedInputTokens:60,outputTokens:10},actions:{commands:1,edits:1,turns:3},model:'test'});
async function run(root,req,agents){
  const events=[],calls=[];
  await runTeamWorkflow(req,e=>events.push(e),{projectRoot:root,invokeTeam:async(id,prompt,options)=>{calls.push({id,prompt,options});return agents.shift()(id,prompt,options);}});
  return {events,calls,final:events.find(e=>e.type==='goal'&&e.final)};
}

test('팀 예산과 참가자 검증은 GPT·Claude 구독 2명과 제한된 예산만 허용함',()=>{
  assert.deepEqual(teamBudget(),{minutes:60,maxTurns:8});
  for(const budget of [{minutes:5},{minutes:181},{maxTurns:1},{maxTurns:31},{minutes:1.5}])assert.throws(()=>teamBudget(budget));
  assert.ok(validateRequest(request('목표')));
  assert.throws(()=>validateRequest(request('목표',{mode:'demo'})));
  assert.throws(()=>validateRequest(request('목표',{participants:['claude']})));
  assert.throws(()=>validateRequest(request('목표',{participants:['claude','gemini']})));
  assert.throws(()=>validateRequest(request('목표',{writer:'gemini'})));
  assert.throws(()=>validateRequest(request('목표',{newTeam:'yes'})));
});

test('두 에이전트가 전용 브랜치 작업 트리에서 교대로 작업하고 서로 확인해야 완료됨',async()=>fixture(async dir=>{
  const root=await project(dir);
  const {events,calls,final}=await run(root,request('덧셈 모듈과 테스트를 만들어줘'),[
    async(id,p,o)=>{await writeFile(path.join(o.cwd,'add.mjs'),'export const add=(a,b)=>a+b;\n');return turn('add.mjs를 만들었습니다','continue',{session:'claude-1',next:'테스트 작성'});},
    async(id,p,o)=>{await writeFile(path.join(o.cwd,'add.test.mjs'),'// test\n');return turn('테스트를 추가하고 실행했습니다','done',{session:'gpt-1'});},
    async()=>turn('직접 확인했고 동의합니다','done',{session:'claude-1'}),
  ]);
  assert.equal(final.status,'complete');assert.deepEqual(calls.map(c=>c.id),['claude','gpt','claude']);
  // The user's checkout and branch are untouched; work lives on the team branch.
  assert.equal(await git(root,['branch','--show-current']),'main');assert.equal(await git(root,['status','--porcelain']),'');
  await assert.rejects(access(path.join(root,'add.mjs')));
  const state=JSON.parse(await readFile(path.join(root,'.ideas','team','state.json'),'utf8'));
  assert.match(state.branch,/^ideas\/team-[0-9a-f]{8}$/);assert.equal(calls[0].options.cwd,state.workspace);
  assert.equal(await git(state.workspace,['rev-list','--count',`${state.base}..HEAD`]),'2');
  assert.match(await git(state.workspace,['log','-1','--format=%an']),/GPT/);
  assert.deepEqual(state.sessions,{claude:'claude-1',gpt:'gpt-1'});
  assert.match(await readFile(path.join(await git(root,['rev-parse','--absolute-git-dir']),'info','exclude'),'utf8'),/^\/\.ideas\/$/m);
  // Each agent receives the teammate's new message and commits since its own last turn, and resumes its session.
  assert.equal(calls[0].options.session,undefined);assert.equal(calls[2].options.session,'claude-1');
  assert.match(calls[2].prompt.user,/테스트를 추가하고 실행했습니다/);assert.match(calls[2].prompt.user,/add\.test\.mjs/);assert.doesNotMatch(calls[2].prompt.user,/add\.mjs를 만들었습니다/);
  assert.deepEqual(calls[0].options.outputSchema,turnSchema);
  assert.ok(events.filter(e=>e.type==='answer').every(e=>e.phase==='team'));assert.equal(events.at(-1).type,'done');
  assert.match(await readFile(state.log,'utf8'),/Claude · 1차/);
}));

test('사용자 결정이 필요하면 멈추고 다음 요청에서 같은 팀·세션으로 이어감',async()=>fixture(async dir=>{
  const root=await project(dir);
  const first=await run(root,request('게임을 만들어줘'),[async()=>turn('조작 방식을 정해 주세요','need_user',{session:'claude-1',question:'키보드와 마우스 중 무엇을 쓸까요?'})]);
  assert.equal(first.final.status,'need_user');assert.match(first.final.text,/키보드와 마우스/);
  const second=await run(root,request('키보드로 해줘'),[async(id,p,o)=>{await writeFile(path.join(o.cwd,'game.mjs'),'// keyboard\n');return turn('키보드 조작을 구현했습니다','continue',{session:'claude-1'});},async()=>turn('확인했습니다','done',{session:'gpt-1'}),async()=>turn('동의합니다','done',{session:'claude-1'})]);
  assert.equal(second.final.status,'complete');assert.equal(second.calls[0].options.session,'claude-1');assert.equal(second.calls[0].options.cwd,first.calls[0].options.cwd);
  assert.match(second.calls[0].prompt.user,/프로젝트 목표\(처음 요청\): 게임을 만들어줘/);assert.match(second.calls[0].prompt.user,/이번 사용자 요청: 키보드로 해줘/);
  const fresh=await run(root,request('새로 시작',{newTeam:true}),[async()=>turn('a','done'),async()=>turn('b','done')]);
  assert.notEqual(fresh.calls[0].options.cwd,first.calls[0].options.cwd);assert.equal(fresh.calls[0].options.session,undefined);
}));

test('비밀정보로 보이는 파일은 팀 브랜치에 커밋하지 않음',async()=>fixture(async dir=>{
  const root=await project(dir);
  const {events}=await run(root,request('설정 추가'),[async(id,p,o)=>{await writeFile(path.join(o.cwd,'.env'),'TOKEN=x');await writeFile(path.join(o.cwd,'app.mjs'),'//');return turn('설정을 추가했습니다');},async()=>turn('a','done'),async()=>turn('b','done')]);
  const state=JSON.parse(await readFile(path.join(root,'.ideas','team','state.json'),'utf8'));
  assert.equal(await git(state.workspace,['ls-files']),'README.md\napp.mjs');assert.ok(events.some(e=>e.type==='notice'&&e.text.includes('.env')));
}));

test('실패가 이어지거나 변경 없이 대화만 반복하면 종료 사유를 남김',async()=>fixture(async dir=>{
  const root=await project(dir);
  const failing=await run(root,request('목표'),[0,1,2].map(()=>async()=>{throw new Error('네트워크 연결에 실패했습니다');}));
  assert.equal(failing.final.status,'failed');assert.equal(failing.events.filter(e=>e.type==='error').length,3);assert.deepEqual(failing.calls.map(c=>c.id),['claude','gpt','claude']);
  const quiet=await run(root,request('목표',{newTeam:true}),[0,1,2].map(i=>async()=>turn(`의견 ${i}`)));
  assert.equal(quiet.final.status,'stalled');
  const repo=path.join(dir,'empty');await mkdir(repo);await git(repo,['init','-q']);
  const empty=await run(repo,request('목표'),[]);assert.equal(empty.final.status,'failed');assert.match(empty.final.text,/첫 커밋/);
}));

test('Codex·Claude 팀 실행 인자는 작업 폴더 쓰기와 세션 재개만 열고 권한 우회는 쓰지 않음',async()=>{
  const seen=[];const runner=async(command,args,options)=>{seen.push({args,options});return {code:0,stdout:args.includes('exec')?['{"type":"thread.started","thread_id":"t-1"}','{"type":"item.completed","item":{"type":"command_execution"}}','{"type":"item.completed","item":{"type":"agent_message","text":"{\\"message\\":\\"완료\\",\\"status\\":\\"done\\",\\"next\\":\\"\\",\\"question\\":\\"\\"}"}}','{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":40,"output_tokens":5}}'].join('\n'):JSON.stringify({session_id:'c-1',num_turns:4,usage:{input_tokens:10,cache_read_input_tokens:30,output_tokens:5},structured_output:{message:'구현',status:'continue',next:'검토',question:''}})};};
  const env={LOCAL_CODEX_BIN:'codex',LOCAL_CLAUDE_BIN:'claude',OPENAI_API_KEY:'secret'};
  const gpt=await callTeamAgent('gpt',{system:'s',user:'u'},{cwd:'/work',env,runner,outputSchema:turnSchema});
  assert.equal(gpt.session,'t-1');assert.equal(gpt.report.status,'done');assert.deepEqual(gpt.usage,{inputTokens:50,cachedInputTokens:40,outputTokens:5});
  const codexArgs=seen[0].args;assert.equal(codexArgs[codexArgs.indexOf('--sandbox')+1],'workspace-write');assert.equal(codexArgs[codexArgs.indexOf('-C')+1],'/work');
  for(const flag of ['--dangerously-bypass-approvals-and-sandbox','--ephemeral','shell_tool','resume'])assert.ok(!codexArgs.includes(flag));
  await callTeamAgent('gpt',{system:'s',user:'u'},{cwd:'/work',env,runner,outputSchema:turnSchema,session:'t-1'});
  assert.deepEqual(seen[1].args.slice(-3),['resume','t-1','-']);assert.equal(seen[1].options.env.OPENAI_API_KEY,undefined);assert.equal(seen[1].options.env.PATH.split(path.delimiter)[0],path.dirname(process.execPath));
  const claude=await callTeamAgent('claude',{system:'s',user:'u'},{cwd:'/work',env,runner,outputSchema:turnSchema});
  const claudeArgs=seen[2].args;assert.match(claudeArgs[claudeArgs.indexOf('--session-id')+1],/^[0-9a-f-]{36}$/);assert.equal(claude.session,'c-1');assert.equal(claude.usage.inputTokens,40);
  assert.equal(claudeArgs[claudeArgs.indexOf('--permission-mode')+1],'acceptEdits');assert.equal(seen[2].options.cwd,'/work');
  const allowed=claudeArgs[claudeArgs.indexOf('--allowedTools')+1].split(',');assert.ok(!allowed.includes('Bash'));assert.ok(allowed.includes('Bash(node:*)'));assert.ok(!allowed.some(t=>/install|curl|rm/.test(t)));
  for(const flag of ['--dangerously-skip-permissions','--allow-dangerously-skip-permissions','--no-session-persistence'])assert.ok(!claudeArgs.includes(flag));
  await callTeamAgent('claude',{system:'s',user:'u'},{cwd:'/work',env,runner,outputSchema:turnSchema,session:'c-1'});assert.equal(seen[3].args[seen[3].args.indexOf('--resume')+1],'c-1');
});

test('팀 차례 파서는 재연결 경고 뒤 완료를 성공으로, 실패한 차례는 원인 분류와 함께 거절함',()=>{
  const ok=parseTeamTurn('gpt',['{"type":"error","message":"Reconnecting... 1/5"}','{"type":"item.completed","item":{"type":"agent_message","text":"{\\"message\\":\\"m\\",\\"status\\":\\"weird\\",\\"next\\":\\"\\",\\"question\\":\\"\\"}"}}','{"type":"turn.completed","usage":{}}'].join('\n'));
  assert.equal(ok.report.status,'continue');
  assert.throws(()=>parseTeamTurn('gpt',['{"type":"error","message":"Reconnecting... 5/5 (workspace routing discovery failed)"}','{"type":"turn.failed","error":{"message":"workspace routing discovery failed"}}'].join('\n')),/네트워크/);
  assert.throws(()=>parseTeamTurn('claude',JSON.stringify({is_error:true,subtype:'error_during_execution'})),/완료하지 못했습니다/);
  assert.equal(parseTeamTurn('claude',JSON.stringify({subtype:'error_max_turns',is_error:true,result:'중간 결과'})).report.message,'중간 결과');
});

test('HTTP 팀 모드는 프로젝트 회의실에서만 실행하고 대화 기록을 덮어쓰지 않고 이어 붙임',async()=>fixture(async home=>{
  const platform=await project(home,'platform'),second=await project(home,'two');const registryFile=path.join(home,'registry.json');
  const registry=createRoomRegistry({file:registryFile,home,defaultRoom:{id:'platform',root:platform}});const room=await registry.register({name:'팀 방',root:second,repo:'https://github.com/test-owner/two'});
  let calls=0;const server=createServer({env:{},projectRoot:platform,artifactDir:path.join(platform,'artifacts'),deliverableDir:path.join(platform,'deliverables'),roomRegistryFile:registryFile,roomHome:home,status:async()=>[{id:'gpt',ready:true},{id:'claude',ready:true}],
    invokeTeam:async(id,prompt,options)=>{calls++;assert.ok(options.cwd.startsWith(second));return turn(`${id} 작업`,'done');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const post=(roomId,body)=>fetch(base+'/api/meeting',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...request('팀으로 만들어줘'),roomId,...body})});
  try{
    const rejected=await post('platform');assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/프로젝트 회의실/);assert.equal(calls,0);
    for(const text of ['첫 요청','두 번째 요청']){const response=await post(room.id,{history:[{speaker:'사용자',text}]});assert.equal(response.status,200);const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(events.find(e=>e.final).status,'complete');}
    const messages=(await (await fetch(base+`/api/session?roomId=${room.id}`)).json()).messages;
    assert.deepEqual(messages.filter(m=>m.speaker==='사용자').map(m=>m.text),['첫 요청','두 번째 요청']);assert.equal(calls,4);
  }finally{await new Promise(r=>server.close(r));}
}));

test('Windows Codex 팀 실행은 앱이 설정한 샌드박스 방식만 개인 설정에서 가져옴',async()=>fixture(async dir=>{
  const {codexWindowsSandbox}=await import('../local-agents.mjs');
  await writeFile(path.join(dir,'config.toml'),'model = "x"\n[mcp_servers.a]\ncommand = "evil"\n[windows]\r\nsandbox = "elevated"\r\n[other]\nsandbox = "none"\n');
  assert.equal(await codexWindowsSandbox({CODEX_HOME:dir}),'elevated');
  assert.equal(await codexWindowsSandbox({CODEX_HOME:path.join(dir,'missing')}),null);
  await writeFile(path.join(dir,'config.toml'),'[windows]\nsandbox = "elevated\\" --evil"\n');assert.equal(await codexWindowsSandbox({CODEX_HOME:dir}),null);
  await writeFile(path.join(dir,'config.toml'),'[windows]\nsandbox = "elevated"\n');
  const seen=[];const runner=async(c,args)=>{seen.push(args);return {code:0,stdout:'{"type":"turn.completed","usage":{}}'};};
  for(const platform of ['win32','darwin'])await callTeamAgent('gpt',{system:'s',user:'u'},{cwd:dir,env:{CODEX_HOME:dir,LOCAL_CODEX_BIN:'codex'},runner,outputSchema:turnSchema,platform});
  assert.ok(seen[0].includes('windows.sandbox="elevated"'));assert.ok(!seen[1].some(a=>a.startsWith('windows.')));assert.ok(!seen[0].includes('evil'));
}));
