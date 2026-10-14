import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
let tunnel,url,registered=false,retryTimer,registerTimer,healthTimer;
async function register(){
  if(!url||registered||stopping)return;
  try{const response=await fetch(origin+'/api/worker/register',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+secrets.bridgeToken,'Content-Type':'application/json'},body:JSON.stringify({url}),signal:AbortSignal.timeout(25000)});if(!response.ok)throw new Error();registered=true;await writeFile(path.join(runtime,'remote-connection.json'),JSON.stringify({url,origin,registeredAt:new Date().toISOString()}),{mode:0o600});console.log('Vercel에 맥 워커 연결 완료');}catch{console.log('Vercel 연결 등록 대기 중 · 15초 후 재시도');}
}
function startTunnel(){
  registered=false;url=null;
  tunnel=spawn(path.join(root,'.local-tools','cloudflare','cloudflared'),['tunnel','--no-autoupdate','--url','http://127.0.0.1:3031','--http-host-header','127.0.0.1:3031'],{cwd:root,stdio:['ignore','ignore','pipe']});
  let buffer='';tunnel.stderr.on('data',chunk=>{buffer+=chunk.toString();const match=/https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buffer);if(match&&!url){url=match[0];console.log('인증된 맥 중계 연결 시작 · 등록 중');void register();}buffer=buffer.slice(-8000);});
  tunnel.on('error',()=>console.log('cloudflared 실행 실패 · npm run setup:tunnel을 확인하세요.'));
  tunnel.on('exit',()=>{if(!stopping){console.log('맥 중계 연결 종료 · 5초 후 다시 연결');retryTimer=setTimeout(startTunnel,5000);}});
}
function stop(){if(stopping)return;stopping=true;clearTimeout(retryTimer);clearInterval(registerTimer);clearInterval(healthTimer);tunnel?.kill();worker.close();preview.close();localServer?.close();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);startTunnel();registerTimer=setInterval(()=>void register(),15000);healthTimer=setInterval(()=>{if(!stopping)void ensureLocalServer();},15000);console.log('IDEAS 원격 서비스 시작 · 맥은 켜져 있고 잠자기가 해제돼 있어야 합니다.');
