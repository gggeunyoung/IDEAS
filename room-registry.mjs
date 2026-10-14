import {readFile,writeFile,mkdir,lstat,realpath,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const exec=promisify(execFile);
const github=/^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?\/?$/;
export function repositoryUrl(value){const match=github.exec(value||'');if(!match||match[2].length>100)throw new Error('GitHub 저장소의 HTTPS 주소를 입력하세요.');return {url:`https://github.com/${match[1]}/${match[2]}.git`,folder:match[2]};}
export async function git(root,args){try{return (await exec('git',['-c','core.hooksPath=/dev/null','-C',root,...args],{timeout:120000,maxBuffer:1000000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();}catch{throw new Error('Git 작업에 실패했습니다. 저장소·계정 권한·네트워크를 확인하세요.');}}
export async function gitState(root){try{return {branch:await git(root,['branch','--show-current']),changes:(await git(root,['status','--porcelain'])).split('\n').filter(Boolean).length,commit:await git(root,['rev-parse','--short','HEAD'])};}catch{return {branch:null,changes:null,commit:null};}}
export async function atomicJson(file,data){try{if((await lstat(path.dirname(file))).isSymbolicLink())throw new Error('데이터 폴더가 심볼릭 링크입니다.');}catch(e){if(e.code!=='ENOENT')throw e;}await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(data,null,2),{mode:0o600});await rename(temp,file);}
export function createRoomRegistry({file,defaultRoom,home=homedir()}){
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
  return {all,resolve,register,
    async clone({name,repo}){
      if(typeof name!=='string'||!name.trim()||name.length>80)throw new Error('회의실 이름은 1~80자입니다.');
      if(locked)throw new Error('다른 회의실을 연결 중입니다.');locked=true;
      try{
        const parsed=repositoryUrl(repo),root=path.join(home,parsed.folder);let exists=false;
        try{await lstat(root);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
        if(!exists){try{await exec('git',['-c','core.hooksPath=/dev/null','clone','--',parsed.url,root],{timeout:120000,maxBuffer:1000000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});}catch{throw new Error('클론에 실패했습니다. 저장소 접근 권한을 확인하세요. 기존 폴더는 덮어쓰지 않습니다.');}}
        return await register({name,root,repo:parsed.url});
      }finally{locked=false;}
    }
  };
}
export async function loadSession(root){try{const data=JSON.parse(await readFile(path.join(root,'.ideas','session.json'),'utf8'));return Array.isArray(data.messages)?data.messages:[];}catch(e){if(e.code==='ENOENT')return [];throw new Error('저장된 대화를 읽지 못했습니다.');}}
export async function saveSession(root,messages){await atomicJson(path.join(root,'.ideas','session.json'),{messages,updatedAt:new Date().toISOString()});}
