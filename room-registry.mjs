import {readFile,writeFile,mkdir,lstat,realpath,rename,access} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const exec=promisify(execFile);
const github=/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/;
export function repositoryUrl(value){const match=github.exec(value||'');if(!match||match[2].length>100)throw new Error('GitHub 저장소의 HTTPS 주소를 입력하세요.');return {url:`https://github.com/${match[1]}/${match[2]}.git`,folder:match[2]};}
export function repositoryName(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)||/\.git$/i.test(value))throw new Error('저장소 이름은 영문·숫자와 - _ . 로 100자 이내로 정하세요.');return value;}
// Services and app shells often miss the user's PATH, so the GitHub CLI is also looked up at its install paths.
export async function ghExecutable(env=process.env,platform=process.platform){
  if(env.IDEAS_GH_BIN)return env.IDEAS_GH_BIN;
  const candidates=platform==='win32'?[path.join(env.PROGRAMFILES||env.ProgramFiles||'C:\Program Files','GitHub CLI','gh.exe'),env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Programs','GitHub CLI','gh.exe')]:['/opt/homebrew/bin/gh','/usr/local/bin/gh','/usr/bin/gh'];
  for(const file of candidates.filter(Boolean)){try{await access(file);return file;}catch{}}
  return 'gh';
}
const exists='같은 이름의 저장소가 이미 내 GitHub에 있습니다. 다른 이름을 쓰거나 기존 저장소 연결을 고르세요.';
const notLoggedIn=/auth login|not logged|authenticat/i;
// The credential git already uses for clone/push on this computer. Helpers answer without prompting or fail.
export function gitCredentialToken(env=process.env){
  return new Promise(resolve=>{
    let out='',child;
    try{child=spawn('git',['credential','fill'],{env:{...env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'},stdio:['pipe','pipe','ignore'],windowsHide:true});}catch{return resolve(null);}
    const timer=setTimeout(()=>{child.kill();resolve(null);},15000);
    child.stdout.on('data',chunk=>{out+=chunk;});child.on('error',()=>{clearTimeout(timer);resolve(null);});
    child.on('close',code=>{clearTimeout(timer);resolve(code===0?/^password=(.+)$/m.exec(out)?.[1].trim()||null:null);});
    child.stdin.on('error',()=>{});child.stdin.end('protocol=https\nhost=github.com\n\n');
  });
}
const githubApi=(fetchImpl,route,token,options={})=>fetchImpl('https://api.github.com'+route,{...options,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'IDEAS-rooms',Authorization:'Bearer '+token,...options.headers},signal:AbortSignal.timeout(30000)});
// Creates a private repository with a README in the user's own account: GitHub CLI first, otherwise the existing git login.
export async function createGithubRepo(repoName,description,env=process.env,{token=gitCredentialToken,fetchImpl=fetch}={}){
  let stdout;
  try{({stdout}=await exec(await ghExecutable(env),['repo','create',repoName,'--private','--add-readme','--description',description],{timeout:60000,maxBuffer:1000000,env:{...env,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'}}));}
  catch(error){
    const text=String(error.stderr||'');
    if(/already exists/i.test(text))throw new Error(exists);
    if(error.code!=='ENOENT'&&!notLoggedIn.test(text))throw new Error('GitHub 저장소를 만들지 못했습니다. 네트워크와 GitHub 로그인 상태를 확인하세요.');
    const secret=await token(env);
    if(!secret)throw new Error('이 컴퓨터에서 GitHub 로그인을 찾지 못했습니다. gh auth login을 하거나 git으로 GitHub에 한 번 로그인하세요.');
    const response=await githubApi(fetchImpl,'/user/repos',secret,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:repoName,description,private:true,auto_init:true})});
    if(response.status===422)throw new Error(exists);
    if(!response.ok)throw new Error(response.status===401?'이 컴퓨터의 GitHub 로그인이 만료됐습니다. 다시 로그인하세요.':'이 컴퓨터의 GitHub 로그인에는 저장소를 만들 권한이 없습니다. gh auth login으로 로그인하세요.');
    const url=(await response.json()).html_url;if(typeof url!=='string')throw new Error('GitHub가 새 저장소 주소를 돌려주지 않았습니다. 내 GitHub에서 생성 여부를 확인하세요.');
    return url;
  }
  const url=/https:\/\/github\.com\/\S+/.exec(stdout)?.[0];if(!url)throw new Error('GitHub가 새 저장소 주소를 돌려주지 않았습니다. 내 GitHub에서 생성 여부를 확인하세요.');
  return url;
}
// Shows which account a new project will be created under before anything is created.
export async function githubAccount(env=process.env,{token=gitCredentialToken,fetchImpl=fetch}={}){
  try{
    const {stdout}=await exec(await ghExecutable(env),['api','user','--jq','.login'],{timeout:20000,maxBuffer:100000,env:{...env,GH_PROMPT_DISABLED:'1'}});
    const account=stdout.trim();if(!/^[A-Za-z0-9-]{1,39}$/.test(account))throw new Error();return {ready:true,account,via:'gh'};
  }catch(error){
    if(error.code!=='ENOENT'&&!notLoggedIn.test(String(error.stderr||'')))return {ready:false,error:'GitHub 계정을 확인하지 못했습니다. 네트워크와 GitHub 로그인 상태를 확인하세요.'};
  }
  const secret=await token(env);
  if(!secret)return {ready:false,error:'이 컴퓨터에서 GitHub 로그인을 찾지 못했습니다. gh auth login을 하거나 git으로 GitHub에 한 번 로그인하세요.'};
  try{
    const response=await githubApi(fetchImpl,'/user',secret);
    if(!response.ok)return {ready:false,error:'이 컴퓨터의 GitHub 로그인이 만료됐거나 확인되지 않습니다. 다시 로그인하세요.'};
    const scopes=response.headers.get('x-oauth-scopes');
    // Classic tokens list their scopes; fine-grained tokens do not, so their permission is learned on creation.
    if(scopes!=null&&!/(^|,\s*)repo(\s*,|$)/.test(scopes))return {ready:false,error:'이 컴퓨터의 GitHub 로그인에는 저장소를 만들 권한이 없습니다. gh auth login으로 로그인하세요.'};
    const account=(await response.json()).login;if(typeof account!=='string')throw new Error();return {ready:true,account,via:'git'};
  }catch{return {ready:false,error:'GitHub 계정을 확인하지 못했습니다. 네트워크를 확인하세요.'};}
}
const cloneGithubRepo=async(url,root)=>exec('git',['-c','core.hooksPath=/dev/null','clone','--',url,root],{timeout:120000,maxBuffer:1000000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
export async function git(root,args){try{return (await exec('git',['-c','core.hooksPath=/dev/null','-C',root,...args],{timeout:120000,maxBuffer:1000000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}catch{throw new Error('Git 작업에 실패했습니다. 저장소·계정 권한·네트워크를 확인하세요.');}}
export async function gitState(root){try{return {branch:await git(root,['branch','--show-current']),changes:(await git(root,['status','--porcelain'])).split('\n').filter(Boolean).length,commit:await git(root,['rev-parse','--short','HEAD'])};}catch{return {branch:null,changes:null,commit:null};}}
export async function atomicJson(file,data){try{if((await lstat(path.dirname(file))).isSymbolicLink())throw new Error('데이터 폴더가 심볼릭 링크입니다.');}catch(e){if(e.code!=='ENOENT')throw e;}await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(data,null,2),{mode:0o600});await rename(temp,file);}
export function createRoomRegistry({file,defaultRoom,home=homedir(),createRepo=createGithubRepo,cloneRepo=cloneGithubRepo}){
  let locked=false;
  const all=async()=>{let rooms=[];try{rooms=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('회의실 목록을 읽지 못했습니다.');}return [defaultRoom,...rooms.filter(r=>r.id!==defaultRoom.id)];};
  const resolve=async id=>{const room=(await all()).find(r=>r.id===(id||defaultRoom.id));if(!room)throw new Error('등록되지 않은 회의실입니다.');return {...room,root:await realpath(room.root)};};
  const register=async({name,root,repo})=>{
    if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('회의실 이름은 1~80자입니다.');
    const canonical=repositoryUrl(repo).url;const resolved=await realpath(root),base=await realpath(home);
    if(!resolved.startsWith(base+path.sep)||resolved!==path.resolve(root)||(await lstat(root)).isSymbolicLink())throw new Error('사용자 홈 안의 실제 프로젝트 폴더를 연결하세요.');
    // Git for Windows prints C:/... while realpath returns C:\...; compare canonical paths.
    if(await realpath(await git(resolved,['rev-parse','--show-toplevel']))!==resolved)throw new Error('저장소 루트 폴더를 연결하세요.');
    if(repositoryUrl(await git(resolved,['remote','get-url','origin'])).url!==canonical)throw new Error('폴더와 저장소의 origin이 다릅니다.');
    const rooms=await all();const existing=rooms.find(r=>r.root===resolved);if(existing)return existing;
    const room={id:createHash('sha256').update(resolved).digest('hex').slice(0,16),name:name.trim(),root:resolved,repo:canonical.replace(/\.git$/,''),kind:'project',createdAt:new Date().toISOString()};
    await atomicJson(file,[...rooms.filter(r=>r.id!==defaultRoom.id),room]);return room;
  };
  const roomName=name=>{if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('회의실 이름은 1~80자입니다.');};
  const registry={all,resolve,register,
    async clone({name,repo}){
      if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('회의실 이름은 1~80자입니다.');
      if(locked)throw new Error('다른 회의실을 연결 중입니다.');locked=true;
      try{
        const parsed=repositoryUrl(repo),root=path.join(home,parsed.folder);let exists=false;
        try{await lstat(root);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
        if(!exists){try{await cloneRepo(parsed.url,root);}catch{throw new Error('클론에 실패했습니다. 저장소 접근 권한을 확인하세요. 기존 폴더는 덮어쓰지 않습니다.');}}
        return await register({name,root,repo:parsed.url});
      }finally{locked=false;}
    },
    // New project: a private GitHub repository in the user's own account, cloned under home and registered.
    async create({name,repoName}){
      roomName(name);const repo=repositoryName(repoName);
      if(locked)throw new Error('다른 회의실을 연결 중입니다.');locked=true;let url;
      try{
        const root=path.join(home,repo);let exists=true;try{await lstat(root);}catch(e){if(e.code!=='ENOENT')throw e;exists=false;}
        if(exists)throw new Error(`이 컴퓨터에 ${root} 폴더가 이미 있습니다. 다른 저장소 이름을 쓰세요.`);
        url=await createRepo(repo,`IDEAS 회의실 · ${name.trim()}`);
      }finally{locked=false;}
      return registry.clone({name,repo:url});
    }
  };
  return registry;
}
export async function loadSession(root){try{const data=JSON.parse(await readFile(path.join(root,'.ideas','session.json'),'utf8'));return Array.isArray(data.messages)?data.messages:[];}catch(e){if(e.code==='ENOENT')return [];throw new Error('저장된 대화를 읽지 못했습니다.');}}
export async function saveSession(root,messages){await atomicJson(path.join(root,'.ideas','session.json'),{messages,updatedAt:new Date().toISOString()});}
