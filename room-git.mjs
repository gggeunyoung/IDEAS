import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {checkWorkingFile,pushSafeBranch,saveExistingTeam} from './git-sync.mjs';
import {git,repositoryUrl,atomicJson} from './room-registry.mjs';
export async function saveRoomGit(root,{paths,syncBranch=pushSafeBranch}={}){
  const syncFile=path.join(root,'.ideas','git-sync.json');
  try{
  const branch=await git(root,['branch','--show-current']);if(!branch)throw new Error('브랜치가 없는 작업 상태에서는 저장하지 않습니다.');
  repositoryUrl(await git(root,['remote','get-url','origin']));
  if(await git(root,['diff','--cached','--name-only']))throw new Error('이미 스테이징한 변경이 있습니다. 먼저 해당 변경을 정리하세요.');
  const roots=['README.md','AGENTS.md','CLAUDE.md','.gitignore','docs/HANDOFF.md','conversations','deliverables','outputs'];
  if(paths&&(!paths.length||paths.some(p=>typeof p!=='string'||p.split(/[\\/]/).includes('..')||!roots.some(r=>p===r||p.startsWith(r+'/')))))throw new Error('회의실이 생성한 저장 범위를 확인하세요.');
  const listed=await git(root,['ls-files','--modified','--deleted','--others','--exclude-standard','-z','--',...(paths||roots)]);
  const files=listed.split('\0').filter(Boolean);if(files.length>200)throw new Error('저장할 파일이 200개를 넘었습니다. 범위를 나눠 주세요.');
  for(const relative of files)await checkWorkingFile(root,relative);
  const team=paths?null:await saveExistingTeam(root,{syncBranch});
  if(files.length){await git(root,['add','--',...files]);await git(root,['commit','-m','Save room conversations and generated files']);}
  const result=await syncBranch(root);
  const backup={...result,branch,files:files.length,...(team?{team}:{})};
  await atomicJson(syncFile,{status:'pushed',...backup,checkedAt:new Date().toISOString()});return backup;
  }catch(error){try{await atomicJson(syncFile,{status:'failed',text:error.message,checkedAt:new Date().toISOString()});}catch{}throw error;}
}

export async function readProjectSync(root){
  const result={};
  for(const [scope,file] of [['team','team/state.json'],['room','git-sync.json']]){try{const data=JSON.parse(await readFile(path.join(root,'.ideas',file),'utf8')),saved=scope==='team'?data.gitSync:data;if(saved)result[scope]=Object.fromEntries(['status','branch','commit','url','text','checkedAt'].filter(k=>saved[k]!=null).map(k=>[k,saved[k]]));}catch{}}
  return result;
}
