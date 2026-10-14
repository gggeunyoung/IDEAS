import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {localStatus,executableFor,subscriptionEnv,windowsExecutable} from '../local-agents.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),action=process.argv[2];
async function interactive(command,args,env=process.env){
  const child=spawn(command,args,{cwd:root,env,stdio:'inherit',shell:false});
  process.exitCode=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('close',code=>resolve(code??1));});
}
if(action==='install'&&process.platform==='win32'){
  // Windows uses the .exe CLIs shipped with the Codex/Claude desktop apps or the native Claude Code installer.
  for(const [id,name] of [['gpt','Codex'],['claude','Claude']]){const found=await windowsExecutable(id);console.log(`${name} CLI: ${found||'찾지 못함'}`);}
  console.log('찾지 못한 CLI는 데스크톱 앱을 설치하거나 .env에 LOCAL_CODEX_BIN / LOCAL_CLAUDE_BIN 경로를 지정하세요.');
}else if(action==='install'){
  await mkdir(path.join(root,'.local-tools'),{recursive:true});
  await interactive('npm',['install','--prefix',path.join(root,'.local-tools'),'--no-audit','--no-fund','@anthropic-ai/claude-code@2.1.296','@google/gemini-cli@0.63.0']);
}else if(action==='doctor'){
  for(const p of await localStatus())console.log(`${p.name}: ${p.status}`);
}else if(['gpt','claude','gemini'].includes(action)){
  if(action==='gemini'){
    console.error('Google 개인 계정의 Gemini CLI 지원은 종료됐습니다. 재로그인으로 해결되지 않습니다. Antigravity CLI 연결이 필요합니다.');
    console.error('공식 안내: https://github.com/google-gemini/gemini-cli/discussions/28017');
    process.exit(1);
  }
  const command=await executableFor(action);
  // Clear API env for login too; the user chooses the account in the official interactive flow.
  await interactive(command,action==='claude'?['auth','login','--claudeai']:action==='gpt'?['login']:[],subscriptionEnv());
}else{console.error('사용법: local-tools.mjs install|doctor|gpt|claude|gemini');process.exitCode=1;}
