import http from 'node:http';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {goalBudget} from './goal-workflow.mjs';
import {teamBudget} from './team-workflow.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest();
const equal=(a,b)=>timingSafeEqual(hash(String(a||'')),hash(String(b||'')));
export async function prepareRemoteSecrets(directory=path.join(root,'.runtime')){
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'remote-secrets.json');
  try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');
  const secrets={bridgeToken:randomBytes(32).toString('base64url'),salt,passwordHash:scryptSync(password,salt,32).toString('hex')};
  await writeFile(file,JSON.stringify(secrets),{mode:0o600,flag:'wx'});
  await writeFile(path.join(directory,'remote-login.txt'),`IDEAS 회의실 로그인 비밀번호\n${password}\n\nhttps://ideas-nine-opal.vercel.app/ 에서만 입력하세요. Git에 저장하지 마세요.\n`,{mode:0o600,flag:'wx'});
  return secrets;
}
async function readJsonBody(req){const chunks=[];let length=0;for await(const chunk of req){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>150000)throw new Error('요청이 너무 큽니다.');chunks.push(bytes);}const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));return JSON.parse(body||'{}');}
export async function createRemoteWorker({secrets,localUrl='http://127.0.0.1:3030',directory=path.join(root,'.runtime','remote-jobs'),fetchImpl=fetch,persistJob}={}){
  if(!secrets?.bridgeToken||!secrets?.passwordHash||!secrets?.salt)throw new Error('원격 인증 설정이 필요합니다.');
  const local=new URL(localUrl);if(local.protocol!=='http:'||local.hostname!=='127.0.0.1'||local.pathname!=='/')throw new Error('로컬 서버 주소가 올바르지 않습니다.');
  const sessions=new Map(),jobs=new Map(),controllers=new Map();let active=null,loginAttempts=[];
  await mkdir(directory,{recursive:true,mode:0o700});
  const store=persistJob||async function(job){const file=path.join(directory,job.id+'.json'),temp=file+'.'+randomUUID();await writeFile(temp,JSON.stringify(job),{mode:0o600});await rename(temp,file);};
  let recoveryWarnings=0;
  for(const name of (await readdir(directory)).filter(n=>/^[0-9a-f-]{36}\.json$/.test(n))){
    let job;try{job=JSON.parse(await readFile(path.join(directory,name),'utf8'));if(job.id!==name.slice(0,-5)||!['meeting','connect-room','save-room'].includes(job.type)||!job.request||!Array.isArray(job.events)||!['queued','running','done','failed','cancelled','interrupted'].includes(job.status))throw new Error();}
    catch{const quarantine=path.join(directory,'quarantine');await mkdir(quarantine,{recursive:true,mode:0o700});await rename(path.join(directory,name),path.join(quarantine,name+'.'+randomUUID()+'.invalid'));recoveryWarnings++;continue;}
    if(['queued','running'].includes(job.status)){job.status='interrupted';job.error='맥 워커가 재시작되어 작업이 중단됐습니다. 저장된 대화와 결과를 확인하세요.';await store(job);}jobs.set(job.id,job);
  }
  const cookieToken=req=>/\b__Host-ideas_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
  const authenticated=req=>{const token=cookieToken(req),key=token?hash(token).toString('hex'):null;const expires=key&&sessions.get(key);if(!expires||expires<Date.now()){if(key)sessions.delete(key);return false;}return true;};
  const localFetch=(route,options={})=>fetchImpl(new URL(route,local),{...options,redirect:'error',headers:{...options.headers,Origin:local.origin,'Content-Type':'application/json'}});
  async function execute(job){
    const control=controllers.get(job.id)||new AbortController();controllers.set(job.id,control);
    try{
      control.signal.throwIfAborted();job.status='running';await store(job);control.signal.throwIfAborted();
      const routes={meeting:'/api/meeting','connect-room':'/api/rooms','save-room':'/api/room-save'};
      const timeout=job.type==='meeting'&&job.request.workflow==='goal'?goalBudget(job.request.budget).minutes*60000+60000:job.type==='meeting'&&job.request.workflow==='team'?teamBudget(job.request.budget).minutes*60000+60000:630000;
      const response=await localFetch(routes[job.type],{method:'POST',body:JSON.stringify(job.request),signal:AbortSignal.any([control.signal,AbortSignal.timeout(timeout)])});
      if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw new Error(error||'맥 서버가 작업을 거절했습니다.');}
      if(job.type==='meeting'){
        let buffer='';const decoder=new TextDecoder();for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line){job.events.push(JSON.parse(line));await store(job);}}}
        if(!job.events.some(e=>e.type==='done'))throw new Error('회의가 완료되지 않았습니다. 저장된 대화와 결과를 확인하세요.');
      }else job.result=await response.json();
      job.status='done';
    }catch(error){job.status=control.signal.aborted?'cancelled':'failed';job.error=control.signal.aborted?'회의를 중단했습니다. 이미 생성한 답변과 사용한 계정 한도는 유지됩니다.':error.message;}
    finally{controllers.delete(job.id);if(active===job.id)active=null;job.finishedAt=new Date().toISOString();await store(job);}
  }
  const server=http.createServer(async(req,res)=>{
    const send=(status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
    if(!equal(req.headers.authorization,'Bearer '+secrets.bridgeToken))return send(401,{error:'중계 인증이 필요합니다.'});
    const url=new URL(req.url,'http://worker'),route=url.pathname;
    try{
      if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON 요청이 필요합니다.'});
      if(req.method==='POST'&&route==='/api/auth/login'){
        const now=Date.now();loginAttempts=loginAttempts.filter(time=>time>now-60000);if(loginAttempts.length>=10)return send(429,{error:'로그인 시도가 많습니다. 1분 뒤 다시 시도하세요.'});loginAttempts.push(now);
        const data=await readJsonBody(req);if(typeof data.password!=='string'||data.password.length>128||!equal(scryptSync(data.password,secrets.salt,32).toString('hex'),secrets.passwordHash))return send(401,{error:'비밀번호가 맞지 않습니다.'});
        for(const [key,expires] of sessions)if(expires<now)sessions.delete(key);if(sessions.size>=30)return send(429,{error:'로그인 세션이 너무 많습니다.'});
        const token=randomBytes(32).toString('base64url');sessions.set(hash(token).toString('hex'),now+8*3600000);
        return send(200,{authenticated:true},{'Set-Cookie':`__Host-ideas_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`});
      }
      if(!authenticated(req))return send(401,{error:'회의실에 로그인하세요.'});
      if(req.method==='GET'&&route==='/api/auth/status')return send(200,{authenticated:true,worker:'online',recoveryWarnings,activeJob:active?{id:active,type:jobs.get(active).type,roomId:jobs.get(active).request.roomId||'platform'}:null});
      if(req.method==='POST'&&route==='/api/auth/logout'){const token=cookieToken(req);if(token)sessions.delete(hash(token).toString('hex'));return send(200,{authenticated:false},{'Set-Cookie':'__Host-ideas_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});}
      const match=/^\/api\/jobs\/([0-9a-f-]{36})(\/cancel)?$/.exec(route);
      if(match){const job=jobs.get(match[1]);if(!job)return send(404,{error:'작업을 찾을 수 없습니다.'});if(req.method==='POST'&&match[2]){if(job.type!=='meeting')return send(409,{error:'Git 저장과 저장소 연결은 중단할 수 없습니다.'});if(!['queued','running'].includes(job.status))return send(200,{cancelled:false,status:job.status});controllers.get(job.id)?.abort();return send(200,{cancelled:true});}if(req.method==='GET'&&!match[2]){const cursor=Number(url.searchParams.get('after')||0);if(!Number.isInteger(cursor)||cursor<0)return send(400,{error:'작업 위치가 올바르지 않습니다.'});return send(200,{id:job.id,type:job.type,roomId:job.request.roomId||'platform',status:job.status,events:job.events.slice(cursor),cursor:job.events.length,result:job.result,error:job.error,...(cursor===0&&job.type==='meeting'?{history:job.request.history,mode:job.request.mode,workflow:job.request.workflow}:{})});}return send(405,{error:'허용되지 않은 요청입니다.'});}
      if(req.method==='POST'&&route==='/api/jobs'){
        const data=await readJsonBody(req);if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(data.id||'')||!['meeting','connect-room','save-room'].includes(data.type)||!data.request||typeof data.request!=='object')return send(400,{error:'작업 요청이 올바르지 않습니다.'});
        const previous=jobs.get(data.id);if(previous){if(previous.type!==data.type||JSON.stringify(previous.request)!==JSON.stringify(data.request))return send(409,{error:'같은 작업 ID의 요청이 다릅니다.'});return send(200,{id:previous.id,status:previous.status});}
        if(active)return send(409,{error:'다른 작업이 진행 중입니다. 완료 후 다시 시도하세요.'});
        const job={id:data.id,type:data.type,request:data.request,status:'queued',events:[],createdAt:new Date().toISOString()};active=job.id;jobs.set(job.id,job);controllers.set(job.id,new AbortController());
        try{await store(job);}catch{jobs.delete(job.id);controllers.delete(job.id);if(active===job.id)active=null;return send(503,{error:'맥에 작업 상태를 저장하지 못했습니다. 디스크 공간과 권한을 확인하세요.'});}
        send(202,{id:job.id,status:job.status});void execute(job).catch(()=>{controllers.delete(job.id);if(active===job.id)active=null;});return;
      }
      const allowedGet=/^\/api\/(rooms|config|files|session|deliverables|artifacts\/[0-9a-f-]{36}|deliverables\/[0-9a-f-]{36}\/(draft|final)\/(bundle|file))$/.test(route);
      const reset=req.method==='POST'&&route==='/api/session';
      if((req.method!=='GET'||!allowedGet)&&!reset)return send(404,{error:'허용되지 않은 경로입니다.'});
      const body=reset?await readJsonBody(req):null;if(reset&&body.reset!==true)return send(400,{error:'새 대화 요청이 필요합니다.'});
      const response=await localFetch(route+url.search,{method:req.method,body:reset?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
      const headers={'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'};if(response.headers.has('content-disposition'))headers['Content-Disposition']=response.headers.get('content-disposition');res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));
    }catch{send(502,{error:'맥 서버와 연결되지 않았습니다. 맥의 서버·인터넷·잠자기 상태를 확인하세요.'});}
  });
  server.requestTimeout=30000;server.on('close',()=>{for(const controller of controllers.values())controller.abort();});return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const secrets=await prepareRemoteSecrets();const worker=await createRemoteWorker({secrets});worker.listen(3031,'127.0.0.1',()=>console.log('IDEAS 원격 워커: 127.0.0.1:3031 (인증 필수)'));
}
