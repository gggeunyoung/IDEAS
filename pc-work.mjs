import path from 'node:path';
import {mkdir,realpath,readdir,lstat} from 'node:fs/promises';

// Outside the team's disposable Git checkout; never automatically committed or pushed.
export const pcWorkDirectory=root=>path.join(root,'.ideas','pc-work');
export function pcCapabilities(root,platform=process.platform){
  return {available:platform==='darwin',directory:pcWorkDirectory(root),files:true,terminal:true,network:true,desktop:false};
}
export async function preparePcWork(root,platform=process.platform){
  if(platform!=='darwin')throw new Error('맥 직접 작업 모드는 macOS에서만 지원합니다.');
  const base=await realpath(root),directory=pcWorkDirectory(base);
  await mkdir(directory,{recursive:true,mode:0o700});
  if(await realpath(directory)!==directory)throw new Error('맥 작업 폴더에 심볼릭 링크를 사용할 수 없습니다.');
  return directory;
}
export function claudePcSettings(directory){
  return {disableAllHooks:true,forceLoginMethod:'claudeai',
    permissions:{additionalDirectories:[directory]},
    sandbox:{enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,
      filesystem:{allowWrite:[directory]},network:{allowedDomains:['*'],allowLocalBinding:true}}};
}
// Detect real progress outside Git without reading file contents or following symlinks.
export async function pcSnapshot(directory){
  const result=new Map();let visited=0;
  async function walk(dir){
    for(const name of (await readdir(dir)).sort()){
      if(++visited>5000)throw new Error('맥 작업 폴더의 변경 감지 한도(5,000개 항목)를 넘었습니다.');
      if(['node_modules','.git','.venv','.cache','__pycache__'].includes(name))continue;
      const file=path.join(dir,name),s=await lstat(file);
      if(s.isSymbolicLink())continue;
      if(s.isDirectory())await walk(file);
      else if(s.isFile())result.set(path.relative(directory,file),`${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
    }
  }
  await walk(directory);return result;
}
export function pcChanges(before,after){return [...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file));}
