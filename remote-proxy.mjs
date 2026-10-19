import {createHash,timingSafeEqual} from 'node:crypto';
const sameSecret=(a,b)=>timingSafeEqual(createHash('sha256').update(String(a||'')).digest(),createHash('sha256').update(String(b||'')).digest());
export function workerAddress(value){const url=new URL(value);if(url.protocol!=='https:'||! /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('허용되지 않은 워커 주소입니다.');return url.origin;}
export function createRemoteProxy({env=process.env,fetchImpl=fetch,connectionStore}={}){
  let cached=null,cachedAt=0;
  const store=connectionStore||{
    async read(){const {get}=await import('@vercel/blob');const result=await get('ideas/worker-connection.json',{access:'private',useCache:false,storeId:env.BLOB_STORE_ID});if(result?.statusCode!==200)return null;return JSON.parse(await new Response(result.stream).text());},
    async write(value){const {put}=await import('@vercel/blob');await put('ideas/worker-connection.json',JSON.stringify(value),{access:'private',addRandomSuffix:false,allowOverwrite:true,storeId:env.BLOB_STORE_ID});}
  };
  const bodyOf=async req=>{let body;if(req.body!==undefined)body=typeof req.body==='string'?req.body:JSON.stringify(req.body);else{const chunks=[];let length=0;for await(const chunk of req){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>150000)throw new Error('요청이 너무 큽니다.');chunks.push(bytes);}body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}if(Buffer.byteLength(body)>150000)throw new Error('요청이 너무 큽니다.');return body;};
  return async function handler(req,res){
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    const incoming=new URL(req.url,'https://ideas-nine-opal.vercel.app');let route=incoming.searchParams.get('route');
    if(route===null&&incoming.pathname.startsWith('/api/')&&incoming.pathname!=='/api/remote')route=incoming.pathname.slice(5);
    if(!route||!/^((worker\/(register|health))|(auth\/(login|logout|status|config|google))|jobs(\/[0-9a-f-]{36}(\/cancel)?)?|rooms|github|config|files|session|deliverables(\/[0-9a-f-]{36}\/(draft|final)\/(file|bundle))?|artifacts\/[0-9a-f-]{36})$/.test(route))return send(404,{error:'경로를 찾을 수 없습니다.'});
    if(route==='auth/config'&&req.method!=='GET'||route==='auth/google'&&req.method!=='POST')return send(405,{error:'허용되지 않은 요청입니다.'});
    if(!['GET','POST'].includes(req.method))return send(405,{error:'허용되지 않은 요청입니다.'});
    const origin=env.IDEAS_PUBLIC_ORIGIN||'https://ideas-nine-opal.vercel.app';
    if(!env.IDEAS_BRIDGE_TOKEN)return send(503,{error:'원격 맥 연결이 아직 설정되지 않았습니다.'});
    if(route==='worker/health'&&(req.method!=='GET'||!sameSecret(req.headers.authorization,'Bearer '+env.IDEAS_BRIDGE_TOKEN)))return send(401,{error:'워커 인증이 필요합니다.'});
    if(route==='worker/register'){
      if(req.method!=='POST'||!sameSecret(req.headers.authorization,'Bearer '+env.IDEAS_BRIDGE_TOKEN)||!req.headers['content-type']?.startsWith('application/json'))return send(401,{error:'워커 인증이 필요합니다.'});
      try{const data=JSON.parse(await bodyOf(req));const url=workerAddress(data.url);const connection={url,registeredAt:new Date().toISOString()};await store.write(connection);cached=connection;cachedAt=Date.now();return send(200,{registered:true});}catch{return send(503,{error:'워커 연결 주소를 저장하지 못했습니다.'});}
    }
    if(req.method==='POST'&&(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json')))return send(403,{error:'같은 회의실 화면에서만 요청할 수 있습니다.'});
    if(!['auth/login','auth/config','auth/google','worker/health'].includes(route)&&!/\b__Host-ideas_session=[A-Za-z0-9_-]{43}(?:;|$)/.test(req.headers.cookie||''))return send(401,{error:'회의실에 로그인하세요.'});
    try{
      let address=env.IDEAS_WORKER_URL;
      if(env.BLOB_STORE_ID||connectionStore){if(!cached||Date.now()-cachedAt>20000){cached=await store.read();cachedAt=Date.now();}address=cached?.url;}
      if(!address)return send(503,{error:'맥 워커가 아직 연결되지 않았습니다. 맥에서 원격 서비스를 실행하세요.'});
      const worker=new URL(workerAddress(address));
      const target=new URL('/api/'+route,worker);for(const [key,value] of incoming.searchParams)if(['roomId','path','after'].includes(key))target.searchParams.set(key,value);
      let body;if(req.method==='POST')body=await bodyOf(req);
      const headers={Authorization:'Bearer '+env.IDEAS_BRIDGE_TOKEN,'Content-Type':'application/json',Cookie:req.headers.cookie||''};
      const response=await fetchImpl(target,{method:req.method,headers,body,redirect:'error',signal:AbortSignal.timeout(25000)});
      if(response.status>=500&&!response.headers.get('content-type')?.includes('application/json'))return send(503,{error:'맥 중계 연결을 복구하고 있습니다. 잠시 후 회의실 연결 다시 확인을 눌러 주세요.'});
      const safeHeaders={'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};for(const name of ['set-cookie','content-disposition'])if(response.headers.has(name))safeHeaders[name]=response.headers.get(name);
      res.writeHead(response.status,safeHeaders);res.end(Buffer.from(await response.arrayBuffer()));
    }catch{return send(503,{error:'맥 워커에 연결할 수 없습니다. 맥의 실행·인터넷·잠자기 상태를 확인하세요.'});}
  };
}
