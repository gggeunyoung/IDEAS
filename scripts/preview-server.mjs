import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRoomRegistry} from '../room-registry.mjs';
import {readDeliverable} from '../deliverables.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function createPreviewServer({registry=createRoomRegistry({file:path.join(root,'.runtime','rooms.json'),defaultRoom:{id:'platform',name:'IDEAS',root,kind:'platform',repo:'https://github.com/gggeunyoung/IDEAS'}})}={}){
  return http.createServer(async(req,res)=>{
    if(req.method!=='GET'||!/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')){res.writeHead(403);return res.end();}
    try{
      const url=new URL(req.url,'http://127.0.0.1'),match=/^\/([a-zA-Z0-9-]+)\/([0-9a-f-]{36})\/(draft|final)\/(.+)$/.exec(url.pathname);
      if(!match)throw new Error();const room=await registry.resolve(match[1]),file=decodeURIComponent(match[4]);
      const directory=room.id==='platform'?path.join(root,'deliverables'):path.join(room.root,'outputs');
      const content=await readDeliverable(directory,match[2],match[3],file);
      const mime={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(file)]||'text/plain';
      res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(content);
    }catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('저장된 시제품 파일을 찾지 못했습니다.');}
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url))createPreviewServer().listen(3032,'127.0.0.1');
