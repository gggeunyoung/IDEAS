import {randomBytes,createHash} from 'node:crypto';
import {readFile,chmod} from 'node:fs/promises';
import {atomicJson} from './room-registry.mjs';
export const sessionTtlMs=30*24*3600000;
const digest=token=>createHash('sha256').update(token).digest('hex');
export async function createPersistentSessions({file,context,now=Date.now,ttlMs=sessionTtlMs,renewEveryMs=24*3600000,maxSessions=30}){
  const entries=new Map();let queue=Promise.resolve();
  try{
    await chmod(file,0o600);const data=JSON.parse(await readFile(file,'utf8'));
    if(data?.version===1&&data.context===context&&Array.isArray(data.sessions))for(const row of data.sessions){
      if(!Array.isArray(row)||row.length!==2)continue;const [key,expires]=row;
      if(typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)&&Number.isFinite(expires)&&expires>now()&&expires<=now()+ttlMs&&entries.size<maxSessions)entries.set(key,expires);
    }
  }catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const clean=()=>{for(const [key,expires] of entries)if(expires<=now())entries.delete(key);};
  const save=()=>atomicJson(file,{version:1,context,sessions:[...entries]});
  const serial=action=>{const work=queue.then(action);queue=work.catch(()=>{});return work;};
  const keyOf=token=>typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token)?digest(token):null;
  return {
    cookie(token){return `__Host-ideas_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlMs/1000)}`;},
    create(){return serial(async()=>{clean();if(entries.size>=maxSessions){const error=new Error('로그인 세션이 너무 많습니다. 다른 기기에서 로그아웃해 주세요.');error.status=429;throw error;}
      const token=randomBytes(32).toString('base64url'),key=digest(token);entries.set(key,now()+ttlMs);
      try{await save();}catch(error){entries.delete(key);throw error;}return token;
    });},
    async authenticate(token){
      const key=keyOf(token),expires=key&&entries.get(key);if(!expires||expires<=now()){if(key)entries.delete(key);return {valid:false};}
      if(expires-now()>ttlMs-renewEveryMs)return {valid:true,renew:false};
      return serial(async()=>{
        const current=entries.get(key);if(!current||current<=now())return {valid:false};
        if(current-now()>ttlMs-renewEveryMs)return {valid:true,renew:false};
        entries.set(key,now()+ttlMs);try{await save();}catch(error){entries.set(key,current);throw error;}return {valid:true,renew:true};
      });
    },
    revoke(token){return serial(async()=>{const key=keyOf(token);if(key&&entries.delete(key))await save();});}
  };
}
