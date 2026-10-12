import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {publicConfig} from './providers.mjs';
import {validateRequest,runMeeting} from './room.mjs';
import {localStatus} from './local-agents.mjs';
import {projectFiles,snapshotFiles,saveArtifact,readArtifact} from './project-context.mjs';
import {listDeliverables,readDeliverable} from './deliverables.mjs';

export function createServer({env=process.env,invoke,invokeLocal,status=localStatus,projectRoot=env.IDEAS_PROJECT_ROOT||path.dirname(fileURLToPath(import.meta.url)),artifactDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'artifacts'),deliverableDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'deliverables')}={}) {
  let busy=false;
  const server=http.createServer(async(req,res)=>{
    const host=req.headers.host;
    if(!host || !/^127\.0\.0\.1:\d+$/.test(host)) {res.writeHead(403);return res.end('Local access only');}
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const route=new URL(req.url,`http://${host}`).pathname;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    if(req.method==='GET'&&route==='/api/config') {
      try{return send(200,{participants:publicConfig(env),local:await status({env}),projectName:path.basename(projectRoot),pricingDate:'2026-10-11'});}catch{return send(500,{error:'연결 상태를 확인하지 못했습니다.'});}
    }
    if(req.method==='GET'&&route==='/api/files') {try{return send(200,{files:await projectFiles(projectRoot)});}catch{return send(400,{error:'자료 폴더를 읽지 못했습니다.'});}}
    if(req.method==='GET'&&route==='/api/deliverables'){try{return send(200,{items:await listDeliverables(deliverableDir)});}catch{return send(500,{error:'파일 결과 목록을 읽지 못했습니다.'});}}
    if(req.method==='GET'&&route.startsWith('/api/deliverables/')){
      const parts=route.split('/');
      try{
        if(parts.length!==6||!['file','bundle'].includes(parts[5]))throw new Error();
        const file=parts[5]==='file'?new URL(req.url,`http://${host}`).searchParams.get('path'):null;
        if(parts[5]==='file'&&file===null)throw new Error();
        const data=await readDeliverable(deliverableDir,parts[3],parts[4],file);
        const filename=file?path.basename(file):`ideas-${parts[4]}.json`;
        res.writeHead(200,{'Content-Type':file?'text/plain; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="ideas-file"; filename*=UTF-8''${encodeURIComponent(filename)}`});return res.end(data);
      }catch{return send(404,{error:'파일 결과를 찾지 못했습니다.'});}
    }
    if(req.method==='GET'&&route.startsWith('/api/artifacts/')){
      try{const data=await readArtifact(artifactDir,route.slice('/api/artifacts/'.length));res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="ideas-meeting.md"'});return res.end(data);}catch{return send(404,{error:'결과물을 찾지 못했습니다.'});}
    }
    if(req.method==='GET'&&['/','/app.js','/style.css'].includes(route)) {
      const name=route==='/'?'index.html':route.slice(1);
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      try {const data=await readFile(new URL(`./public/${name}`,import.meta.url));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});return res.end(data);} catch {return send(404,{error:'파일을 찾을 수 없습니다.'});}
    }
    if(req.method!=='POST'||route!=='/api/meeting') return send(404,{error:'경로를 찾을 수 없습니다.'});
    if(req.headers.origin!==`http://${host}` || !req.headers['content-type']?.startsWith('application/json')) return send(403,{error:'같은 로컬 화면에서만 호출할 수 있습니다.'});
    if(busy) return send(409,{error:'진행 중인 회의가 있습니다. 완료 후 다시 보내세요.'});
    const controller=new AbortController();
    let acquired=false;
    try {
      let body='';
      for await(const chunk of req) {body+=chunk; if(Buffer.byteLength(body)>150000) throw new Error('요청이 너무 큽니다.');}
      const request=validateRequest(JSON.parse(body));
      if(request.mode==='live'&&request.participants.some(id=>!publicConfig(env).find(p=>p.id===id).ready)) throw new Error('선택한 참가자의 API 키를 설정하세요.');
      if(request.mode==='subscription'){
        const local=await status({env});
        if(request.participants.some(id=>!local.find(p=>p.id===id)?.ready))throw new Error('선택한 참가자의 구독 계정으로 CLI에 로그인하세요. API로 대체하지 않습니다.');
      }
      const context=await snapshotFiles(projectRoot,request.files||[]);
      if(busy) return send(409,{error:'진행 중인 회의가 있습니다.'});
      busy=true; acquired=true;
      res.on('close',()=>{if(!res.writableEnded) controller.abort();});
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(request.workflow==='files'?600000:request.mode==='subscription'?300000:120000)]);
      const events=[];let completed=false;
      const emit=event=>{if(!res.destroyed)res.write(JSON.stringify(event)+'\n');};
      await runMeeting(request,event=>{events.push(event);if(event.type==='done')completed=true;else emit(event);},{env,invoke,invokeLocal,signal,context,deliverableDir});
      if(completed){
        try{const artifact=await saveArtifact(artifactDir,request,events);emit({type:'artifact',...artifact});}catch{emit({type:'notice',text:'결과물 파일 저장에 실패했습니다. 브라우저에서 회의록을 내보내세요.'});}
        emit({type:'done'});
      }
      res.end();
    } catch(error) {
      if(!res.headersSent) send(400,{error:error instanceof SyntaxError?'요청 형식을 확인하세요.':error.message});
      else if(!res.destroyed) res.end(JSON.stringify({type:'notice',text:'회의를 완료하지 못했습니다. 이미 생성된 답변은 브라우저에서 내보낼 수 있습니다.'})+'\n');
    } finally {if(acquired) busy=false;}
  });
  server.requestTimeout=630000;
  return server;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||3030);
  createServer().listen(port,'127.0.0.1',()=>console.log(`IDEAS 회의실: http://127.0.0.1:${port}`));
}
