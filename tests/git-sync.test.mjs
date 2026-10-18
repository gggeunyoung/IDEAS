import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {git} from '../room-registry.mjs';
import {commitTeamChanges,pushSafeBranch} from '../git-sync.mjs';
import {saveRoomGit} from '../room-git.mjs';
import {runTeamWorkflow} from '../team-workflow.mjs';

async function fixture(fn){const dir=await realpath(await mkdtemp(path.join(tmpdir(),'ideas-git-sync-')));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function setup(dir){
  const root=path.join(dir,'project'),remote=path.join(dir,'origin.git');await mkdir(root);
  await git(root,['init','-q','-b','main']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.invalid']);
  await writeFile(path.join(root,'README.md'),'# Test\n');await git(root,['add','.']);await git(root,['commit','-qm','init']);
  await git(root,['init','--bare','-q',remote]);await git(root,['remote','add','origin',remote]);
  await git(root,['push','-q','origin','main']);await git(remote,['symbolic-ref','HEAD','refs/heads/main']);
  // Only the URL identity check is substituted for a local bare-remote transport;
  // refs, history, content, push and remote verification all use real Git.
  const transport=async(cwd,args)=>args[0]==='remote'&&args[1]==='get-url'?'https://github.com/test-owner/project.git':git(cwd,args);
  return {root,remote,sync:cwd=>pushSafeBranch(cwd,{gitImpl:transport})};
}
test('실제 원격에 팀 커밋을 일반 푸시하고 원격 커밋까지 확인한다',async()=>fixture(async dir=>{
  const {root,remote,sync}=await setup(dir);await git(root,['switch','-qc','ideas/team-12345678']);
  await writeFile(path.join(root,'app.mjs'),'export const answer=42;\n');const saved=await commitTeamChanges(root);
  const result=await sync(root);assert.equal(result.pushed,true);assert.equal(result.commit,saved.commit.slice(0,7));
  assert.equal(await git(remote,['rev-parse','refs/heads/ideas/team-12345678']),saved.commit);
  assert.equal((await sync(root)).commit,result.commit);
}));
test('HEAD에서 삭제됐어도 미전송 과거 커밋의 비밀정보는 푸시를 막는다',async()=>fixture(async dir=>{
  const {root,remote,sync}=await setup(dir),before=await git(remote,['rev-parse','main']);
  await writeFile(path.join(root,'bad.txt'),'sk-'+'A'.repeat(24));await git(root,['add','bad.txt']);await git(root,['commit','-qm','unsafe']);
  await git(root,['rm','-q','bad.txt']);await git(root,['commit','-qm','remove']);
  await assert.rejects(sync(root),/비밀정보/);assert.equal(await git(remote,['rev-parse','main']),before);
}));
test('팀 체크포인트는 비밀 파일·내용·링크를 제외하고 사용자 스테이징은 보존한다',async()=>fixture(async dir=>{
  const {root}=await setup(dir);await writeFile(path.join(root,'.env'),'VALUE=x');await writeFile(path.join(root,'bad.md'),'sk-'+'B'.repeat(24));
  await writeFile(path.join(root,'safe.md'),'safe');await writeFile(path.join(root,'settings.json'),JSON.stringify({client_secret:'fake'+'A'.repeat(30)}));
  if(process.platform!=='win32')await symlink(path.join(root,'README.md'),path.join(root,'linked.md'));
  const result=await commitTeamChanges(root);assert.ok(result.blocked.includes('.env'));assert.ok(result.blocked.includes('bad.md'));assert.ok(result.blocked.includes('settings.json'));
  assert.equal(await git(root,['ls-files']),'README.md\nsafe.md');
  await writeFile(path.join(root,'manual.md'),'manual');await git(root,['add','manual.md']);await assert.rejects(commitTeamChanges(root),/스테이징/);
  assert.equal(await git(root,['diff','--cached','--name-only']),'manual.md');
}));
test('원격에 다른 변경이 있으면 강제 푸시·자동 병합 없이 로컬 작업을 보존한다',async()=>fixture(async dir=>{
  const {root,remote,sync}=await setup(dir),other=path.join(dir,'other');await git(root,['clone','-q',remote,other]);
  await git(other,['config','user.name','Other']);await git(other,['config','user.email','other@example.invalid']);
  await writeFile(path.join(other,'other.md'),'other');await git(other,['add','.']);await git(other,['commit','-qm','other']);await git(other,['push','-q','origin','main']);
  const expected=await git(remote,['rev-parse','main']);await writeFile(path.join(root,'ours.md'),'ours');const local=await commitTeamChanges(root);
  await assert.rejects(sync(root),/다른 변경/);assert.equal(await git(remote,['rev-parse','main']),expected);assert.equal(await git(root,['rev-parse','HEAD']),local.commit);
}));
test('실패한 AI 차례의 파일도 최종 체크포인트로 실제 원격에 보존한다',async()=>fixture(async dir=>{
  const {root,remote,sync}=await setup(dir),events=[];
  await runTeamWorkflow({mode:'subscription',workflow:'team',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'파일 작업'}],budget:{minutes:10,maxTurns:3}},e=>events.push(e),{projectRoot:root,syncBranch:sync,invokeTeam:async(id,p,o)=>{await writeFile(path.join(o.cwd,'partial.md'),'미완료 작업');throw new Error('시험용 중단');}});
  const state=JSON.parse(await readFile(path.join(root,'.ideas/team/state.json'),'utf8'));
  assert.equal(events.find(e=>e.final).status,'failed');assert.ok(events.some(e=>e.type==='git'&&e.status==='pushed'));
  assert.equal(await git(remote,['show',state.branch+':partial.md']),'미완료 작업');assert.equal(await git(root,['status','--porcelain']),'');
}));
test('차례별 푸시 실패는 표시하고 종료 시 다시 푸시해 원격에서 확인한다',async()=>fixture(async dir=>{
  const {root,remote,sync}=await setup(dir),events=[];let attempts=0;
  await runTeamWorkflow({mode:'subscription',workflow:'team',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'작은 결과'}],budget:{minutes:10,maxTurns:2}},e=>events.push(e),{projectRoot:root,syncBranch:async cwd=>{attempts++;if(attempts<3)throw new Error('시험용 연결 실패');return sync(cwd);},invokeTeam:async(id,p,o)=>{await writeFile(path.join(o.cwd,'answer.md'),'결과');return {session:'test',report:{message:'직접 확인',status:'done',next:'',question:''},usage:{},actions:{},model:'test'};}});
  assert.equal(attempts,3);assert.equal(events.filter(e=>e.type==='git'&&e.status==='failed').length,2);assert.equal(events.find(e=>e.final).status,'complete');
  const state=JSON.parse(await readFile(path.join(root,'.ideas/team/state.json'),'utf8'));assert.equal(state.gitSync.status,'pushed');assert.equal(await git(remote,['show',state.branch+':answer.md']),'결과');
}));
test('회의 자동 저장은 이번 회의 생성 경로만 커밋하고 기존 변경을 섞지 않는다',async()=>fixture(async dir=>{
  const {root}=await setup(dir);await git(root,['remote','set-url','origin','https://github.com/test-owner/project.git']);
  await mkdir(path.join(root,'conversations'));await writeFile(path.join(root,'conversations/new.md'),'new');await writeFile(path.join(root,'conversations/old.md'),'old');await writeFile(path.join(root,'README.md'),'user change');
  await saveRoomGit(root,{paths:['conversations/new.md'],syncBranch:async()=>({pushed:true,commit:'test'})});
  assert.equal(await git(root,['show','HEAD:conversations/new.md']),'new');assert.equal(await git(root,['show','HEAD:README.md']),'# Test');
  assert.match(await git(root,['status','--porcelain']),/old.md/);assert.match(await git(root,['status','--porcelain']),/README.md/);
  await assert.rejects(saveRoomGit(root,{paths:['outputs/../README.md']}),/범위/);
}));
