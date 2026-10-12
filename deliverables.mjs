import {mkdir,writeFile,readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {containsSensitive} from './project-context.mjs';

export const bundleSchema={
  type:'object',additionalProperties:false,required:['summary','files'],
  properties:{summary:{type:'string'},files:{type:'array',minItems:1,maxItems:5,items:{
    type:'object',additionalProperties:false,required:['path','content'],
    properties:{path:{type:'string'},content:{type:'string'}}
  }}}
};
const idPattern=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const extensions=new Set(['.md','.txt','.json','.js','.mjs','.ts','.tsx','.jsx','.html','.css','.py','.java','.yml','.yaml','.toml']);
export function parseBundle(raw){
  let data;try{data=JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n/i,'').replace(/\n```\s*$/,''));}catch{throw new Error('작성자가 파일 형식의 결과를 반환하지 않았습니다. 답변을 보존했으며 파일 저장은 건너뛰었습니다.');}
  if(!data||typeof data.summary!=='string'||data.summary.length>2000||!Array.isArray(data.files)||!data.files.length||data.files.length>5)throw new Error('파일 결과는 요약과 최대 5개 파일이어야 합니다.');
  let total=0;const seen=new Set();
  for(const file of data.files){
    if(!file||typeof file.path!=='string'||file.path.length>160||!extensions.has(path.posix.extname(file.path))||!file.path.split('/').every(part=>/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(part)&&!part.endsWith(' ')&&!part.endsWith('.')&&!/(credential|secret|token|password|private.?key|^env\b)/i.test(part))||file.path.includes('\\')||seen.has(file.path.toLowerCase()))throw new Error('결과 파일에 허용되지 않은 경로나 중복 이름이 있습니다.');
    if(typeof file.content!=='string'||!file.content.trim()||file.content.length>16000||file.content.includes('\0')||containsSensitive(file.content))throw new Error('결과 파일이 비어 있거나 너무 크거나 비밀정보로 보이는 내용을 포함합니다.');
    if([...seen].some(p=>p.startsWith(file.path.toLowerCase()+'/')||file.path.toLowerCase().startsWith(p+'/')))throw new Error('파일 이름과 폴더 이름이 충돌합니다.');
    seen.add(file.path.toLowerCase());total+=file.content.length;
  }
  if(total>32000||containsSensitive(data.summary))throw new Error('결과물 크기 또는 비밀정보 검사에 실패했습니다.');
  return {summary:data.summary,files:data.files.map(({path,content})=>({path,content}))};
}
export function bundleText(bundle){return bundle.files.map(f=>`파일: ${f.path}\n<파일 내용>\n${f.content}\n</파일 내용>`).join('\n\n');}
export async function createDeliverable(root,request){
  const id=randomUUID(),directory=path.join(root,id);
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({id,createdAt:new Date().toISOString(),task:request.history.at(-1).text,writer:request.writer,participants:request.participants,sourceFiles:request.files||[],versions:[],status:'started'},null,2),{mode:0o600,flag:'wx'});
  return id;
}
export async function saveVersion(root,id,version,bundle,{status,review}={}){
  if(!idPattern.test(id)||!['draft','final'].includes(version))throw new Error('잘못된 결과물입니다.');
  bundle=parseBundle(JSON.stringify(bundle));const directory=path.join(root,id);
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.versions.includes(version))throw new Error('이미 저장한 버전은 덮어쓰지 않습니다.');
  const filesDir=path.join(directory,version);await mkdir(filesDir,{mode:0o700});
  for(const f of bundle.files){const full=path.join(filesDir,f.path);await mkdir(path.dirname(full),{recursive:true,mode:0o700});await writeFile(full,f.content,{mode:0o600,flag:'wx'});}
  await writeFile(path.join(directory,`${version}.json`),JSON.stringify(bundle,null,2),{mode:0o600,flag:'wx'});
  if(review)await writeFile(path.join(directory,'review.md'),review,{mode:0o600,flag:'wx'});
  manifest.versions.push(version);manifest.status=status||version;manifest.summary=bundle.summary;
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return {id,version,status:manifest.status,summary:bundle.summary,files:bundle.files.map(f=>({path:f.path,url:`/api/deliverables/${id}/${version}/file?path=${encodeURIComponent(f.path)}`})),url:`/api/deliverables/${id}/${version}/bundle`};
}
export async function listDeliverables(root){
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const items=[];for(const e of entries){if(!e.isDirectory()||!idPattern.test(e.name))continue;try{const m=JSON.parse(await readFile(path.join(root,e.name,'manifest.json'),'utf8'));items.push({id:e.name,createdAt:m.createdAt,task:m.task,writer:m.writer,participants:m.participants,status:m.status,versions:m.versions,summary:m.summary});}catch{}}
  return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30);
}
export async function readDeliverable(root,id,version,file=null){
  if(!idPattern.test(id)||!['draft','final'].includes(version))throw new Error('잘못된 결과물 경로');
  const dir=path.join(root,id);if(!(await lstat(dir)).isDirectory()||(await lstat(dir)).isSymbolicLink())throw new Error('잘못된 결과물 폴더');
  const bundle=parseBundle(await readFile(path.join(dir,`${version}.json`),'utf8'));
  if(file!=null){const found=bundle.files.find(f=>f.path===file);if(!found)throw new Error('파일 없음');return found.content;}
  return JSON.stringify(bundle,null,2);
}
