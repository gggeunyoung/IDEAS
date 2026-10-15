import http from 'node:http';
import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {publicConfig} from './providers.mjs';
import {validateRequest,runMeeting} from './room.mjs';
import {localStatus} from './local-agents.mjs';
import {projectFiles,snapshotFiles,saveArtifact,readArtifact} from './project-context.mjs';
import {listDeliverables,readDeliverable} from './deliverables.mjs';
import {createRoomRegistry,gitState,loadSession,saveSession,githubAccount} from './room-registry.mjs';
import {saveRoomGit} from './room-git.mjs';
import {goalBudget} from './goal-workflow.mjs';
import {teamBudget} from './team-workflow.mjs';
const appRoot=path.dirname(fileURLToPath(import.meta.url));
export function createServer({env=process.env,invoke,invokeLocal,invokeTeam,status=localStatus,github=githubAccount,projectRoot=env.IDEAS_PROJECT_ROOT||appRoot,artifactDir=path.join(appRoot,'artifacts'),deliverableDir=path.join(appRoot,'deliverables'),roomRegistryFile=path.join(projectRoot,'.runtime','rooms.json'),roomHome}={}){
  let busy=false;
  const registry=createRoomRegistry({file:roomRegistryFile,home:roomHome,defaultRoom:{id:'platform',name:projectRoot===appRoot?'IDEAS · 회의실 앱 개발':path.basename(projectRoot),root:projectRoot,kind:'platform',repo:projectRoot===appRoot?'https://github.com/gggeunyoung/IDEAS':null}});
  const scopeUrl=(url,room)=>url+(url.includes('?')?'&':'?')+'roomId='+encodeURIComponent(room.id);
  const storage=async room=>{
    const dirs=room.id==='platform'?{artifactDir,deliverableDir}:{artifactDir:path.join(room.root,'conversations'),deliverableDir:path.join(room.root,'outputs')};
    for(const dir of Object.values(dirs)){try{if((await lstat(dir)).isSymbolicLink())throw new Error('결과 저장 폴더는 심볼릭 링크일 수 없습니다.');}catch(e){if(e.code!=='ENOENT')throw e;}}
    return dirs;
  };
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host;
    if(!host||!/^127\.0\.0\.1:\d+$/.test(host)){res.writeHead(403);return res.end('Local access only');}
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url,`http://${host}`),route=url.pathname;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    if(req.method==='GET'&&['/','/app.js','/style.css'].includes(route)){
      const name=route==='/'?'index.html':route.slice(1);
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      try{const data=await readFile(new URL(`./public/${name}`,import.meta.url));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(data);}catch{return send(404,{error:'파일을 찾을 수 없습니다.'});}
    }
    if(req.method==='GET'&&route==='/api/github')return send(200,await github(env));
    if(req.method==='GET'&&route==='/api/rooms'){
      try{const items=await Promise.all((await registry.all()).map(async room=>({...room,git:await gitState(room.root)})));return send(200,{items,busy});}catch{return send(500,{error:'회의실 목록을 읽지 못했습니다.'});}
    }
    if(req.method==='GET'){
      try{
        const room=await registry.resolve(url.searchParams.get('roomId'));const dirs=await storage(room);
        if(route==='/api/config')return send(200,{participants:publicConfig(env),local:await status({env}),projectName:room.name,room,pricingDate:'2026-10-11'});
        if(route==='/api/files')return send(200,{files:await projectFiles(room.root)});
        if(route==='/api/session')return send(200,{messages:await loadSession(room.root)});
        if(route==='/api/deliverables')return send(200,{items:await listDeliverables(dirs.deliverableDir)});
        if(route.startsWith('/api/deliverables/')){
          const parts=route.split('/');if(parts.length!==6||!['file','bundle'].includes(parts[5]))throw new Error();
          const file=parts[5]==='file'?url.searchParams.get('path'):null;if(parts[5]==='file'&&file===null)throw new Error();
          const data=await readDeliverable(dirs.deliverableDir,parts[3],parts[4],file);const filename=file?path.basename(file):`ideas-${parts[4]}.json`;
          res.writeHead(200,{'Content-Type':file?'text/plain; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="ideas-file"; filename*=UTF-8''${encodeURIComponent(filename)}`});return res.end(data);
        }
        if(route.startsWith('/api/artifacts/')){const data=await readArtifact(dirs.artifactDir,route.slice('/api/artifacts/'.length));res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="ideas-meeting.md"'});return res.end(data);}
        return send(404,{error:'경로를 찾을 수 없습니다.'});
      }catch{return send(404,{error:'회의실 또는 결과물을 찾지 못했습니다.'});}
    }
    if(req.method!=='POST'||!['/api/meeting','/api/rooms','/api/session','/api/room-save'].includes(route))return send(404,{error:'경로를 찾을 수 없습니다.'});
    if(req.headers.origin!==`http://${host}`||!req.headers['content-type']?.startsWith('application/json'))return send(403,{error:'같은 로컬 화면에서만 호출할 수 있습니다.'});
    if(busy)return send(409,{error:'진행 중인 작업이 있습니다. 완료 후 다시 보내세요.'});
    const controller=new AbortController();let acquired=false,persist=Promise.resolve();
    try{
      const chunks=[];let length=0;for await(const chunk of req){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>150000)throw new Error('요청이 너무 큽니다.');chunks.push(bytes);}const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      const data=JSON.parse(body);
      if(route==='/api/rooms'){busy=true;acquired=true;const room=data.create===true?await registry.create(data):await registry.clone(data);return send(201,{room});}
      if(url.searchParams.get('roomId')&&data.roomId&&url.searchParams.get('roomId')!==data.roomId)throw new Error('회의실 요청이 일치하지 않습니다.');
      const room=await registry.resolve(data.roomId||url.searchParams.get('roomId'));const dirs=await storage(room);
      if(route==='/api/session'){if(data.reset!==true)throw new Error('새 대화를 시작할 요청이 필요합니다.');await saveSession(room.root,[]);return send(200,{reset:true});}
      if(route==='/api/room-save'){busy=true;acquired=true;return send(200,await saveRoomGit(room.root));}
      const request=validateRequest(data);
      if(request.mode==='live'&&request.participants.some(id=>!publicConfig(env).find(p=>p.id===id).ready))throw new Error('선택한 참가자의 API 키를 설정하세요.');
      // Reject before any AI call: the generated-test sandbox only exists on macOS.
      if(request.workflow==='goal'&&process.platform!=='darwin')throw new Error('목표 실행의 테스트 격리는 현재 macOS에서만 지원합니다. AI를 호출하지 않았습니다.');
      if(request.workflow==='team'&&room.kind!=='project')throw new Error('팀 모드는 GitHub 저장소가 연결된 프로젝트 회의실에서 사용할 수 있습니다. 회의실 앱 자체는 수정하지 않습니다.');
      if(request.mode==='subscription'){const local=await status({env});if(request.participants.some(id=>!local.find(p=>p.id===id)?.ready))throw new Error('선택한 참가자의 구독 계정으로 CLI에 로그인하세요. API로 대체하지 않습니다.');}
      const context=await snapshotFiles(room.root,request.files||[]);
      if(busy)return send(409,{error:'진행 중인 회의가 있습니다.'});busy=true;acquired=true;
      const saved=await loadSession(room.root);
      // Team runs carry their own memory in .ideas/team, so the room transcript is appended rather than replaced.
      const messages=request.workflow==='team'?[...saved,{...request.history.at(-1),mode:request.mode,workflow:request.workflow}]:request.history.map((m,index)=>{const previous=saved[index];return previous&&previous.speaker===m.speaker&&previous.text===m.text?previous:{...m,mode:request.mode,workflow:request.workflow};});await saveSession(room.root,messages);
      res.on('close',()=>{if(!res.writableEnded)controller.abort();});res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(request.workflow==='team'?teamBudget(request.budget).minutes*60000+30000:request.workflow==='goal'?goalBudget(request.budget).minutes*60000+30000:request.workflow==='files'?600000:request.mode==='subscription'?300000:120000)]);
      const events=[];let completed=false;
      const emit=event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
      await runMeeting(request,event=>{
        events.push(event);if(['answer','error','goal'].includes(event.type)){messages.push({...event,mode:request.mode,workflow:request.workflow,error:event.type==='error'});const snapshot=JSON.parse(JSON.stringify(messages));persist=persist.then(()=>saveSession(room.root,snapshot));}
        if(event.type==='deliverable')event={...event,url:scopeUrl(event.url,room),files:event.files.map(f=>({...f,url:scopeUrl(f.url,room)}))};
        if(event.type==='done')completed=true;else emit(event);
      },{env,invoke,invokeLocal,invokeTeam,signal,context,deliverableDir:dirs.deliverableDir,projectRoot:room.root});
      await persist;
      if(completed){try{const artifact=await saveArtifact(dirs.artifactDir,request,events);emit({type:'artifact',...artifact,url:scopeUrl(artifact.url,room)});}catch{emit({type:'notice',text:'회의록 파일 저장에 실패했습니다. 브라우저에서 내보내세요.'});}emit({type:'done'});}
      res.end();
    }catch(error){if(!res.headersSent)send(400,{error:error instanceof SyntaxError?'요청 형식을 확인하세요.':error.message});else if(!res.destroyed)res.end(JSON.stringify({type:'notice',text:'작업을 완료하지 못했습니다. 생성된 답변은 저장된 대화나 내보내기로 확인하세요.'})+'\n');}
    finally{try{await persist;}catch{}if(acquired)busy=false;}
  });
  server.requestTimeout=7230000;return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT||3030);createServer().listen(port,'127.0.0.1',()=>console.log(`IDEAS 회의실: http://127.0.0.1:${port}`));}
