import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {createPersistentSessions,sessionTtlMs} from '../persistent-sessions.mjs';
async function fixture(fn){const root=await mkdtemp(path.join(tmpdir(),'ideas-sessions-'));try{await fn(path.join(root,'sessions.json'));}finally{await rm(root,{recursive:true,force:true});}}
test('persistent sessions survive restart, store only hashes, and revoke durably on logout',()=>fixture(async file=>{
 let store=await createPersistentSessions({file,context:'owner-1'});const token=await store.create();assert.match(store.cookie(token),/HttpOnly; Secure; SameSite=Strict; Max-Age=2592000/);
 const disk=await readFile(file,'utf8');assert.ok(!disk.includes(token));assert.equal((await stat(file)).mode&0o777,0o600);
 store=await createPersistentSessions({file,context:'owner-1'});assert.equal((await store.authenticate(token)).valid,true);await store.revoke(token);
 store=await createPersistentSessions({file,context:'owner-1'});assert.equal((await store.authenticate(token)).valid,false);
}));
test('active sessions roll forward once daily, expire after inactivity, and invalidate on auth configuration change',()=>fixture(async file=>{
 let time=100000;const options={file,context:'owner-1',now:()=>time};let store=await createPersistentSessions(options);const token=await store.create();
 assert.deepEqual(await store.authenticate(token),{valid:true,renew:false});time+=24*3600000;assert.deepEqual(await store.authenticate(token),{valid:true,renew:true});
 assert.deepEqual(await store.authenticate(token),{valid:true,renew:false});time+=sessionTtlMs-1;store=await createPersistentSessions(options);assert.equal((await store.authenticate(token)).valid,true);
 store=await createPersistentSessions({...options,context:'new-owner-or-password'});assert.equal((await store.authenticate(token)).valid,false);
 time+=sessionTtlMs+1;store=await createPersistentSessions(options);assert.equal((await store.authenticate(token)).valid,false);
}));
test('concurrent session creation and logout preserve all remaining sessions across restart',()=>fixture(async file=>{
 let store=await createPersistentSessions({file,context:'owner'});const tokens=await Promise.all(Array.from({length:12},()=>store.create()));await Promise.all(tokens.slice(0,6).map(t=>store.revoke(t)));
 store=await createPersistentSessions({file,context:'owner'});assert.deepEqual(await Promise.all(tokens.map(async t=>(await store.authenticate(t)).valid)),tokens.map((_,i)=>i>=6));
}));
