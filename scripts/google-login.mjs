import {writeFile,mkdir,rename} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGoogleLogin} from '../google-login.mjs';
const runtime=path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'.runtime');
export async function saveGoogleSettings({clientId,allowedEmail,allowedSub=''},directory=runtime){
  if(!clientId||!allowedEmail)throw new Error('Google 웹 클라이언트 ID와 허용 이메일이 필요합니다.');
  createGoogleLogin({clientId,allowedEmail,allowedSub});
  await mkdir(directory,{recursive:true,mode:0o700});const target=path.join(directory,'google-login.json'),temp=target+'.'+randomUUID();
  await writeFile(temp,JSON.stringify({clientId,allowedEmail,allowedSub}),{mode:0o600});await rename(temp,target);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(!process.stdin.isTTY){console.error('맥 워커의 터미널에서 직접 실행하세요.');process.exit(1);}
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{const clientId=(await rl.question('Google 웹 OAuth 클라이언트 ID (비밀 키 아님): ')).trim();const allowedEmail=(await rl.question('허용할 내 Google 이메일: ')).trim();await saveGoogleSettings({clientId,allowedEmail});console.log('맥의 비공개 설정에 저장했습니다. 진행 중인 회의가 끝난 뒤 원격 서비스를 재시작하세요.');}
  catch(error){console.error(error.message);process.exitCode=1;}finally{rl.close();}
}
