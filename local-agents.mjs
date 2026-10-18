import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,access,stat,readdir} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalog} from './providers.mjs';
import {createActivityReporter} from './agent-activity.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const bundledCodex='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const codexFlags=['--no-daemon','--ask-for-approval','never',...['shell_tool','unified_exec','apps','plugins','multi_agent','browser_use','workspace_dependencies','skill_search'].flatMap(f=>['--disable',f])];

// Credentials stay in the account's own CLI storage. API credentials never reach a subscription child.
export function subscriptionEnv(env=process.env) {
  const allowed=['HOME','PATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SYSTEMROOT','APPDATA','LOCALAPPDATA','CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CLI_HOME','HTTPS_PROXY','HTTP_PROXY','NO_PROXY',
    'USERPROFILE','HOMEDRIVE','HOMEPATH','TEMP','TMP','SYSTEMDRIVE','WINDIR','COMSPEC','PATHEXT','PROGRAMDATA','PROGRAMFILES','CLAUDE_CODE_GIT_BASH_PATH'];
  return Object.fromEntries(allowed.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]]));
}
// Windows desktop apps keep their CLI in versioned folders; use the most recently installed copy.
export async function windowsExecutable(id,env=process.env){
  const found=[];
  const add=async file=>{try{const s=await stat(file);if(s.isFile())found.push({file,time:s.mtimeMs});}catch{}};
  const folders=async dir=>{try{return (await readdir(dir,{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>path.join(dir,e.name));}catch{return [];}};
  if(id==='gpt'&&env.LOCALAPPDATA)for(const dir of await folders(path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin')))await add(path.join(dir,'codex.exe'));
  if(id==='claude'){
    await add(path.join(env.USERPROFILE||homedir(),'.local','bin','claude.exe'));
    // The Store (MSIX) Claude app writes its AppData into a per-package folder that only the app sees as %APPDATA%.
    const roots=env.APPDATA?[path.join(env.APPDATA,'Claude','claude-code')]:[];
    if(env.LOCALAPPDATA)for(const pkg of await folders(path.join(env.LOCALAPPDATA,'Packages')))if(/^Claude_[a-z0-9]+$/i.test(path.basename(pkg)))roots.push(path.join(pkg,'LocalCache','Roaming','Claude','claude-code'));
    for(const base of roots)for(const version of await folders(base))for(const dir of await folders(version))await add(path.join(dir,'claude.exe'));
  }
  return found.sort((a,b)=>b.time-a.time)[0]?.file;
}
export async function executableFor(id,env=process.env,platform=process.platform) {
  const custom=env[{gpt:'LOCAL_CODEX_BIN',claude:'LOCAL_CLAUDE_BIN',gemini:'LOCAL_GEMINI_BIN'}[id]];
  if(custom) return custom;
  // npm .cmd shims cannot be spawned without a shell, so Windows uses the apps' own .exe files.
  if(platform==='win32')return await windowsExecutable(id,env)||{gpt:'codex',claude:'claude',gemini:'gemini'}[id];
  if(id==='gpt'){try{await access(bundledCodex);return bundledCodex;}catch{return 'codex';}}
  return path.join(root,'.local-tools','node_modules','.bin',id==='claude'?'claude':'gemini');
}

export function runProcess(command,args,{cwd,env,input='',signal,timeout=90000,limit=2_000_000,onStdout}={}) {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',bytes=0,reason,finished=false,killTimer;
    const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true});
    const kill=()=>{try{if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM');}catch{};
      killTimer=setTimeout(()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-child.pid,'SIGKILL');}catch{}},1500);killTimer.unref();};
    const abort=()=>{reason=new Error('로컬 AI 호출을 중단했습니다.');kill();};
    const timer=setTimeout(()=>{reason=new Error('로컬 AI 응답 시간이 초과됐습니다.');kill();},timeout);timer.unref();
    const cleanup=()=>{finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    child.on('error',()=>{cleanup();reject(new Error('CLI를 실행하지 못했습니다. 설치 경로를 확인하세요.'));});
    for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']]){stream.setEncoding('utf8');stream.on('data',chunk=>{
      bytes+=Buffer.byteLength(chunk);
      if(bytes>limit){if(!reason){reason=new Error('CLI 출력 한도를 초과했습니다.');kill();}return;}
      if(key==='stdout'){stdout+=chunk;onStdout?.(chunk);}else stderr+=chunk;
    });}
    child.on('close',code=>{if(finished)return;cleanup();if(reason)reject(reason);else resolve({stdout,stderr,code});});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  });
}

export function parseLocalAnswer(id,raw) {
  let text='',inputTokens,outputTokens,model,webSearchCount=0,webFetchCount=0;
  if(id==='gpt'){
    for(const line of raw.trim().split('\n')){
      let e;try{e=JSON.parse(line);}catch{continue;}
      if(e.type==='item.completed'&&e.item?.type==='agent_message')text+=`${text?'\n':''}${e.item.text||''}`;
      if(e.type==='item.completed'&&e.item?.type==='web_search')webSearchCount++;
      if(e.type==='turn.completed'){inputTokens=e.usage?.input_tokens;outputTokens=e.usage?.output_tokens;}
      if(e.type==='turn.failed'||e.type==='error')throw new Error('Codex 호출이 실패했습니다. 로그인·구독 한도·모델 설정을 확인하세요.');
    }
  }else{
    let data;try{data=JSON.parse(raw);}catch{
      const events=[];
      try{for(const line of raw.trim().split('\n'))if(line.trim())events.push(JSON.parse(line));}catch{throw new Error('CLI 응답 형식을 읽지 못했습니다. CLI 버전을 확인하세요.');}
      const seen=new Set();
      for(const e of events){if(e.type==='assistant')for(const c of e.message?.content||[]){if(c.type!=='tool_use'||seen.has(c.id))continue;seen.add(c.id);if(c.name==='WebSearch')webSearchCount++;if(c.name==='WebFetch')webFetchCount++;}}
      data=events.findLast(e=>e.type==='result');
      if(!data)throw new Error('CLI가 최종 답변을 반환하지 않았습니다. 검색 또는 생성 한도에 도달했을 수 있습니다.');
    }
    if(data.is_error||data.error)throw new Error('CLI가 오류를 반환했습니다. 로그인과 사용량 한도를 확인하세요.');
    text=id==='claude'?(data.structured_output?JSON.stringify(data.structured_output):data.result):data.response;
    const usage=data.usage||{};
    inputTokens=usage.input_tokens;outputTokens=usage.output_tokens;
    if(id==='gemini'){
      const models=Object.entries(data.stats?.models||{});
      model=models.map(([name])=>name).join(', ')||undefined;
      if(models.length){
        const inputs=models.map(([,m])=>m.tokens?.input??m.tokens?.prompt),outputs=models.map(([,m])=>Number.isFinite(m.tokens?.candidates)?m.tokens.candidates+(m.tokens.thoughts||0):undefined);
        if(inputs.every(Number.isFinite))inputTokens=inputs.reduce((a,b)=>a+b,0);
        if(outputs.every(Number.isFinite))outputTokens=outputs.reduce((a,b)=>a+b,0);
      }
    }
  }
  if(typeof text!=='string'||!text.trim())throw new Error('CLI가 텍스트 답변을 반환하지 않았습니다. 로그인·구독 한도를 확인하세요.');
  const sources=[];
  for(const match of text.matchAll(/https?:\/\/[^\s<>"\]\)]+/g)){
    const url=match[0].replace(/[.,;]+$/,'');
    try{const parsed=new URL(url);if(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&!sources.includes(parsed.href))sources.push(parsed.href);}catch{}
    if(sources.length===12)break;
  }
  return {text,inputTokens,outputTokens,model,webSearchCount,webFetchCount,sources};
}

export async function localStatus({env=process.env,runner=runProcess}={}) {
  const clean=subscriptionEnv(env);
  return Promise.all(catalog.map(async p=>{
    const command=await executableFor(p.id,env);
    const base={id:p.id,name:p.name,model:env[`LOCAL_${p.id.toUpperCase()}_MODEL`]||'CLI 기본 모델',ready:false,installed:false,verified:false};
    try{
      const version=await runner(command,['--version'],{env:clean,cwd:tmpdir(),timeout:12000,limit:50000});
      if(version.code!==0)throw new Error();
      base.installed=true;
      if(p.id==='gpt'){
        const auth=await runner(command,['login','status'],{env:clean,cwd:tmpdir(),timeout:12000,limit:50000});
        base.ready=auth.code===0&&/Logged in using ChatGPT/i.test(auth.stdout+auth.stderr);
        base.status=base.ready?'ChatGPT 구독 로그인 확인':'ChatGPT 계정 로그인 필요 (API 키 로그인은 사용하지 않음)';
      }else if(p.id==='claude'){
        const auth=await runner(command,['auth','status'],{env:clean,cwd:tmpdir(),timeout:12000,limit:50000});
        let data;try{data=JSON.parse(auth.stdout);}catch{data={};}
        base.ready=data.loggedIn===true&&data.authMethod==='claude.ai'&&data.apiProvider==='firstParty';
        base.status=base.ready?'Claude 구독 로그인 확인':'Claude 계정 로그인 필요';
      }else{
        const home=env.GEMINI_CLI_HOME||env.HOME||homedir();
        let settings;try{settings=JSON.parse(await readFile(path.join(home,'.gemini','settings.json'),'utf8'));}catch{settings={};}
        let tokenExists=false;try{await access(path.join(home,'.gemini','oauth_creds.json'));tokenExists=true;}catch{}
        const configured=settings.security?.auth?.selectedType==='oauth-personal'&&tokenExists;
        base.ready=false;
        base.status=configured?'Google 로그인 설정 확인 · 개인 구독 CLI 지원 종료':'개인 구독 CLI 지원 종료 · Antigravity 전환 필요';
      }
    }catch{base.status=base.installed?'로그인 상태 확인 실패':'CLI 설치 필요';}
    return base;
  }));
}

export async function callLocalAgent(id,prompt,{env=process.env,signal,runner=runProcess,webSearch=false,outputSchema,maxChars=1500,timeoutMs,onActivity}={}) {
  if(timeoutMs!=null&&(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000))throw new Error('CLI 호출 제한 시간이 올바르지 않습니다.');
  const p=catalog.find(p=>p.id===id);if(!p)throw new Error('알 수 없는 참가자입니다.');
  if(id==='gemini')throw new Error('Google 개인 계정의 Gemini CLI 지원이 종료됐습니다. 구독 연결은 Antigravity CLI로 전환해야 합니다. API로 대체하지 않았습니다.');
  const directory=await mkdtemp(path.join(tmpdir(),'ideas-agent-'));
  const clean=subscriptionEnv(env),command=await executableFor(id,env);
  const model=env[`LOCAL_${id.toUpperCase()}_MODEL`];
  let args;
  try{
    if(id==='gpt')args=[...codexFlags,'-c',`web_search="${webSearch?'live':'disabled'}"`,'exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never',...(model?['--model',model]:[]),'-'];
    else if(id==='claude')args=['--print','--output-format',webSearch?'stream-json':'json',...(webSearch?['--verbose','--allowedTools','WebSearch,WebFetch']:[]),'--tools',webSearch?'WebSearch,WebFetch':'','--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--safe-mode','--disable-slash-commands','--no-session-persistence','--setting-sources','','--settings','{"disableAllHooks":true,"forceLoginMethod":"claudeai"}','--max-turns',webSearch?'6':'1',...(model?['--model',model]:[])];
    const toolInstruction=webSearch?'필요한 조사에 웹 검색/웹 자료 확인 도구만 사용하세요. 검색은 최대 3회, 페이지 확인은 최대 3회로 제한하고 출처의 실제 URL을 답변에 적으세요. 원본 파일 접근·셸·수정 도구는 사용하지 마세요.':'도구를 호출하지 말고 제공된 자료만 사용하세요.';
    if(outputSchema){
      if(id==='gpt'){const schemaPath=path.join(directory,'output-schema.json');await writeFile(schemaPath,JSON.stringify(outputSchema),{mode:0o600});args.splice(args.length-1,0,'--output-schema',schemaPath);}
      else{args.push('--json-schema',JSON.stringify(outputSchema));args[args.indexOf('--max-turns')+1]='6';}
    }
    const result=await runner(command,args,{cwd:directory,env:clean,input:`${prompt.system}\n\n최종 답변은 최대 ${maxChars}자. ${toolInstruction}\n\n${prompt.user}`,signal,timeout:timeoutMs??(outputSchema?180000:webSearch?120000:90000),onStdout:createActivityReporter(id,onActivity)});
    if(result.code!==0)throw new Error(`${p.name} CLI 호출 실패. 계정 로그인·구독 한도·CLI 설정을 확인하세요. API로 대체하지 않았습니다.`);
    const parsed=parseLocalAnswer(id,result.stdout);
    if(outputSchema&&id==='gpt'){const items=result.stdout.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});parsed.text=items.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text||parsed.text;}
    return {provider:id,speaker:p.name,...parsed,webSearchEnabled:webSearch,model:parsed.model||model||`${p.name} CLI 기본 모델`,billing:'subscription',costUSD:null};
  }finally{await rm(directory,{recursive:true,force:true});}
}

// Team mode: the CLI works as an agent inside one project work tree. Codex keeps its OS sandbox
// (writes limited to the work tree, no network); Claude may edit there and run only the listed commands.
const codexTeamFlags=['--no-daemon','--ask-for-approval','never',...['apps','plugins','multi_agent','browser_use','workspace_dependencies','skill_search'].flatMap(f=>['--disable',f])];
const claudeTeamAllowed=['Read','Edit','Write','Glob','Grep','Bash(node:*)','Bash(npm test:*)','Bash(npm run:*)','Bash(git status:*)','Bash(git diff:*)','Bash(git log:*)','Bash(git show:*)'];
// --ignore-user-config also drops the Windows sandbox mode that the Codex app set up; carry over only that value.
export async function codexWindowsSandbox(env=process.env){
  let text;try{text=await readFile(path.join(env.CODEX_HOME||path.join(env.USERPROFILE||homedir(),'.codex'),'config.toml'),'utf8');}catch{return null;}
  let section='';
  for(const line of text.split(/\r?\n/)){
    const header=/^\s*\[([^\]]+)\]\s*$/.exec(line);if(header){section=header[1].trim();continue;}
    if(section==='windows'){const value=/^\s*sandbox\s*=\s*"([a-z_-]+)"\s*$/.exec(line)?.[1];if(value)return value;}
  }
  return null;
}
export function parseTeamTurn(id,raw){
  const usage={inputTokens:0,cachedInputTokens:0,outputTokens:0},actions={commands:0,edits:0};let text='',session,failed=false,network=false,model;
  if(id==='gpt'){
    let completed=false;
    for(const line of raw.trim().split('\n')){
      let e;try{e=JSON.parse(line);}catch{continue;}
      if(e.type==='thread.started')session=e.thread_id;
      if(e.type==='item.completed'&&e.item?.type==='agent_message')text=e.item.text||text;
      if(e.type==='item.completed'&&e.item?.type==='command_execution')actions.commands++;
      if(e.type==='item.completed'&&e.item?.type==='file_change')actions.edits+=e.item.changes?.length||1;
      if(e.type==='turn.completed'){completed=true;usage.inputTokens+=e.usage?.input_tokens||0;usage.cachedInputTokens+=e.usage?.cached_input_tokens||0;usage.outputTokens+=e.usage?.output_tokens||0;}
      if(e.type==='turn.failed')failed=true;
      if(/reconnecting|routing discovery|connection|timed out/i.test(e.message||e.error?.message||''))network=true;
    }
    // Reconnect warnings are reported as error events even when the turn later completes.
    if(!completed)failed=true;
  }else{
    let data;try{data=JSON.parse(raw);}catch{try{data=raw.trim().split('\n').map(line=>JSON.parse(line)).findLast(e=>e.type==='result');}catch{}if(!data)throw new Error('Claude CLI 응답 형식을 읽지 못했습니다. CLI 버전을 확인하세요.');}
    session=data.session_id;model=data.model;
    const u=data.usage||{};usage.inputTokens=(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);usage.cachedInputTokens=u.cache_read_input_tokens||0;usage.outputTokens=u.output_tokens||0;
    actions.turns=data.num_turns;
    if(data.structured_output)text=JSON.stringify(data.structured_output);
    else if(data.is_error&&data.subtype!=='error_max_turns')failed=true;
    else text=JSON.stringify({message:data.result||'작업 단계 한도에 도달해 요약 없이 차례를 마쳤습니다.',status:'continue',next:'',question:''});
  }
  if(failed)throw new Error(network?'네트워크 연결에 실패해 이번 차례를 진행하지 못했습니다. 인터넷 연결을 확인하세요.':'CLI가 차례를 완료하지 못했습니다. 로그인·구독 한도·CLI 설정을 확인하세요.');
  let report;try{report=JSON.parse(text);}catch{report={message:text||'요약 없이 차례를 마쳤습니다.',status:'continue',next:'',question:''};}
  if(!['continue','done','need_user'].includes(report.status))report.status='continue';
  for(const key of ['message','next','question'])report[key]=typeof report[key]==='string'?report[key].slice(0,4000):'';
  return {session,report,usage,actions,model};
}
export async function callTeamAgent(id,prompt,{cwd,session,env=process.env,signal,runner=runProcess,outputSchema,webSearch=false,timeoutMs=900000,platform=process.platform,onActivity}={}){
  if(!['gpt','claude'].includes(id))throw new Error('팀 모드는 GPT·Claude 구독 에이전트만 지원합니다.');
  const p=catalog.find(p=>p.id===id),clean=subscriptionEnv(env),command=await executableFor(id,env),model=env[`LOCAL_${id.toUpperCase()}_MODEL`];
  // Agents test with the same Node as the room server, even when a service or app PATH lacks it.
  clean.PATH=[path.dirname(process.execPath),clean.PATH].filter(Boolean).join(path.delimiter);
  const scratch=await mkdtemp(path.join(tmpdir(),'ideas-team-'));
  try{
    let args,claudeSession;
    if(id==='gpt'){
      const schemaPath=path.join(scratch,'output-schema.json');await writeFile(schemaPath,JSON.stringify(outputSchema),{mode:0o600});
      const windowsSandbox=platform==='win32'?await codexWindowsSandbox(env):null;
      args=[...codexTeamFlags,'-c',`web_search="${webSearch?'live':'disabled'}"`,...(windowsSandbox?['-c',`windows.sandbox="${windowsSandbox}"`]:[]),'exec','--ignore-user-config','--ignore-rules','--sandbox','workspace-write','--json','--color','never','-C',cwd,'--output-schema',schemaPath,...(model?['--model',model]:[]),...(session?['resume',session]:[]),'-'];
    }else{
      claudeSession=session||randomUUID();
      const tools=webSearch?[...claudeTeamAllowed,'WebSearch','WebFetch']:claudeTeamAllowed;
      args=['--print','--output-format','stream-json','--verbose','--include-partial-messages',session?'--resume':'--session-id',claudeSession,'--permission-mode','acceptEdits','--tools',`Read,Edit,Write,Glob,Grep,Bash${webSearch?',WebSearch,WebFetch':''}`,'--allowedTools',tools.join(','),'--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--safe-mode','--disable-slash-commands','--setting-sources','','--settings','{"disableAllHooks":true,"forceLoginMethod":"claudeai"}','--max-turns','80','--json-schema',JSON.stringify(outputSchema),...(model?['--model',model]:[])];
    }
    const result=await runner(command,args,{cwd,env:clean,input:`${prompt.system}\n\n${prompt.user}`,signal,timeout:timeoutMs,limit:20_000_000,onStdout:createActivityReporter(id,onActivity)});
    if(result.code!==0&&id==='claude')throw new Error(`${p.name} CLI 호출 실패. 계정 로그인·구독 한도·CLI 설정을 확인하세요. API로 대체하지 않았습니다.`);
    const parsed=parseTeamTurn(id,result.stdout);
    return {provider:id,speaker:p.name,...parsed,session:parsed.session||claudeSession||session,model:parsed.model||model||`${p.name} CLI 기본 모델`,billing:'subscription',costUSD:null};
  }finally{await rm(scratch,{recursive:true,force:true});}
}
