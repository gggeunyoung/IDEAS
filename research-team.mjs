import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const researchChecks={scope:'요청 범위·비교 기준',evidence:'출처·확인일이 있는 근거',alternatives:'대상·대안 비교',challenge:'상대 주장 반박·검증',refinement:'반론 반영·새 아이디어 검토',proposal:'추천 기획·검증 방법·남은 질문'};
export const researchReportSchema={type:'object',additionalProperties:false,required:['delta','checks'],properties:{delta:{type:'string'},checks:{type:'object',additionalProperties:false,required:Object.keys(researchChecks),properties:Object.fromEntries(Object.keys(researchChecks).map(k=>[k,{type:'boolean'}]))}}};
export function researchInstructions(){return `\n이번 팀은 리서치·기획을 위한 자율 협업입니다. 코딩하지 않거나 이번 차례에 파일을 바꾸지 않아도 근거·반론·판단이 발전하면 유효한 진전입니다.
- 첫 차례에는 사용자 요청을 완료 기준과 조사 질문으로 풀고 다음 차례부터 실제 조사를 수행하세요. 비교 대상·대상 고객을 빠뜨리지 마세요.
- 조사 → 여러 대안 제시 → 상대 반론·출처 확인 → 보완 → 기획 정리를 반복하세요. 좋은 새 방향이 나오면 원래 목표와 비교해 근거를 조사하고 채택/보류 이유를 남기세요. 단순 동의·요약을 주고받지 마세요.
- 사용자에게는 매번 지금 다루는 문제와 구체적 해결안부터 설명하세요. 예를 들어 누가 어떤 순간에 막히고, 어떤 화면/절차로 달라지며, 사용자와 사업에 어떤 가치가 있는지 연결하세요. 후보의 내부 기호·출처 번호만으로 설명하지 말고 내용과 직접 URL을 풀어 적으세요.
- 근거 부족이라는 지적만 반복하며 후보를 없애지 마세요. 무엇까지 말할 수 있는지, 대안은 무엇인지, 지금 가능한 추가 조사는 무엇인지 제시하고 실제로 진행하세요. '이번 조사에서 검증한 후보가 없다'를 '그 대상에게 개선 수요가 없다'로 일반화하지 마세요. 근거 없는 아이디어는 가설로 표시하고 사실처럼 꾸미지 마세요.
- 날짜가 중요한 주장·앱 기능·이용 조건·통계는 웹 검색/페이지 확인으로 검증하세요. 공식 자료를 우선하고 고객 후기·추정·직접 실측을 구분하세요. 직접 써 보지 않은 앱을 사용했다고 말하지 마세요. 출처가 막히면 다른 자료를 찾고 확인 불가 부분을 명시하세요.
- research/sources.md에 출처 URL·확인 날짜·무엇을 뒷받침하는지, research/analysis.md에 비교·대안·반론·수정 근거, research/proposal.md에 추천안·선정 이유·최소 기능·검증 방법·미해결 질문을 누적 저장하세요. 세 파일은 처음부터 완성할 필요가 없습니다. 웹 공유용 요약은 각 문서1만자 이하로 정리하고 더 긴 원자료·노트는 다른 파일에 보존하세요.
- research.checks는 이번까지 직접 검토한 항목만 true로 보고하세요. 상대가 true라고 쓴 것만으로 동의하지 마세요. 기준: ${Object.entries(researchChecks).map(([k,v])=>k+'='+v).join(', ')}.
- research.delta에는 이번에 새로 확인한 근거·반론·수정한 판단을 구체적으로 적으세요. 같은 말을 바꿔 쓰는 것은 진전이 아닙니다.
- 최소6차례와 두 사람의 완료 기준 확인, 실제 저장 자료를 통과하기 전에는 완료로 끝나지 않습니다. 차례 수를 채우기 위한 형식적 동의는 하지 마세요. 미확인 범위를 숨긴 채 전부 조사했다고 말하지 마세요.
- 예산의 마지막2차례에는 현재까지의 조사·기획 파일을 정리하고 남은 조사 질문·이어서 할 일을 저장하세요. 예산 소진은 완료가 아닙니다. 사용자 결정이 꼭 필요하지 않으면 가정을 밝히고 계속하세요.\n`;}
export async function researchArtifacts(workspace){
  const root=await realpath(workspace),missing=[];let sources='';
  for(const name of ['sources.md','analysis.md','proposal.md']){
    const relative='research/'+name;
    try{const file=await realpath(path.join(root,relative));if(!file.startsWith(root+path.sep))throw new Error();const text=await readFile(file,'utf8');if(text.trim().length<150)throw new Error();if(text.length>10000)missing.push(relative+' 공유 요약을 1만자 이하로 정리');if(name==='sources.md')sources=text;}
    catch{missing.push(relative);}
  }
  const links=new Set((sources.match(/https?:\/\/[^\s<>)\]]+/g)||[]));if(links.size<2)missing.push('서로 다른 출처 URL 2개 이상');
  return missing;
}
export function recordResearchProgress(state,id,report,changed){
  state.research??={checks:{},fingerprints:{},repeated:0,feedback:''};const progress=state.research;
  progress.checks[id]=Object.fromEntries(Object.keys(researchChecks).map(k=>[k,report.research?.checks?.[k]===true]));
  const fingerprint=createHash('sha256').update([report.message,report.next,report.research?.delta||''].join('\n').replace(/\s+/g,' ').trim()).digest('hex');
  progress.repeated=!changed&&progress.fingerprints[id]===fingerprint?progress.repeated+1:0;progress.fingerprints[id]=fingerprint;
  const unchecked=Object.keys(researchChecks).filter(k=>!['gpt','claude'].every(agent=>progress.checks[agent]?.[k]));
  return {unchecked,repeated:progress.repeated};
}

export async function researchSnapshot(workspace){
  const root=await realpath(workspace),files=[];
  for(const name of ['sources.md','analysis.md','proposal.md']){
    try{const relative='research/'+name,file=await realpath(path.join(root,relative));if(!file.startsWith(root+path.sep))continue;const content=await readFile(file,'utf8');if(content.trim())files.push({path:relative,content});}catch{}
  }
  return files;
}
