import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {randomBytes,scryptSync} from 'node:crypto';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Replaces only the web login password. The bridge key registered on Vercel stays the same.
export async function setRemotePassword(password,directory=path.join(root,'.runtime')){
  if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('비밀번호는 12~128자로 정하세요.');
  const file=path.join(directory,'remote-secrets.json');
  let secrets;try{secrets=JSON.parse(await readFile(file,'utf8'));}catch{throw new Error('이 기기에 원격 인증 설정이 없습니다. 원격 워커를 실행하는 맥에서 실행하세요.');}
  if(!secrets.bridgeToken)throw new Error('원격 인증 설정이 올바르지 않습니다.');
  const salt=randomBytes(16).toString('hex'),temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
  await writeFile(temp,JSON.stringify({...secrets,salt,passwordHash:scryptSync(password,salt,32).toString('hex')}),{mode:0o600});await rename(temp,file);
  // The generated password stops working, so its plaintext copy is removed rather than left stale.
  await rm(path.join(directory,'remote-login.txt'),{force:true});
}
function askHidden(question){
  return new Promise(resolve=>{
    const rl=createInterface({input:process.stdin,output:process.stdout,terminal:true});
    rl._writeToOutput=text=>{if(text.includes(question))process.stdout.write(question);};
    rl.question(question,answer=>{rl.close();process.stdout.write('\n');resolve(answer);});
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(!process.stdin.isTTY){console.error('터미널에서 직접 실행해 비밀번호를 입력하세요.');process.exit(1);}
  const first=await askHidden('새 회의실 비밀번호 (12자 이상, 화면에 표시되지 않음): '),second=await askHidden('한 번 더 입력: ');
  if(first!==second){console.error('두 입력이 다릅니다. 바꾸지 않았습니다.');process.exit(1);}
  try{await setRemotePassword(first);}catch(error){console.error(error.message);process.exit(1);}
  console.log('비밀번호를 바꿨습니다. 실행 중인 원격 서비스를 다시 시작해야 적용됩니다.\n자동 실행 서비스: npm run service:remove 후 npm run service:install\n수동 실행 중이면 종료한 뒤 npm run start:service');
}
