import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRoomRegistry,git,repositoryUrl,repositoryName,ghExecutable,githubAccount} from '../room-registry.mjs';
import {saveRoomGit} from '../room-git.mjs';
import {createServer} from '../server.mjs';
const fixture=async fn=>{const dir=await realpath(await mkdtemp(path.join(tmpdir(),'ideas-rooms-')));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
async function repo(dir,name){const root=path.join(dir,name);await mkdir(root);await git(root,['init']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.invalid']);await git(root,['remote','add','origin',`https://github.com/test-owner/${name}.git`]);await writeFile(path.join(root,'README.md'),name+'-ONLY');return root;}
test('등록은 사용자 홈의 저장소 루트와 일치하는 origin만 허용함',async()=>fixture(async home=>{
  const root=await repo(home,'one');const registry=createRoomRegistry({file:path.join(home,'registry.json'),home,defaultRoom:{id:'platform',root}});
  const other=await repo(home,'two');const room=await registry.register({name:'두 번째',root:other,repo:'https://github.com/test-owner/two'});
  assert.equal((await registry.resolve(room.id)).root,other);await assert.rejects(registry.resolve('../../other'));
  await assert.rejects(registry.register({name:'다름',root:other,repo:'https://github.com/test-owner/one'}),/origin/);
  await symlink(other,path.join(home,'linked'),'junction');await assert.rejects(registry.register({name:'링크',root:path.join(home,'linked'),repo:'https://github.com/test-owner/two'}));
  const nested=path.join(other,'nested');await mkdir(nested);await assert.rejects(registry.register({name:'중첩',root:nested,repo:'https://github.com/test-owner/two'}),/루트/);
  for(const url of ['https://evil.example/o/r','https://key@github.com/o/r','https://github.com/o/../r','file:///tmp/repo'])assert.throws(()=>repositoryUrl(url));
}));
test('방별 자료·대화·결과 다운로드는 다른 방과 분리됨',async()=>fixture(async home=>{
  const first=await repo(home,'one'),second=await repo(home,'two');const registryFile=path.join(home,'registry.json');const registry=createRoomRegistry({file:registryFile,home,defaultRoom:{id:'platform',root:first}});
  const room=await registry.register({name:'두 번째',root:second,repo:'https://github.com/test-owner/two'});
  const server=createServer({env:{},projectRoot:first,artifactDir:path.join(first,'artifacts'),deliverableDir:path.join(first,'deliverables'),roomRegistryFile:registryFile,roomHome:home,status:async()=>[{id:'gpt',ready:true}],invokeLocal:async(id,prompt)=>{assert.ok(prompt.user.includes('two-ONLY'));assert.ok(!prompt.user.includes('one-ONLY'));return {speaker:'GPT',provider:id,text:'two 결과'};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,scope=`?roomId=${room.id}`;
  try{
    const body={roomId:room.id,mode:'subscription',participants:['gpt'],review:false,files:['README.md'],history:[{speaker:'사용자',text:'자료 읽기'}]};
    const response=await fetch(base+'/api/meeting'+scope,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);
    const events=(await response.text()).trim().split('\n').map(JSON.parse);const artifact=events.find(e=>e.type==='artifact');assert.ok(artifact.url.includes(room.id));
    assert.match(await (await fetch(base+artifact.url)).text(),/two 결과/);
    assert.equal((await fetch(base+artifact.url.replace(room.id,'platform'))).status,404);
    assert.equal((await (await fetch(base+'/api/session'+scope)).json()).messages.at(-1).text,'two 결과');
    assert.deepEqual((await (await fetch(base+'/api/session')).json()).messages,[]);
    assert.equal((await fetch(base+'/api/files?roomId=not-registered')).status,404);
    assert.equal((await fetch(base+'/api/session'+scope,{method:'POST',headers:{Origin:'https://outside.invalid','Content-Type':'application/json'},body:'{"reset":true}'})).status,403);
  }finally{await new Promise(r=>server.close(r));}
}));
test('방 연결은 다른 저장소가 이미 있는 동명 폴더를 덮어쓰지 않음',async()=>fixture(async home=>{
  const root=await repo(home,'same');const registry=createRoomRegistry({file:path.join(home,'registry.json'),home,defaultRoom:{id:'platform',root}});
  await assert.rejects(registry.clone({name:'충돌',repo:'https://github.com/different-owner/same'}),/origin/);
  assert.equal(await readFile(path.join(root,'README.md'),'utf8'),'same-ONLY');
}));
test('프로젝트 Git 저장은 미리 스테이징한 변경과 비밀정보를 푸시 전에 거절함',async()=>fixture(async home=>{
  const root=await repo(home,'one');await git(root,['add','README.md']);await git(root,['commit','-m','init']);
  await writeFile(path.join(root,'unrelated.txt'),'사용자 변경');await git(root,['add','unrelated.txt']);await assert.rejects(saveRoomGit(root),/스테이징/);
  await git(root,['reset','HEAD','unrelated.txt']);await mkdir(path.join(root,'outputs'));await writeFile(path.join(root,'outputs','bad.md'),'-----BEGIN PRIVATE KEY-----');
  await assert.rejects(saveRoomGit(root),/비밀정보/);assert.equal(await git(root,['diff','--cached','--name-only']),'');
}));
test('새 프로젝트는 내 GitHub에 비공개 저장소를 만든 뒤 홈으로 받아 방으로 등록함',async()=>fixture(async home=>{
  for(const ok of ['after-death-care','a','My.Project_2'])assert.equal(repositoryName(ok),ok);
  for(const bad of ['','-x','.x','a b','한글','x.git','a/b','x'.repeat(101),undefined])assert.throws(()=>repositoryName(bad));
  const source=await repo(home,'source');await git(source,['add','.']);await git(source,['commit','-qm','init']);
  const created=[];const registry=createRoomRegistry({file:path.join(home,'registry.json'),home,defaultRoom:{id:'platform',root:source},
    createRepo:async(name,description)=>{created.push({name,description});return `https://github.com/test-owner/${name}`;},
    cloneRepo:async(url,root)=>{await git(home,['clone','-q',source,root]);await git(root,['remote','set-url','origin',url]);}});
  const room=await registry.create({name:'after death care',repoName:'after-death-care'});
  assert.deepEqual(created,[{name:'after-death-care',description:'IDEAS 회의실 · after death care'}]);
  assert.equal(room.kind,'project');assert.equal(room.root,path.join(home,'after-death-care'));assert.equal(room.repo,'https://github.com/test-owner/after-death-care');
  // An existing local folder stops the request before anything is created on GitHub.
  await assert.rejects(registry.create({name:'중복',repoName:'after-death-care'}),/이미 있습니다/);
  await assert.rejects(registry.create({name:'',repoName:'new-one'}));await assert.rejects(registry.create({name:'이름',repoName:'bad name'}));
  assert.equal(created.length,1);
}));
test('GitHub CLI는 명시 경로·설치 경로를 먼저 찾고 없으면 PATH의 gh를 씀',async()=>fixture(async dir=>{
  assert.equal(await ghExecutable({IDEAS_GH_BIN:'/custom/gh'}),'/custom/gh');
  const exe=path.join(dir,'GitHub CLI','gh.exe');await mkdir(path.dirname(exe),{recursive:true});await writeFile(exe,'');
  assert.equal(await ghExecutable({PROGRAMFILES:dir},'win32'),exe);assert.equal(await ghExecutable({PROGRAMFILES:path.join(dir,'none')},'win32'),'gh');
}));
test('새 프로젝트 폼은 만들기 전에 작업 컴퓨터의 GitHub 계정 상태를 확인함',async()=>fixture(async dir=>{
  const missing=await githubAccount({...process.env,IDEAS_GH_BIN:path.join(dir,'no-gh.exe')});assert.equal(missing.ready,false);assert.match(missing.error,/설치/);
  const server=createServer({env:{},projectRoot:dir,roomRegistryFile:path.join(dir,'r.json'),roomHome:dir,github:async()=>({ready:true,account:'test-owner'})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/api/github`)).json(),{ready:true,account:'test-owner'});}finally{await new Promise(r=>server.close(r));}
}));
