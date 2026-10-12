# Vercel 연결 절차

## 2026-10-13 현재 상태

기존 https://ideas-nine-opal.vercel.app/ 에 웹 화면과 인증된 API 중계를 배포했다. 회의실 비밀번호로 로그인하면 맥의 방 목록·대화·결과를 읽고 GPT·Claude에 실제 회의 요청을 전달한다. 원격 경로에서 독립 제안 2회와 상호 검토 2회를 확인했다.

현재 구성과 실행·해제·재연결은 [원격 연결 운영 문서](remote-connection.md)를 읽는다. npm ci로 원격 중계 의존성을 설치하고 api/remote.js도 배포한다. Vercel production 환경에는 중계 인증키와 비공개 Blob 저장소 ID, 공개 웹 origin을 설정한다. 구독 로그인이나 API 키를 옮기지 않는다.

아래는 원격 연결 전에 수행한 1단계 배포 기록이다. ‘원격 미연결’ 설명은 당시의 상태이며 현재는 위 구성으로 변경됐다.

## 초기 웹 화면 배포 기록

2026-10-12 웹 화면 배포 완료: [IDEAS 배포 화면](https://ideas-nine-opal.vercel.app/). GitHub `gggeunyoung/IDEAS`의 master와 기존 Vercel Hobby 팀을 연결했습니다.

현재 배포는 **웹 화면만** 올리는 1단계입니다. 맥에서 구독으로 로그인한 Codex/Claude Code를 실행하는 서버는 Vercel 정적 웹 화면에 포함되지 않습니다. 원격 AI 서버를 연결하기 전에는 배포 화면의 AI 호출을 비활성화하고 미연결 상태를 명시합니다.

## GitHub → Vercel 웹 화면

1. Vercel 기존 계정에 로그인합니다. 신규 계정의 가입·약관 동의는 사용자가 직접 진행합니다.
2. New Project → Import Git Repository에서 GitHub의 `gggeunyoung/IDEAS`를 선택합니다.
3. 저장소가 없으면 GitHub 앱 권한에 IDEAS 저장소를 추가합니다. 필요한 저장소만 허용합니다.
4. 설정은 Framework Preset **Other**, Root Directory **저장소 루트**, Build Command **npm run build:static**, Output Directory **dist**, Install Command **빈 값(Override)**입니다. 루트의 `vercel.json`에 설정을 준비했습니다. 빌드는 public의 HTML/JS/CSS 세 파일만 dist로 복사하며 정적 배포임을 표시합니다.
5. 환경 변수는 이 단계에서 추가하지 않습니다. API 키나 맥의 CLI 로그인 토큰을 Vercel에 옮기지 않습니다.
6. Deploy를 누르고 생성된 URL을 확인합니다. 이 단계의 결과는 AI 서버 미연결 상태의 웹 화면입니다.
7. 연결 이후 GitHub push에 따른 자동 배포를 사용할 수 있습니다. 현재 작업 브랜치는 master입니다. Production Branch도 master인지 확인합니다.

## 실제 AI 협업을 원격에서 사용하기 위한 2단계

구현할 흐름은 **Vercel 웹 → 사용자 인증 → 작업 큐/결과 저장 → 맥 워커 → Codex·Claude Code**입니다.

- 웹 사용자는 인증 후 작업을 제출합니다.
- 맥 워커는 바깥으로 연결해 본인의 작업만 받고, 맥의 CLI로 처리합니다.
- 웹은 결과를 조회하고 취소·재연결을 처리합니다.
- 구독 인증과 프로젝트 원본 파일은 맥에 둡니다.
- 현재 localhost Node 서버를 그대로 공개하거나 포트포워딩하는 것으로 이 구조가 완성되지는 않습니다.
- 원격 인증·작업 큐·맥 워커 연결은 아직 구현하지 않았습니다. 현재 Vercel 화면에서 AI 회의가 된다고 주장하지 않습니다.

Vercel Functions는 읽기 전용 파일시스템과 임시 /tmp를 사용하는 실행 환경입니다. 현재의 macOS 번들 CLI, 로그인 저장소, 지속 서버, 로컬 결과 파일에 의존하는 구성을 그대로 옮기는 배포는 지원하지 않습니다. 맥 없이 운영하려면 별도 클라우드 워커로 옮기는 설계가 필요합니다.

공식 자료: [GitHub 연동](https://vercel.com/docs/git/vercel-for-github), [프로젝트 설정](https://vercel.com/docs/project-configuration), [Functions 실행 환경](https://vercel.com/docs/functions/runtimes).
