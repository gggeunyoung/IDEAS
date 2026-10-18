# 원격 회의실 운영 — 2026-10-13

사용자는 어느 기기에서든 https://ideas-nine-opal.vercel.app/ 에 로그인한다. 실제 프로젝트 자료와 Codex·Claude Code는 이 맥에서 처리한다. 사용 중인 노트북에 CLI나 프로젝트를 설치할 필요가 없다.

## 실제 연결 흐름

웹 → Vercel /api/remote → 인증된 Cloudflare 중계 → 맥 remote-worker → localhost 서버 → GPT·Claude 구독 CLI.

- 웹은 회의실 전용 비밀번호로 로그인한다. 브라우저 세션은 HttpOnly·Secure·SameSite=Strict 쿠키이며 8시간 후 만료한다. 로그아웃하거나 맥 워커가 재시작되면 다시 로그인한다.
- 중계 인증키는 Vercel 서버 환경과 맥 .runtime/remote-secrets.json에만 있다. 브라우저에 전달하지 않는다. CLI 로그인 토큰이나 API 키를 Vercel에 복사하지 않는다.
- 공개 중계는 인증된 API만 제공한다. 기존 localhost 서버와 맥 전체 파일시스템을 그대로 공개하지 않는다.
- 맥이 바깥으로 중계 연결을 만들므로 공유기 포트포워딩은 필요하지 않다.
- 맥의 중계 주소가 바뀌면 Vercel의 비공개 Blob에 연결 주소만 다시 등록한다. 대화·결과 파일은 Blob에 저장하지 않는다. 사용자가 접속하는 Vercel 주소는 그대로다.

## 긴 회의와 재연결

회의·저장소 연결·Git 저장은 맥의 작업 ID로 실행하고, 웹은 결과를 2초 간격으로 조회한다. Vercel 함수가 AI 작업 완료까지 기다리지 않는다. 화면을 닫거나 네트워크가 끊겨도 맥에서 진행 중인 작업은 계속될 수 있다.

대시보드의 ‘이전 작업 다시 조회’는 저장된 작업을 다시 읽는다. 회의 중 ‘중단’은 맥에 실행 중단을 전달한다. 완료된 회의록과 프로젝트 상태는 기존 방별 폴더에 남는다. .runtime/remote-jobs는 기기 내부 작업 상태로 Git에 포함하지 않는다. 맥 워커 재시작 시 완료되지 않은 작업은 ‘중단됨’으로 표시하며 자동으로 다시 AI를 호출하지 않는다.

## 이 맥의 자동 실행

```sh
npm run service:status
```

com.gggeunyoung.ideas-remote LaunchAgent는 맥 로그인 시 실행하고 종료된 프로세스를 다시 시작한다. 서비스가 실행되는 동안 caffeinate로 자동 잠자기를 방지한다. 덮개 닫기, 수동 잠자기, 전원 끄기, 인터넷 끊김은 막지 않는다. 맥에 로그인하지 않은 전원 켜짐 상태만으로 사용할 수 있다고 보장하지 않는다.

```sh
# 자동 실행과 잠자기 방지를 해제하려면
npm run service:remove
```

상태 로그는 .runtime/remote-service.log와 .runtime/remote-service-error.log다. 비밀번호는 .runtime/remote-login.txt를 이 맥에서 확인한다. 이 파일과 .runtime 전체를 Git이나 공유 프로젝트에 넣지 않는다.

비밀번호를 직접 정하려면 워커 맥의 IDEAS 폴더에서 `npm run remote:password`를 실행해 12자 이상을 두 번 입력한다. 입력은 화면에 표시되지 않고 해시만 .runtime/remote-secrets.json에 저장되며, 자동 생성 비밀번호가 적힌 remote-login.txt는 삭제된다. Vercel 중계 키는 그대로라 재배포는 필요 없다. 원격 서비스를 다시 시작해야 적용된다(`npm run service:remove` 후 `npm run service:install`). 비밀번호를 채팅이나 문서에 적지 않는다.

## 새로운 맥 워커 설정

1. Node.js 22 이상, npm ci, npm run setup:local 및 본인 GPT·Claude CLI 로그인을 준비한다.
2. 작업 저장소를 클론하고 방 목록에 등록한다. CLI 계정과 프로젝트 폴더는 워커 맥에만 필요하다.
3. npm run setup:tunnel로 Cloudflare 공식 중계 프로그램을 설치한다.
4. npm run start:remote를 처음 실행하면 기기 내부 인증 설정과 로그인 비밀번호 파일을 생성한다. 종료한 뒤 서비스 실행 방식을 선택한다.
5. Vercel production 환경에 IDEAS_BRIDGE_TOKEN(기기 내부 설정의 중계 키), IDEAS_PUBLIC_ORIGIN(접속 웹 주소), BLOB_STORE_ID(연결된 비공개 저장소 ID)를 설정하고 재배포한다. 키 값을 문서에 적지 않는다.
6. npm run start:service로 수동 실행하거나 npm run service:install로 자동 실행을 등록한다. 같은 포트에 두 원격 워커를 동시에 실행하지 않는다.

## 운영 범위와 비용

현재 중계는 Cloudflare Quick Tunnel이다. 주소 변경은 자동 등록하지만 Quick Tunnel은 개발·검증용으로 SLA를 제공하지 않는다. 고정된 이름의 정식 Tunnel로 교체하는 것은 다음 운영 개선이다. [Cloudflare 공식 제한](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Vercel Hobby의 기존 무료 사용량 범위에서 Functions와 소량의 비공개 Blob을 사용한다. 유료 플랜 전환이나 별도 AI API 결제는 하지 않았다. 무료 한도를 초과하면 사용이 제한될 수 있다. GPT·Claude는 기존 계정의 구독 사용량을 소비한다. [Vercel Blob 요금](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Vercel Functions 제한](https://vercel.com/docs/functions/limitations).

## 검증

- 자동 테스트 38개 통과. 무인증·위조 세션·로그아웃 후 접근 차단, 로그인 시도 제한, 작업 중복 방지, 취소, 결과 복원, 원격 경로·주소 제한을 포함한다.
- Vercel production에서 로그인 → 맥의 방 2개 조회 → AI 협업 실험실의 기존 대화·결과 로드를 확인했다.
- 실제 REMOTE-LINK-001 요청으로 GPT·Claude 독립 답변 2개와 상호 검토 2개를 받았다. 데모나 별도 API 호출이 아니다.
- 중계 종료 후 새 주소로 자동 재연결·Vercel 등록을 확인했다. 이후 같은 웹 세션에서 회의록과 인수인계 2개 파일의 정상 Git 푸시를 확인했다.
- 다른 물리적 노트북과 휴대전화에서는 아직 직접 시험하지 않았다. 현재 검증은 공개 HTTPS Vercel 경로를 통해 수행했다.

## 재접속과 상태 저장 보완

진행 중 화면을 닫았거나 결과 연결이 끊겼다면 로그인 후 상단의 ‘이전 작업 다시 조회’를 누른다. 방을 나가지 않고도 다시 조회할 수 있다. 로그인 만료와 존재하지 않는 작업은 네트워크 재시도와 구분한다.

회의 중단은 요청 접수/저장 대기 단계부터 적용한다. Git 푸시나 저장소 클론에는 중단 성공이라고 표시하지 않는다. 작업 상태를 저장하지 못하면 실제 AI 실행 전에 거절하고 다음 요청을 막는 잠금을 해제한다.

손상된 작업 상태 파일은 .runtime/remote-jobs/quarantine에 원본 그대로 별도 보관한다. 해당 파일 하나 때문에 다른 회의 기록과 서버 시작까지 막지 않는다. 기존 방별 대화와 완료 회의록은 별도 프로젝트 폴더에 남는다.

## 2026-10-18 중계가 살아 있는 것처럼 보이던 장애 수정

Google 설정과 로컬 auth/config는 정상200이었지만 공개 auth/config는503이었다. 등록된 Quick Tunnel은 외부에서 접속되지 않았고 cloudflared 프로세스는 종료되지 않은 채 남아 있었다. 기존 서비스는 프로세스 종료만 감지하고 등록 성공 뒤에는 실제 외부 연결을 검사하지 않아 복구하지 못했다. 중계 프로세스만 재시작해 공개 Google 설정200과 버튼 표시를 우선 복구했다. Google 클라이언트나 보관 JSON을 다시 발급하지 않았다.

새 `scripts/tunnel-supervisor.mjs`는 30초 간격으로 인증된 `/api/worker/health`를 직접 중계와 Vercel 경로 양쪽에서 확인한다. 두 경로의 워커 instanceId가 같아야 정상이다. 직접 중계가3회 연속 실패하면 중계 자식 프로세스만 재시작하며 워커·현재 작업·로그인 세션을 유지한다. SIGTERM 후10초 동안 종료되지 않으면 SIGKILL을 보낸다. 주소 발급이90초 동안 멈춰도 다시 시작한다. 최초 주소 등록 실패는 다음 점검에서 재시도한다.

직접 중계는 정상인데 Vercel 주소가 오래됐거나 다른 워커를 가리키면 현재 주소를 다시 등록한다. 오래된 중계의 늦은 등록 응답은 새 중계의 로컬 등록 상태에 반영하지 않는다. 정상 상태에서는 점검할 때마다 Blob에 쓰지 않는다. 헬스 경로는 비공개 중계 키가 있어야 접근할 수 있으며 일반 방문자는401이다. 로그인 nonce를 발급하거나 구독 AI를 호출하는 점검이 아니다.

네트워크·Quick Tunnel 제공자 장애 중에는 자동 복구를 시도해도 즉시 접속을 보장할 수 없다. 워커 전체 재시작은 기존과 같이 실행 중 작업을 중단하므로 업데이트 때는 진행 중 작업을 먼저 확인한다. 이 점검은 서버 연결 점검이며 채팅의 사용자 무응답 감지 자동화와 별개다.
