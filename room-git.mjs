import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {containsSensitive} from './project-context.mjs';
import {git,repositoryUrl} from './room-registry.mjs';
export async function saveRoomGit(root){
  const branch=await git(root,['branch','--show-current']);if(!branch)throw new Error('브랜치가 없는 작업 상태에서는 저장하지 않습니다.');
  repositoryUrl(await git(root,['remote','get-url','origin']));
  if(await git(root,['diff','--cached','--name-only']))throw new Error('이미 스테이징한 변경이 있습니다. 먼저 해당 변경을 정리하세요.');
  const roots=['README.md','AGENTS.md','CLAUDE.md','.gitignore','docs/HANDOFF.md','conversations','deliverables','outputs'];
  const listed=await git(root,['ls-files','--modified','--others','--exclude-standard','-z','--',...roots]);
  const files=listed.split('\0').filter(Boolean);if(files.length>200)throw new Error('저장할 파일이 200개를 넘었습니다. 범위를 나눠 주세요.');
  for(const relative of files){const parts=relative.split('/');if(parts.some(p=>p==='..'||p==='.env'||p==='node_modules')||/(?:^|\/)(?:credential|secret|password|oauth|auth\.json)/i.test(relative))throw new Error('저장할 파일에 비밀정보 경로가 포함됐습니다.');
    let current=root;for(const part of parts){current=path.join(current,part);if((await lstat(current)).isSymbolicLink())throw new Error('심볼릭 링크는 저장하지 않습니다.');}
    const stat=await lstat(current);if(!stat.isFile()||stat.size>200000)throw new Error('일반 텍스트 파일만 저장할 수 있습니다.');
    const content=await readFile(current,'utf8');if(content.includes('\0')||containsSensitive(content))throw new Error('비밀정보 또는 바이너리로 보이는 파일은 저장하지 않습니다.');
  }
  if(files.length){await git(root,['add','--',...files]);await git(root,['commit','-m','Save room conversations and generated files']);}
  const commit=await git(root,['rev-parse','--short','HEAD']);
  try{await git(root,['push','origin',branch]);}catch{throw new Error(`커밋 ${commit}은 로컬에 있습니다. 푸시에 실패했으므로 GitHub 권한·네트워크를 확인하세요.`);}
  return {commit,branch,files:files.length,pushed:true};
}
