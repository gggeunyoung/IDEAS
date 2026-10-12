import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../server.mjs';
import {saveSession,loadSession} from '../room-registry.mjs';
test('local server preserves fragmented Korean text and previous answer phase/model',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'ideas-session-text-'));
  const prior=[{speaker:'사용자',text:'예전 질문',mode:'subscription',workflow:'files'},{speaker:'GPT',text:'예전 수정본',mode:'subscription',workflow:'files',phase:'final',round:4,model:'verified model'}];await saveSession(root,prior);
  const server=createServer({env:{},projectRoot:root,artifactDir:path.join(root,'artifacts'),deliverableDir:path.join(root,'deliverables')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,text='한글 뒤에 남는 질문';const body=Buffer.from(JSON.stringify({mode:'demo',participants:['gpt'],review:false,history:[...prior.map(({speaker,text})=>({speaker,text})),{speaker:'사용자',text}]})),split=body.indexOf(Buffer.from('한글'))+1;
  const response=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/meeting',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(body.subarray(0,split));setTimeout(()=>req.end(body.subarray(split)),15);});assert.equal(response,200);
  const saved=await loadSession(root);assert.deepEqual(saved[1],prior[1]);assert.equal(saved[2].text,text);assert.ok(saved.at(-1).text.includes(text));
});
