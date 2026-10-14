import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {OAuth2Client} from 'google-auth-library';
const digest=value=>createHash('sha256').update(String(value||'')).digest();
const same=(a,b)=>timingSafeEqual(digest(a),digest(b));
export async function loadGoogleSettings(file){
  try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw new Error('Google 로그인 설정 파일을 확인하세요.');}
}
export function createGoogleLogin({clientId='',allowedEmail='',allowedSub='',verifyToken,now=Date.now}={}){
  const enabled=Boolean(clientId&&allowedEmail);
  if(enabled&&(!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)||!/^\S+@\S+\.\S+$/.test(allowedEmail)))throw new Error('Google 클라이언트 ID와 허용 이메일을 확인하세요.');
  const client=new OAuth2Client({clientId,transporterOptions:{timeout:10000}});
  const verify=verifyToken||(async credential=>(await client.verifyIdToken({idToken:credential,audience:clientId})).getPayload());
  const challenges=new Map();
  const clean=()=>{for(const [id,data] of challenges)if(data.expires<=now())challenges.delete(id);};
  return {
    enabled,
    challenge(){
      if(!enabled)return {body:{google:{enabled:false},password:true}};
      clean();if(challenges.size>=512){const error=new Error('로그인 요청이 많습니다. 잠시 후 다시 시도하세요.');error.status=429;throw error;}
      const id=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');challenges.set(id,{nonce,expires:now()+600000});
      return {body:{google:{enabled:true,clientId,nonce},password:true},cookie:`__Host-ideas_google=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`};
    },
    async authenticate(credential,cookie){
      if(!enabled){const error=new Error('Google 로그인이 아직 설정되지 않았습니다.');error.status=503;throw error;}
      const id=/\b__Host-ideas_google=([A-Za-z0-9_-]{43})(?:;|$)/.exec(cookie||'')?.[1];
      const challenge=id&&challenges.get(id);if(id)challenges.delete(id);clean();
      if(!challenge||challenge.expires<=now()||typeof credential!=='string'||credential.length>16000)throw new Error('로그인 요청이 만료됐습니다. 새로고침 후 다시 시도하세요.');
      let payload;try{payload=await verify(credential);}catch{throw new Error('Google 인증을 확인하지 못했습니다. 다시 시도하세요.');}
      // Verify the provider signature/audience/issuer/expiry in the official SDK; enforce them
      // here too so custom verification adapters cannot bypass the owner and nonce checks.
      if(!payload||payload.aud!==clientId||!['accounts.google.com','https://accounts.google.com'].includes(payload.iss)||!Number.isFinite(payload.exp)||payload.exp*1000<=now()||payload.email_verified!==true||!payload.sub||!same(payload.nonce,challenge.nonce))throw new Error('Google 인증 정보가 올바르지 않습니다. 다시 로그인하세요.');
      if(typeof payload.email!=='string'||payload.email.toLowerCase()!==allowedEmail.toLowerCase()||(allowedSub&&payload.sub!==allowedSub))throw new Error('이 회의실에 허용된 Google 계정이 아닙니다.');
      // For a non-Gmail account Google must be authoritative for the email domain.
      if(!payload.email.toLowerCase().endsWith('@gmail.com')&&!payload.hd)throw new Error('Google에서 관리하는 Gmail 또는 Workspace 계정이 필요합니다.');
      return {sub:payload.sub};
    }
  };
}
