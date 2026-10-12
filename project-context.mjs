import {readdir,realpath,lstat,open,mkdir,writeFile,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const excluded=new Set(['node_modules','artifacts','conversations','dist','build','vendor','deliverables']);
const suffixes=new Set(['.md','.txt','.json','.js','.mjs','.ts','.tsx','.jsx','.html','.css','.py','.java','.yml','.yaml','.toml']);
function allowed(name){return !name.startsWith('.')&&!excluded.has(name)&&!/(credential|secret|token|password|private.?key|^env\b|\.pem$|\.key$)/i.test(name);}
function contained(root,target){const relative=path.relative(root,target);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
const sensitive=/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-[A-Za-z0-9_-]{16,}|\bAIza[A-Za-z0-9_-]{25,}|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*["']?(?!process\.|os\.|\$|["']?\s*$)[A-Za-z0-9_+/.-]{12,}/i;

export const containsSensitive=content=>sensitive.test(content);

export async function projectFiles(root){
  root=await realpath(root);const files=[];
  const walk=async(dir,depth)=>{if(depth>5||files.length>=200)return;
    const entries=await readdir(dir,{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(files.length>=200)break;if(!allowed(entry.name)||entry.isSymbolicLink())continue;
      const full=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(full,depth+1);
      else if(entry.isFile()&&suffixes.has(path.extname(entry.name))&&(await lstat(full)).size<=48000)files.push(path.relative(root,full));
    }
  };await walk(root,0);return files;
}

export async function snapshotFiles(root,selection=[]){
  if(!Array.isArray(selection)||selection.length>8||selection.some(x=>typeof x!=='string')||new Set(selection).size!==selection.length)throw new Error('자료 파일은 최대 8개를 선택하세요.');
  root=await realpath(root);const chunks=[];let total=0;
  for(const relative of selection){
    if(path.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>part==='..'||!allowed(part))||!suffixes.has(path.extname(relative)))throw new Error('허용되지 않은 자료 경로입니다.');
    const full=path.join(root,relative),resolved=await realpath(full);
    if(!contained(root,resolved)||resolved!==full||(await lstat(full)).isSymbolicLink())throw new Error('외부 경로나 심볼릭 링크는 자료로 사용할 수 없습니다.');
    const file=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW);
    let content;try{if(!(await file.stat()).isFile()||(await file.stat()).size>48000)throw new Error('자료 파일이 너무 크거나 일반 파일이 아닙니다.');content=await file.readFile('utf8');}finally{await file.close();}
    if(content.includes('\0')||sensitive.test(content))throw new Error(`${relative}: 바이너리 또는 비밀정보로 보이는 내용이 있어 전송하지 않았습니다.`);
    total+=content.length;if(total>32000)throw new Error('선택한 자료의 합계가 32,000자를 넘습니다. 파일 수를 줄이세요.');
    chunks.push(`자료 파일: ${relative}\n<자료>\n${content}\n</자료>`);
  }
  return chunks.join('\n\n');
}

export async function saveArtifact(directory,request,events){
  const id=randomUUID(),answers=events.filter(e=>e.type==='answer'||e.type==='error');
  const labels={1:'독립 제안',2:['draft','files'].includes(request.workflow)?'작성자 초안':'상호 검토',3:'초안 검토',4:'검토 반영 수정본'};
  const text=`# IDEAS 회의 결과\n\n생성 시각: ${new Date().toISOString()}\n\n모드: ${request.mode} · 작업: ${request.workflow||'discuss'}\n\n웹 검색: ${request.webSearch?'허용':'꺼짐'}\n\n자료: ${(request.files||[]).join(', ')||'없음'}\n\n`+request.history.map(m=>`## ${m.speaker}\n\n${m.text}`).join('\n\n')+'\n\n'+answers.map(e=>`## ${e.speaker} · ${labels[e.round]}${e.type==='error'?' · 실패':''}\n\n${e.text}\n\n${e.model?`모델: ${e.model}`:''}${e.webSearchEnabled?`\n검색 도구 호출: ${e.webSearchCount||0}회 · 페이지 확인 도구 호출: ${e.webFetchCount||0}회`:''}`).join('\n\n')+'\n';
  await mkdir(directory,{recursive:true,mode:0o700});await writeFile(path.join(directory,`${id}.md`),text,{mode:0o600,flag:'wx'});
  return {id,url:`/api/artifacts/${id}`,name:`ideas-${id}.md`};
}
export async function readArtifact(directory,id){if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))throw new Error('잘못된 결과물 ID');return readFile(path.join(directory,`${id}.md`));}
