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
