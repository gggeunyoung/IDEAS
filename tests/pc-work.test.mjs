import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {preparePcWork,pcSnapshot,pcChanges} from '../pc-work.mjs';
import {callTeamAgent} from '../local-agents.mjs';import {turnSchema} from '../team-workflow.mjs';import {validateRequest} from '../room.mjs';

test('PC 작업은 자율 협업에서만 요청할 수 있고 임의 경로를 요청으로 받지 않음',()=>{
 const req={mode:'subscription',workflow:'team',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'구현'}],execution:'pc'};
 assert.equal(validateRequest(req).execution,'pc');
 assert.throws(()=>validateRequest({...req,execution:'full-access'}));
 assert.throws(()=>validateRequest({...req,workflow:'discuss'}));
});
test('공유 작업 폴더 준비와 변경 감지는 심볼릭 링크를 따르지 않음',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'ideas-pc-test-'));
 try{
  const dir=await preparePcWork(root,'darwin');const before=await pcSnapshot(dir);
  await writeFile(path.join(dir,'result.txt'),'done');await symlink(root,path.join(dir,'link'));
  assert.deepEqual(pcChanges(before,await pcSnapshot(dir)),['result.txt']);
  await assert.rejects(preparePcWork(root,'win32'),/macOS/);
  await rm(dir,{recursive:true});await mkdir(path.join(root,'elsewhere'));await symlink(path.join(root,'elsewhere'),dir);
  await assert.rejects(preparePcWork(root,'darwin'),/심볼릭/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('PC 실행은 Codex OS 경계와 Claude restricted+강제 sandbox를 유지하고 네트워크를 허용함',async()=>{
 const calls=[];const runner=async(command,args)=>{calls.push(args);return {code:0,stdout:args.includes('exec')?JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({message:'done',status:'done'})}})+'\n'+JSON.stringify({type:'turn.completed',usage:{}}):JSON.stringify({structured_output:{message:'done',status:'done'}})};};
 const options={cwd:'/project',pcDirectory:'/shared',platform:'darwin',runner,outputSchema:turnSchema,env:{LOCAL_CODEX_BIN:'codex',LOCAL_CLAUDE_BIN:'claude'}};
 await callTeamAgent('gpt',{system:'s',user:'u'},options);await callTeamAgent('claude',{system:'s',user:'u'},options);
 assert.ok(calls[0].includes('sandbox_workspace_write.network_access=true'));
 for(const args of calls){assert.equal(args[args.indexOf('--add-dir')+1],'/shared');assert.ok(!args.some(arg=>arg.includes('dangerously')));}
 assert.ok(calls[1].includes('--restricted'));const settings=JSON.parse(calls[1][calls[1].indexOf('--settings')+1]);
 assert.equal(settings.sandbox.enabled,true);assert.equal(settings.sandbox.failIfUnavailable,true);assert.equal(settings.sandbox.allowUnsandboxedCommands,false);
 assert.equal(calls[1][calls[1].indexOf('--allowedTools')+1].split(',').includes('Bash'),false);
 await assert.rejects(callTeamAgent('claude',{system:'s',user:'u'},{...options,platform:'win32'}),/macOS/);
});

test('PC 작업 폴더의 실제 변경도 진전으로 계산하고 범위 전환 시 CLI 세션을 재사용하지 않음',{skip:process.platform!=='darwin'},async()=>{
 const {runTeamWorkflow}=await import('../team-workflow.mjs');const {git}=await import('../room-registry.mjs');
 const root=await mkdtemp(path.join(tmpdir(),'ideas-pc-team-'));const syncBranch=async()=>({status:'pushed',commit:'test'});
 try{
  await git(root,['init','-q','-b','main']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.invalid']);await writeFile(path.join(root,'README.md'),'test');await git(root,['add','.']);await git(root,['commit','-qm','init']);
  const base={mode:'subscription',workflow:'team',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'구현'}],budget:{minutes:10,maxTurns:4}};
  let calls=0;const events=[];
  const invokeTeam=async(id,p,options)=>{
    calls++;assert.equal(options.session,undefined);
    if(options.pcDirectory){assert.match(p.system,/일반 터미널/);await writeFile(path.join(options.pcDirectory,`step-${calls}.txt`),'progress');}
    return {session:id+'-session',report:{message:'진행',status:'continue'},usage:{},actions:{},model:'test'};
  };
  await runTeamWorkflow({...base,budget:{minutes:10,maxTurns:2}},()=>{}, {projectRoot:root,syncBranch,invokeTeam});
  calls=0;
  // First two calls after a change in scope must have fresh sessions; later calls resume.
  const switched=async(id,p,o)=>{if(calls<2)return invokeTeam(id,p,o);calls++;await writeFile(path.join(o.pcDirectory,`step-${calls}.txt`),'progress');return {session:o.session,report:{message:'진행',status:'continue'},usage:{},actions:{},model:'test'};};
  await runTeamWorkflow({...base,execution:'pc'},e=>events.push(e),{projectRoot:root,syncBranch,invokeTeam:switched});
  assert.equal(calls,4);assert.equal(events.find(e=>e.final).status,'budget_exhausted');assert.ok(events.some(e=>e.type==='notice'&&e.text.includes('Git 자동 저장 제외')));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('중단 후 부모 CLI가 먼저 종료해도 SIGTERM을 무시하는 하위 명령을 강제 종료함',{skip:process.platform==='win32'},async()=>{
 const {runProcess,subscriptionEnv}=await import('../local-agents.mjs');const controller=new AbortController();let pid;
 const childCode="process.on('SIGTERM',()=>{});console.log('ready:'+process.pid);setInterval(()=>{},1000)";
 const parentCode=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
 try{
  await assert.rejects(runProcess(process.execPath,['-e',parentCode],{env:subscriptionEnv(),signal:controller.signal,timeout:5000,onStdout:chunk=>{const match=/ready:(\d+)/.exec(chunk);if(match){pid=Number(match[1]);controller.abort();}}}),/중단/);
  await new Promise(resolve=>setTimeout(resolve,1800));assert.ok(pid);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}}
});
