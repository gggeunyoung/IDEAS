import {readFile,lstat,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import path from 'node:path';
import {git,repositoryUrl,atomicJson} from './room-registry.mjs';
import {containsSensitive} from './project-context.mjs';

const privatePath=/(^|\/)(?:\.env(?:\.|$)|\.ideas(?:\/|$)|\.runtime(?:\/|$)|\.git(?:\/|$)|node_modules(?:\/|$)|\.(?:npmrc|pypirc|netrc|gitconfig)$|\.(?:ssh|aws|codex|claude|gemini)(?:\/|$)|client_secret_|credentials?(?:[./_-]|$)|secrets?(?:[./_-]|$)|password(?:[./_-]|$)|oauth.*\.json$|auth\.json$)|\.(?:pem|key|p12|pfx)$/i;
const sensitiveContent=text=>containsSensitive(text)||/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|GOCSPX-[A-Za-z0-9_-]{16,})/.test(text)||/["'](?:api[_-]?key|access[_-]?token|client[_-]?secret|password|_authToken)["']\s*[:=]\s*["'](?!process\.|os\.|\$)[A-Za-z0-9_+/.=-]{12,}["']/i.test(text);
function checkPath(relative){if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..')||privatePath.test(relative))throw new Error('비밀정보 또는 비공개 상태 경로가 포함됐습니다.');}
function checkText(data){if(data.length>1_000_000)throw new Error('파일 크기가 자동 저장 한도를 넘었습니다.');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw new Error('일반 텍스트 파일이 아닙니다.');}if(text.includes('\0')||sensitiveContent(text))throw new Error('비밀정보 또는 바이너리 내용이 포함됐습니다.');}
export async function checkWorkingFile(root,relative){
  checkPath(relative);let current=root;
  for(const part of relative.split('/')){current=path.join(current,part);let stat;try{stat=await lstat(current);}catch(error){if(error.code==='ENOENT')return;throw error;}if(stat.isSymbolicLink())throw new Error('심볼릭 링크는 자동 저장하지 않습니다.');}
  const stat=await lstat(current);if(!stat.isFile())throw new Error('일반 파일이 아닙니다.');checkText(await readFile(current));
}
export async function commitTeamChanges(root,{message='Save team checkpoint',author}={}){
  if(await git(root,['diff','--cached','--name-only']))throw new Error('이미 스테이징한 변경이 있어 자동 커밋을 멈췄습니다.');
  const files=(await git(root,['ls-files','--modified','--deleted','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  const safe=[],blocked=[];
  for(const relative of new Set(files)){try{await checkWorkingFile(root,relative);safe.push(relative);}catch{blocked.push(relative);}}
  if(safe.length){
    await git(root,['add','-A','--',...safe]);
    if(await git(root,['diff','--cached','--name-only']))await git(root,['-c','user.name=IDEAS 팀','-c','user.email=team@ideas.invalid','commit','-q',...(author?['--author',author]:[]),'-m',sensitiveContent(message)?'Save team checkpoint':message]);
  }
  return {commit:await git(root,['rev-parse','HEAD']),blocked,files:safe.length};
}
// Audit every outgoing revision, including secrets that were later deleted. A
// successful push is checked against the server ref; no force or automatic merge.
export async function pushSafeBranch(root,{gitImpl=git}={}){
  const run=args=>gitImpl(root,args),branch=await run(['branch','--show-current']);
  if(!branch)throw new Error('브랜치 없는 상태에서는 푸시하지 않습니다.');
  const origin=repositoryUrl(await run(['remote','get-url','origin'])).url;
  if(repositoryUrl(await run(['remote','get-url','--push','origin'])).url!==origin)throw new Error('origin의 읽기·쓰기 주소가 달라 자동 푸시를 멈췄습니다.');
  const refs=(await run(['ls-remote','--heads','origin'])).split('\n').filter(Boolean).map(line=>line.split(/\s+/));
  const head=await run(['rev-parse','HEAD']),remote=refs.find(([,ref])=>ref===`refs/heads/${branch}`)?.[0];
  if(remote===head)return {branch,commit:head.slice(0,7),pushed:true,url:origin.replace(/\.git$/,'')+'/tree/'+encodeURIComponent(branch)};
  if(remote){try{await run(['merge-base','--is-ancestor',remote,head]);}catch{throw new Error('원격 브랜치에 다른 변경이 있어 자동 푸시를 멈췄습니다. 로컬 커밋은 보존했습니다.');}}
  const known=[];for(const [sha] of refs){if(!/^[a-f0-9]{40,64}$/.test(sha))continue;try{await run(['cat-file','-e',sha+'^{commit}']);known.push(sha);}catch{}}
  const commits=(await run(['rev-list',head,...(known.length?['--not',...known]:[])])).split('\n').filter(Boolean);
  if(commits.length>300)throw new Error('자동 푸시의 미전송 커밋이 너무 많아 검토가 필요합니다.');
  const checked=new Set();
  for(const sha of commits){
    if(sensitiveContent(await run(['show','-s','--format=%B',sha])))throw new Error('미전송 커밋 메시지에 비밀정보가 포함됐습니다.');
    const changed=(await run(['diff-tree','-m','--root','--no-commit-id','-r','--name-only','-z',sha])).split('\0').filter(Boolean);
    for(const relative of changed){
      checkPath(relative);
      const entry=await run(['ls-tree','-z',sha,'--',relative]);if(!entry)continue;
      const meta=/^(\d+) (\w+) ([a-f0-9]+)\t/.exec(entry);
      if(!meta||meta[1]!=='100644'&&meta[1]!=='100755'||meta[2]!=='blob')throw new Error('심볼릭 링크나 하위 저장소는 자동 푸시하지 않습니다.');
      if(checked.has(meta[3]))continue;checked.add(meta[3]);
      const size=Number(await run(['cat-file','-s',meta[3]]));if(!Number.isFinite(size)||size>1_000_000)throw new Error('자동 푸시 파일 크기 한도를 넘었습니다.');
      const blob=await exec('git',['-c','core.hooksPath=/dev/null','-C',root,'cat-file','blob',meta[3]],{encoding:'buffer',timeout:120000,maxBuffer:1_100_000});checkText(blob.stdout);
    }
  }
  try{await run(['push','origin',`HEAD:refs/heads/${branch}`]);}catch{throw new Error(`커밋 ${head.slice(0,7)}은 로컬에 보존했습니다. GitHub 푸시에 실패해 다음 저장 때 다시 시도합니다.`);}
  const verified=await run(['ls-remote','--heads','origin',`refs/heads/${branch}`]);
  if(verified.split(/\s+/)[0]!==head)throw new Error('원격 커밋 확인이 일치하지 않습니다. 로컬 커밋은 보존했습니다.');
  return {branch,commit:head.slice(0,7),pushed:true,url:origin.replace(/\.git$/,'')+'/tree/'+encodeURIComponent(branch)};
}
export async function saveExistingTeam(root,{syncBranch=pushSafeBranch}={}){
  const file=path.join(root,'.ideas','team','state.json');let state;
  try{state=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('팀 저장 상태를 읽지 못했습니다.');}
  if(!/^[a-f0-9-]{36}$/.test(state.id||''))throw new Error('팀 저장 경로를 확인하세요.');
  const expected=path.join(await realpath(root),'.ideas','team',state.id.slice(0,8),'workspace');
  if(state.workspace!==expected||await realpath(state.workspace)!==expected||state.branch!==`ideas/team-${state.id.slice(0,8)}`||await git(expected,['branch','--show-current'])!==state.branch)throw new Error('팀 브랜치와 작업 폴더가 일치하지 않습니다.');
  const saved=await commitTeamChanges(expected,{message:'Save team checkpoint including unfinished work'});
  try{const result=await syncBranch(expected);state.gitSync={status:'pushed',...result,checkedAt:new Date().toISOString()};await atomicJson(file,state);return {...result,blocked:saved.blocked.length};}
  catch(error){state.gitSync={status:'failed',branch:state.branch,text:error.message};await atomicJson(file,state);throw error;}
}
