import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {guideSections,projectGuideIssues} from '../collaboration-policy.mjs';
import {runTeamWorkflow,turnSchema} from '../team-workflow.mjs';
import {callTeamAgent} from '../local-agents.mjs';
import {git} from '../room-registry.mjs';
import {promptFor} from '../providers.mjs';

const fixture=async fn=>{const dir=await mkdtemp(path.join(tmpdir(),'ideas-policy-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const report=(message,status='continue')=>({session:'discarded-plan-session',report:{message,status,next:'',question:''},usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5},actions:{},model:'test'});
const request={mode:'subscription',workflow:'team',participants:['gpt','claude'],writer:'gpt',review:true,history:[{speaker:'사용자',text:'수집 도구 구현'}],budget:{minutes:10,maxTurns:4}};
async function project(root){await git(root,['init','-q','-b','main']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.invalid']);await writeFile(path.join(root,'README.md'),'# Test');await git(root,['add','.']);await git(root,['commit','-qm','init']);}

test('첫 두 접근법을 새 읽기 전용 세션에서 수집하고 서로의 계획을 구현 전에만 전달함',async()=>fixture(async root=>{
  await project(root);const calls=[],events=[];
  await runTeamWorkflow(request,e=>events.push(e),{projectRoot:root,syncBranch:async()=>({pushed:true}),invokeTeam:async(id,p,o)=>{
    calls.push({id,p,o});
    if(o.readOnly){assert.equal(o.session,undefined);assert.equal(o.pcDirectory,undefined);assert.ok(!p.user.includes('봉인된 계획'));assert.ok(!p.user.includes('실행기:'));return report(id+' 봉인된 계획');}
    assert.equal(o.session,undefined);assert.match(p.user,/gpt 봉인된 계획/);assert.match(p.user,/claude 봉인된 계획/);
    assert.match(p.system,/입력부터 출력/);assert.match(p.system,/문제·재현 근거·영향·수정 제안/);
    return report('구현 가능한 일을 계속합니다');
  }});
  assert.deepEqual(calls.map(c=>c.o.readOnly),[true,true,false,false]);
  assert.deepEqual(events.filter(e=>e.type==='answer').map(e=>e.phase),['team-plan','team-plan','team','team']);
  assert.equal(events.find(e=>e.final).status,'budget_exhausted');
  const state=JSON.parse(await readFile(path.join(root,'.ideas/team/state.json'),'utf8'));assert.equal(state.turns,4);assert.equal(state.usage.gpt.inputTokens,20);
}));

test('구현 완료 주장 둘만으로 이해 가이드 없이 완료하지 않음',async()=>fixture(async root=>{
  await project(root);const events=[];
  await runTeamWorkflow(request,e=>events.push(e),{projectRoot:root,syncBranch:async()=>({pushed:true}),invokeTeam:async(id,p,o)=>report(o.readOnly?'접근법':'구현 완료','done')});
  assert.equal(events.find(e=>e.final).status,'budget_exhausted');
  assert.ok(events.some(e=>e.type==='notice'&&e.text.includes('이해 가이드 보강 필요')));
}));

test('이해 가이드는 빈 제목이나 외부 링크로 대체할 수 없음',async()=>fixture(async root=>{
  assert.ok((await projectGuideIssues(root)).length);
  await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/PROJECT_GUIDE.md'),guideSections.map(s=>'## '+s).join('\n'));
  assert.equal((await projectGuideIssues(root)).length,7);
  await writeFile(path.join(root,'docs/PROJECT_GUIDE.md'),guideSections.map(s=>'## '+s+'\n현재 프로젝트에서 사용한 실제 구성과 검증한 내용을 연결하여 설명합니다.').join('\n'));
  assert.deepEqual(await projectGuideIssues(root),[]);
  const outside=path.join(root,'..',path.basename(root)+'-outside.md');
  try{await writeFile(outside,'outside');await rm(path.join(root,'docs/PROJECT_GUIDE.md'));await symlink(outside,path.join(root,'docs/PROJECT_GUIDE.md'));assert.ok((await projectGuideIssues(root)).length);}finally{await rm(outside,{force:true});}
}));

test('독립 접근법 CLI는 쓰기 권한과 기존 세션 재개를 열지 않고 Claude 셸 도구도 제거함',async()=>{
  for(const id of ['gpt','claude'])await callTeamAgent(id,{system:'지침',user:'목표'},{cwd:'/project',pcDirectory:'/extra',session:'old-write-session',readOnly:true,platform:'darwin',outputSchema:turnSchema,env:{LOCAL_CODEX_BIN:'codex',LOCAL_CLAUDE_BIN:'claude'},runner:async(c,args)=>{
    assert.ok(!args.includes('old-write-session'));assert.ok(!args.includes('--add-dir'));assert.ok(!args.includes('sandbox_workspace_write.network_access=true'));
    if(id==='gpt')assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
    else{assert.equal(args[args.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(args[args.indexOf('--allowedTools')+1],'Read,Glob,Grep');}
    return {code:0,stdout:id==='gpt'?JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(report('접근법').report)}})+'\n'+JSON.stringify({type:'turn.completed',usage:{}}):JSON.stringify({structured_output:report('접근법').report})};
  }});
});

test('토론·파일 협업에서 사용하는 공통 프롬프트에도 이해 원칙을 기본 전달함',()=>{
  for(const review of [null,[{speaker:'Claude',text:'의견'}]]){
    const p=promptFor('GPT',request.history,review);assert.match(p.system,/핵심 아키텍처/);assert.match(p.system,/직접 확인하는 방법/);assert.match(p.system,/사용자가 이해를 확인한 것은 다릅니다/);
  }
});
