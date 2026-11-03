import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';

export const projectGuidePath='docs/PROJECT_GUIDE.md';
export const collaborationPolicyInfo={version:1,understandingDefault:true,independentPlans:true,guidePath:projectGuidePath};
export const guideSections=['목표와 완료 조건','구조와 데이터 흐름','핵심 로직','설계 선택과 대안','실행과 검증','한계와 다음 단계','직접 확인할 질문'];

export function understandingInstructions(){return `
사용자 이해 원칙 (모든 프로젝트의 기본값)
- 사용자는 결과물을 소유하고 핵심 아키텍처·구성요소·로직을 자기 말로 설명할 수 있어야 합니다. 동작만 하는 코드를 남기는 것으로 끝내지 마세요.
- 중요한 변경을 설명할 때 해결한 문제 → 구성요소와 역할 → 입력부터 출력까지의 흐름 → 핵심 로직 → 선택 이유와 대안 → 직접 확인하는 방법을 연결하세요. 파일 이름 나열로 설명을 대신하지 마세요.
- 낯선 용어는 처음에 풀어 쓰고, 작은 실제 입력·출력 예시로 로직을 설명하세요. 이전 대화를 읽지 않아도 이해되게 쓰되 매번 전체 설명을 복사하지 마세요.
- 아키텍처 변경·외부 서비스·새 의존성·데이터 저장 방식에는 선택 이유, 다른 대안, 단점과 변경 영향을 남기세요. 사용자가 확정한 범위 밖의 중요한 결정을 임의로 확정하지 마세요.
- 사용자에게 읽고 답해야 할 시험을 강요하거나, 설명 확인을 기다리느라 가능한 작업을 멈추지 마세요. 직접 확인해 볼 질문과 작은 수정 실습, 예상 결과를 제공하세요. 설명을 제공한 것과 사용자가 이해를 확인한 것은 다릅니다.
- 보고에는 사용자가 알아야 할 핵심 설명을 포함하고 상세 실행 로그와 구분하세요. 실행하지 않은 검사나 사용자의 이해를 확인했다고 주장하지 마세요.
`;}

export function collaborationInstructions(){return `
기본 협업 원칙
- 공동 목표는 실제 결과물을 완성하는 것입니다. 요청을 사용자가 할 수 있게 될 일과 관찰 가능한 완료 조건으로 구체화하세요. 가정은 밝히고 사용자 기준을 임의로 낮추지 마세요.
- 실행기가 먼저 두 사람의 독립 접근법·위험·검증 계획을 읽기 전용으로 수집합니다. 두 제안을 비교한 뒤 가장 작은 실행 가능한 결과부터 만들고, 구현자와 검증자의 역할을 작업에 맞게 정하세요.
- 구현자는 파일을 수정하고 실행합니다. 검증자는 누락·반례·실패 경로를 직접 확인합니다. 검토에는 문제·재현 근거·영향·수정 제안을 포함하세요. 이견은 테스트·실험·출처로 해결하고 형식적인 동의나 반대를 만들지 마세요.
- 같은 파일은 한 번에 한 명만 수정합니다. 실행기가 교대로 호출하므로 차례 밖의 백그라운드 작업을 시작하지 마세요.
- 예산 안에서 구현 가능한 일이 남으면 제안만 하고 종료하지 마세요. 완료 조건을 직접 확인하면 done을 제안하세요. 예산·실제 장애·현장 검증 때문에 멈추면 산출물과 남은 일을 저장하세요.
- 중요한 구현·설계 변경 뒤에는 ${projectGuidePath}를 갱신하세요. 웹 공유를 위해 핵심 설명은 16,000자 이내로 정리하고 긴 참고 자료는 분리하세요. 다음 제목을 사용하고 현재 프로젝트의 실제 내용으로 채우세요: ${guideSections.map(s=>'## '+s).join(' / ')}.
- 이해 가이드에는 실제 파일·구성요소, 데이터 흐름, 핵심 함수나 알고리즘의 입력·출력 예시, 대안과 선택 이유, 실행 명령과 실제 검증/미검증 범위, 사용자가 해볼 작은 변경과 예상 결과를 남기세요. 리서치·기획은 시스템 구현을 꾸며내지 말고 문제 구조·근거에서 판단까지의 논리·대안·검증법을 설명하세요.
- 완료를 제안하기 전에 상대 작업과 이해 가이드를 실제로 읽고 확인하세요. 가이드의 존재·형식 검사는 내용의 정확성이나 사용자 이해의 증명이 아닙니다.
${understandingInstructions()}`;}

export async function projectGuideIssues(workspace){
  try{
    const root=await realpath(workspace),file=await realpath(path.join(root,projectGuidePath));
    if(!file.startsWith(root+path.sep))return [projectGuidePath+' (작업 폴더 안에 저장 필요)'];
    const text=await readFile(file,'utf8');
    if(text.length>16000)return [projectGuidePath+' (웹 공유를 위해 핵심 설명을 16,000자 이하로 정리)'];
    return guideSections.filter(title=>{
      const marker='## '+title,lines=text.split(/\r?\n/),start=lines.findIndex(line=>line.trim()===marker);
      if(start<0)return true;
      let end=lines.findIndex((line,i)=>i>start&&/^#{1,2}\s/.test(line));if(end<0)end=lines.length;
      return lines.slice(start+1,end).join('\n').trim().length<20;
    }).map(title=>projectGuidePath+': '+title+' 설명 보강');
  }catch{return [projectGuidePath+' 작성 필요'];}
}

export async function projectGuideSnapshot(workspace){
  const root=await realpath(workspace),file=await realpath(path.join(root,projectGuidePath));
  if(!file.startsWith(root+path.sep))throw new Error('이해 가이드가 작업 폴더 밖을 가리킵니다.');
  return {path:projectGuidePath,content:await readFile(file,'utf8')};
}
