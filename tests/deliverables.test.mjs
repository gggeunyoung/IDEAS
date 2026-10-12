import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {parseBundle,listDeliverables,readDeliverable} from '../deliverables.mjs';
import {runMeeting,validateRequest} from '../room.mjs';
import {createServer} from '../server.mjs';
const fixture=async fn=>{const dir=await mkdtemp(path.join(tmpdir(),'ideas-files-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}};
const request={mode:'subscription',participants:['gpt','claude'],review:true,workflow:'files',writer:'gpt',webSearch:false,files:[],history:[{speaker:'사용자',text:'제공된 자료로 소개 문서를 만들어줘'}]};
const bundle=content=>JSON.stringify({summary:'작성 요약',files:[{path:'portfolio.md',content}]});
const mock=(calls,{failReview=false,failFinal=false}={})=>async(id,prompt,options)=>{
  const phase=options.outputSchema?(prompt.user.includes('최종 수정본')?'final':'draft'):prompt.user.includes('실제 파일 전체')?'review':'plan';calls.push({id,phase});
  if(phase==='review'){assert.equal(id,'claude');assert.ok(prompt.user.includes('초안 내용'));if(failReview)throw new Error('검토 실패');}
  if(phase==='final'){assert.equal(id,'gpt');assert.ok(prompt.user.includes('수정 지시'));if(failFinal)throw new Error('수정 실패');}
  return {provider:id,speaker:id==='gpt'?'GPT':'Claude',text:phase==='draft'?bundle('초안 내용'):phase==='final'?bundle('수정 내용'):phase==='review'?'수정 지시':'작업 계획',billing:'subscription'};
};
test('파일 결과는 경로 탈출·설정 파일·중복·비밀정보·과대 내용을 거절함',()=>{
  for(const name of ['../outside.md','/tmp/outside.md','.env','a/../../evil.md','x\\bad.md','secret.txt','a/.git/config.json','bad.sh'])assert.throws(()=>parseBundle(JSON.stringify({summary:'s',files:[{path:name,content:'x'}]})));
  assert.throws(()=>parseBundle(JSON.stringify({summary:'s',files:[{path:'x.md',content:'x'},{path:'X.md',content:'y'}]})));
  assert.throws(()=>parseBundle(JSON.stringify({summary:'s',files:[{path:'x.md',content:'x'},{path:'x.md/child.md',content:'y'}]})));
  assert.throws(()=>parseBundle(bundle('-----BEGIN PRIVATE KEY-----')));
  assert.throws(()=>parseBundle(bundle('x'.repeat(16001))));
  assert.equal(parseBundle('```json\n'+bundle('확인된 내용')+'\n```').files[0].content,'확인된 내용');
});
test('파일 협업은 한 작성자 → 다른 AI 검토 → 동일 작성자 수정의 5회 호출로 원본을 보존함',async()=>fixture(async dir=>{
  const original=path.join(dir,'original.md');await writeFile(original,'원본');const results=path.join(dir,'results'),calls=[],events=[];
  await runMeeting(request,e=>events.push(e),{deliverableDir:results,context:'검증된 프로젝트 자료',invokeLocal:mock(calls)});
  assert.deepEqual(calls.slice(2),[{id:'gpt',phase:'draft'},{id:'claude',phase:'review'},{id:'gpt',phase:'final'}]);
  assert.equal(calls.length,5);assert.equal(await readFile(original,'utf8'),'원본');
  const outputs=events.filter(e=>e.type==='deliverable');assert.equal(outputs.length,2);const id=outputs[0].id;
  assert.equal(await readDeliverable(results,id,'draft','portfolio.md'),'초안 내용');assert.equal(await readDeliverable(results,id,'final','portfolio.md'),'수정 내용');
  assert.match(await readFile(path.join(results,id,'review.md'),'utf8'),/수정 지시/);
  assert.equal((await listDeliverables(results))[0].status,'revised');assert.equal(events.at(-1).type,'done');
}));
test('검토 또는 수정 실패 시 초안을 유지하고 최종 수정본으로 표시하지 않음',async()=>fixture(async dir=>{
  for(const failure of [{failReview:true},{failFinal:true}]){
    const root=path.join(dir,Object.keys(failure)[0]),events=[];
    await runMeeting(request,e=>events.push(e),{deliverableDir:root,invokeLocal:mock([],failure)});
    const output=events.find(e=>e.type==='deliverable');assert.ok(output);assert.equal(await readDeliverable(root,output.id,'draft','portfolio.md'),'초안 내용');
    await assert.rejects(readDeliverable(root,output.id,'final'));assert.equal(events.filter(e=>e.type==='deliverable').length,1);assert.ok(events.some(e=>e.type==='notice'));
  }
}));
test('파일 협업에서 단일 참가자·API 모드·검토 끄기는 거절함',()=>{
  for(const changes of [{participants:['gpt']},{mode:'live'},{review:false}])assert.throws(()=>validateRequest({...request,...changes}),/파일 협업/);
});
test('HTTP 파일 협업 결과 목록·초안·수정본 다운로드와 경로 제한을 검증함',async()=>fixture(async dir=>{
  const deliverableDir=path.join(dir,'results');const server=createServer({env:{},projectRoot:dir,artifactDir:path.join(dir,'artifacts'),deliverableDir,status:async()=>[{id:'gpt',ready:true},{id:'claude',ready:true}],invokeLocal:mock([])});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  try{
    const response=await fetch(url+'/api/meeting',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify(request)});
    const events=(await response.text()).trim().split('\n').map(JSON.parse);const output=events.filter(e=>e.type==='deliverable').at(-1);assert.ok(output);
    const listing=await (await fetch(url+'/api/deliverables')).json();assert.equal(listing.items[0].id,output.id);
    const file=await fetch(url+output.files[0].url);assert.equal(await file.text(),'수정 내용');assert.match(file.headers.get('content-disposition'),/attachment/);
    assert.equal((await (await fetch(url+output.url)).json()).files[0].path,'portfolio.md');
    assert.equal((await fetch(url+output.files[0].url.replace('portfolio.md','..%2F.env'))).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
}));
