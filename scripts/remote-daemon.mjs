import {mkdir,writeFile,rm,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin')throw new Error('이 서비스 설치는 macOS용입니다.');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),label='com.gggeunyoung.ideas-remote',domain=`gui/${process.getuid()}`,directory=path.join(os.homedir(),'Library','LaunchAgents'),file=path.join(directory,label+'.plist');
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const command=process.argv[2]||'status';
if(command==='install'){
  await access(path.join(root,'.local-tools','cloudflare','cloudflared'));
  await mkdir(directory,{recursive:true});await mkdir(path.join(root,'.runtime'),{recursive:true,mode:0o700});
  try{await access(file);throw new Error('이미 설치된 서비스입니다. 상태를 확인하세요.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const args=['/usr/bin/caffeinate','-i','-s',process.execPath,'--env-file-if-exists='+path.join(root,'.env'),path.join(root,'scripts','remote-service.mjs')];
  const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg=>`<string>${xml(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(root,'.runtime','remote-service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(root,'.runtime','remote-service-error.log'))}</string></dict></plist>`;
  await writeFile(file,plist,{mode:0o600,flag:'wx'});execFileSync('launchctl',['bootstrap',domain,file]);console.log('맥 로그인 시 자동 실행하는 IDEAS 원격 서비스를 설치했습니다. 서비스 실행 중 자동 잠자기를 방지합니다. 덮개 닫힘·수동 잠자기·종료는 막지 않습니다.');
}else if(command==='remove'){
  execFileSync('launchctl',['bootout',`${domain}/${label}`]);await rm(file);console.log('자동 실행 서비스를 중단하고 등록을 제거했습니다. 프로젝트와 인증 설정은 보존됩니다.');
}else if(command==='status'){
  const output=execFileSync('launchctl',['print',`${domain}/${label}`],{encoding:'utf8'});console.log(output.split('\n').filter(line=>/state =|pid =|last exit code/.test(line)).join('\n'));
}else throw new Error('install, status, remove 중 선택하세요.');
