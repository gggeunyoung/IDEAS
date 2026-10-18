import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createTunnelSupervisor} from './tunnel-supervisor.mjs';
import {loadGoogleSettings} from '../google-login.mjs';
import {prepareRemoteSecrets,createRemoteWorker} from '../remote-worker.mjs';
import {createServer} from '../server.mjs';
import {createPreviewServer} from './preview-server.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),runtime=path.join(root,'.runtime');
const origin=process.env.IDEAS_PUBLIC_ORIGIN||'https://ideas-nine-opal.vercel.app';
if(new URL(origin).origin!==origin||new URL(origin).protocol!=='https:')throw new Error('원격 웹 주소는 HTTPS origin이어야 합니다.');
await mkdir(runtime,{recursive:true,mode:0o700});const secrets=await prepareRemoteSecrets(runtime);
let localServer,checkingLocal=false,stopping=false;
async function ensureLocalServer(){
  if(checkingLocal)return;checkingLocal=true;
  try{const health=await fetch('http://127.0.0.1:3030/api/rooms',{signal:AbortSignal.timeout(3000)});if(!health.ok)throw new Error();}
  catch{if(!stopping&&!localServer?.listening){localServer=createServer();try{await new Promise((resolve,reject)=>{localServer.once('error',reject);localServer.listen(3030,'127.0.0.1',resolve);});console.log('맥 회의실 서버 시작');}catch{console.log('맥 회의실 서버 연결 대기 중');}}}
  finally{checkingLocal=false;}
}
await ensureLocalServer();
const preview=createPreviewServer();await new Promise((resolve,reject)=>{preview.once('error',reject);preview.listen(3032,'127.0.0.1',resolve);});console.log('맥 시제품 미리보기 서버 시작 · 127.0.0.1:3032');
const worker=await createRemoteWorker({secrets,googleSettings:await loadGoogleSettings(path.join(runtime,'google-login.json'))});await new Promise(resolve=>worker.listen(3031,'127.0.0.1',resolve));
const supervisor=createTunnelSupervisor({origin,bridgeToken:secrets.bridgeToken,
  spawnTunnel:()=>spawn(path.join(root,'.local-tools','cloudflare','cloudflared'),['tunnel','--no-autoupdate','--url','http://127.0.0.1:3031','--http-host-header','127.0.0.1:3031'],{cwd:root,stdio:['ignore','ignore','pipe']}),
  saveConnection:async connection=>{const target=path.join(runtime,'remote-connection.json'),temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(connection),{mode:0o600});await rename(temp,target);},
  log:message=>console.log(new Date().toISOString()+' '+message)
});
let healthTimer;
function stop(){if(stopping)return;stopping=true;clearInterval(healthTimer);supervisor.stop();worker.close();preview.close();localServer?.close();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);supervisor.start();healthTimer=setInterval(()=>{if(!stopping){void ensureLocalServer();void supervisor.tick().catch(()=>console.log('중계 점검 실패 · 다음 점검에서 재시도'));}},30000);console.log('IDEAS 원격 서비스 시작 · 맥은 켜져 있고 잠자기가 해제돼 있어야 합니다.');
