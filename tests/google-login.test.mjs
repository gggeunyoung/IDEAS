import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {createGoogleLogin,loadGoogleSettings} from '../google-login.mjs';
const clientId='123456789-test.apps.googleusercontent.com',allowedEmail='owner@gmail.com';
const base={aud:clientId,iss:'https://accounts.google.com',sub:'google-owner-123',email:allowedEmail,email_verified:true,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000)};
function issue(login){const {body,cookie}=login.challenge();return {nonce:body.google.nonce,cookie:cookie.split(';')[0]};}
test('Google login is unavailable until both owner and client are configured; public config never reveals owner',async()=>{
  const disabled=createGoogleLogin({clientId});assert.deepEqual(disabled.challenge().body,{google:{enabled:false},password:true});await assert.rejects(disabled.authenticate('x',''),/아직/);
  const config=createGoogleLogin({clientId,allowedEmail}).challenge();assert.equal(config.body.google.clientId,clientId);assert.ok(!JSON.stringify(config).includes(allowedEmail));assert.match(config.cookie,/HttpOnly; Secure; SameSite=Strict/);
  assert.throws(()=>createGoogleLogin({clientId:'invalid',allowedEmail}));assert.deepEqual(await loadGoogleSettings('/nonexistent/ideas-google-test.json'),{});
});
test('verified owner can log in once; another browser, replay and stale challenge are rejected',async()=>{
  let time=Date.now(),payload;const login=createGoogleLogin({clientId,allowedEmail,now:()=>time,verifyToken:async()=>payload});const c=issue(login);payload={...base,nonce:c.nonce};
  await assert.rejects(login.authenticate('token',''),/만료/);assert.deepEqual(await login.authenticate('token',c.cookie),{sub:base.sub});await assert.rejects(login.authenticate('token',c.cookie),/만료/);
  const stale=issue(login);payload={...base,nonce:stale.nonce};time+=600001;await assert.rejects(login.authenticate('token',stale.cookie),/만료/);
});
test('wrong owner, unverified email, wrong nonce/audience/issuer, expired token and missing sub are rejected',async()=>{
  for(const override of [{email:'other@gmail.com'},{email_verified:false},{nonce:'wrong'},{aud:'wrong-client'},{iss:'https://evil.example'},{exp:0},{sub:''}]){
    let payload;const login=createGoogleLogin({clientId,allowedEmail,verifyToken:async()=>payload});const c=issue(login);payload={...base,nonce:c.nonce,...override};await assert.rejects(login.authenticate('token',c.cookie));
  }
  let payload;const pinned=createGoogleLogin({clientId,allowedEmail,allowedSub:'different-sub',verifyToken:async()=>payload});const c=issue(pinned);payload={...base,nonce:c.nonce};await assert.rejects(pinned.authenticate('token',c.cookie),/허용/);
});
test('official Google SDK verifies real signatures, audience and expiry before granting access',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const client=new OAuth2Client();
  client.getFederatedSignonCertsAsync=async()=>({certs:{'test-key':publicKey.export({format:'pem',type:'spki'})}});
  const sign=payload=>{const data=[{alg:'RS256',kid:'test-key'},payload].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return data+'.'+createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');};
  const login=createGoogleLogin({clientId,allowedEmail,verifyToken:async token=>(await client.verifyIdToken({idToken:token,audience:clientId})).getPayload()});
  const c=issue(login);assert.deepEqual(await login.authenticate(sign({...base,nonce:c.nonce}),c.cookie),{sub:base.sub});
  const forged=issue(login),token=sign({...base,nonce:forged.nonce});await assert.rejects(login.authenticate(token.slice(0,-8)+'AAAAAAAA',forged.cookie),/확인/);
  const wrongAud=issue(login);await assert.rejects(login.authenticate(sign({...base,nonce:wrongAud.nonce,aud:'wrong'}),wrongAud.cookie),/확인/);
});
test('challenge memory is bounded and expired challenges release capacity',()=>{
  let time=0;const login=createGoogleLogin({clientId,allowedEmail,now:()=>time});for(let i=0;i<512;i++)login.challenge();assert.throws(()=>login.challenge(),/많습니다/);time=600001;assert.ok(login.challenge().cookie);
});
