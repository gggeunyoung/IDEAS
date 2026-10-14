# 회의실 Google 로그인

대상: https://ideas-nine-opal.vercel.app/ → 인증된 맥 워커. Gemini 구독 연결과 별개다.

## 현재 구현

로그인 화면에서 공식 Google Identity Services 버튼을 동적으로 불러온다. 맥 워커의 `google-auth-library`가 Google 서명·클라이언트 ID(aud)·발급자·만료를 검증한다. 검증된 이메일이 워커에 등록된 소유자와 같아야 세션을 발급한다. 이메일은 공개 설정 응답에 포함하지 않는다. 로그인 요청은 HttpOnly 쿠키와 일회용 nonce로 브라우저에 묶이며 10분 후 만료한다. 재사용·다른 계정·미인증 이메일은 거절한다.

세션은 기존과 같은 HttpOnly·Secure·SameSite=Strict 쿠키, 8시간 만료다. Google ID 토큰은 서버 검증에만 쓰고 Git·작업 로그·브라우저 localStorage에 저장하지 않는다. Google 비밀번호는 회의실에 전달되지 않는다. 로그아웃 또는 워커 재시작으로 회의실 세션은 끝나지만 Google 계정 자체에서 로그아웃하지는 않는다.

기존 회의실 비밀번호는 복구용으로 유지한다. Google 설정이 없으면 비밀번호 로그인을 안내한다. 임의의 Google 계정으로 회원가입하는 기능은 없다. Gmail 또는 Google Workspace 관리 계정만 지원한다. `allowedSub`를 지정하면 이메일에 더해 Google 고유 계정 ID도 제한한다.

## 처음 한 번 설정

1. [Google Cloud 클라이언트](https://console.cloud.google.com/auth/clients)에서 본인 프로젝트를 선택하거나 새로 만든다.
2. Google 인증 플랫폼의 시작 설정에서 앱 이름 `IDEAS 회의실`, 본인 지원/연락 이메일, 외부 대상(개인 Gmail)을 설정한다. 필요한 약관 동의는 본인이 확인한다. 로그인만 사용하므로 추가 Gmail·Drive 권한이나 AI API 키는 필요 없다.
3. 웹 애플리케이션 OAuth 클라이언트를 만든다. 승인된 JavaScript 원본은 정확히 `https://ideas-nine-opal.vercel.app` (끝 슬래시 없음)이다. JavaScript 콜백 방식이므로 승인된 리디렉션 URI는 필요 없다. 임의 preview 도메인을 추가하지 않는다.
4. 표시되는 `...apps.googleusercontent.com` **클라이언트 ID**를 사용한다. 클라이언트 보안 비밀은 이 구현에 사용하지 않으며 채팅·Git에 넣지 않는다.
5. 워커 맥의 IDEAS 폴더에서 `npm run setup:google`를 실행하고 클라이언트 ID와 허용할 본인 이메일을 입력한다. `.runtime/google-login.json`에 권한600으로 저장하며 Git에서 제외한다. CLI 로그인 정보를 다른 기기에서 복사하지 않는다.
6. 진행 중인 회의가 없는지 확인한 뒤 원격 서비스를 재시작한다. LaunchAgent라면 `launchctl kickstart -k gui/$(id -u)/com.gggeunyoung.ideas-remote`다. 현재 회의실 세션은 만료되어 다시 로그인해야 한다.
7. 공개 회의실에서 새로고침 후 본인이 Google 버튼으로 최초 로그인한다. 다른 물리적 기기 로그인도 직접 확인한다. 설정 변경이 전파되기까지 기다려야 할 수 있다.

Google OAuth 테스트/게시 상태 및 검증 요구는 Cloud 콘솔 안내를 확인한다. 운영자가 외부 대상 앱을 만들더라도 회의실 백엔드는 등록된 한 계정만 허용한다. 기본 인증 범위는 email·profile·openid다.

## 검증 범위

자동 테스트는 RSA로 서명한 토큰을 공식 SDK에서 검사하고 위조 서명·잘못된 클라이언트·다른 계정·미인증 이메일·nonce·쿠키 누락·재사용·만료를 거절하는지 확인한다. 워커 세션 발급·로그아웃·비밀번호 대체 로그인·Vercel 프록시의 같은 Origin 강제도 확인한다. 외부 Google 공개 키 조회와 실제 소유자 로그인은 OAuth 클라이언트 설정 후 확인해야 한다.

2026-10-14: 윈도우 변경62e0e33을 먼저 반영했다. 인앱 Google Cloud 콘솔에서 프로젝트/알림 조회가 오류를 내고 인증 페이지 이동도 실패하여 클라이언트 ID를 발급하지 못했다. 프로젝트 만들기를 요청했지만 성공 확인이 없어 생성 완료라고 기록하지 않는다. 실제 Google 로그인 완료를 주장하지 않는다.

공식 문서: [설정](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), [서버 토큰 검증](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

배포 확인: 코드98af4ed의 Vercel production 배포 dpl_EzPLLgb7CpsaihMHqh6X73vPeRUE가 READY다. 맥 서비스 재시작 후 로컬 화면에 팀 모드가 포함됐고 공개 auth/config는200·google.enabled=false·비밀번호 대체 허용을 반환한다. 실제 공개 웹에서 무인증 방 조회401 → 기존 비밀번호 로그인200 → 방2개 조회200 → 로그아웃 후401을 확인했다. 공개 브라우저에 설정 대기 안내가 보이며 콘솔 오류가 없었다. Google 로그인 성공 검증과 구분한다.

## 클라이언트 등록·비공개 JSON 보관 — 2026-10-14

사용자가 웹 클라이언트 ID를 제공해 워커의 비공개 설정에 등록했다. 진행 중인 회의가 없는 것을 확인한 뒤 서비스를 재시작했고 공개 auth/config의 Google 활성화200과 실제 Google 버튼 표시를 확인했다. 다운로드한 웹 OAuth JSON의 승인 원본에 공개 회의실 주소가 들어 있음을 확인했다. 실제 Google 로그인과 세션 발급은 아직 확인하지 못했다. 인앱 버튼 클릭 후 로그인 팝업/계정 선택이 나타나지 않아 최초 로그인은 사용자 확인이 남았다.

사용자가 향후 사용을 위해 보관을 요청한 원본 JSON은 `.runtime/credentials/google-oauth-client.json`에 그대로 복사했다. 원본과 바이트가 같으며 보관 폴더700·파일600, Git 제외를 확인했다. 다운로드 원본은 삭제하지 않았다. client_secret은 현재 로그인 코드에서 읽거나 사용하지 않으며 값·JSON 본문을 Git/문서/로그에 넣지 않는다. 이 복사본은 해당 맥 내부에만 보관되며 다른 노트북으로 자동 동기화되지 않는다.
