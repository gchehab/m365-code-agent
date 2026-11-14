# M365 Code Agent

**Experimental preview · Unofficial · Windows + Microsoft Edge**

An independent VS Code coding agent that uses your signed-in Microsoft 365 Copilot web session through Playwright.
It can read, search, create and edit files in your local workspace without a browser extension, clipboard relay or separate AI API key.
This project is not affiliated with, endorsed by, or supported by Microsoft. You need an eligible Microsoft 365 Copilot account and permission to use browser automation in your organization.

이 확장은 Microsoft가 제공하거나 보증하는 제품이 아닙니다. 실제 회사 테넌트 연동은 아직 검증되지 않은 실험적 버전입니다.

VS Code의 프로젝트를 읽고 수정하며, 로그인된 M365 Copilot 웹과 자동으로 대화하는 로컬 확장입니다.
별도 Edge 확장, 클립보드 중계, Copilot Studio, 외부 AI API 키를 사용하지 않습니다.

## 설치

1. VS Code 확장 화면의 `…` → `VSIX에서 설치…`에서 `m365-code-agent-0.1.0.vsix`를 선택합니다.
2. 프로젝트 폴더를 열고 왼쪽 활동 표시줄의 M365 Agent 아이콘을 선택합니다.
3. `Copilot 연결`을 누릅니다. PC에 설치된 Edge가 확장 전용 프로필로 열립니다.
4. 이 전용 창에서 **회사 계정 로그인과 MFA를 직접** 완료하고 Copilot 대화 화면으로 이동합니다.
5. VS Code에서 작업 요청을 입력하고 `작업 시작`을 누릅니다. 이후 입력·전송·응답 수집은 자동입니다.

회사 PC에는 VS Code와 Microsoft Edge가 필요합니다. Python 또는 별도 Node.js 설치는 필요하지 않습니다.
기존 Edge의 기본 프로필이나 비밀번호를 가져오지 않습니다. 전용 프로필에 로그인 상태를 보관합니다.
첫 로그인, 인증 만료, MFA와 CAPTCHA는 직접 처리해야 합니다.

## 사용

예: `src/average.js가 빈 배열을 받으면 null을 반환하도록 수정하고 테스트 파일을 만들어줘.`

- 현재 작업 폴더의 파일 목록을 전달한 뒤, Copilot이 필요한 파일 읽기·텍스트 검색을 요청합니다.
- 읽은 파일의 해시가 맞는 수정안만 적용합니다. 수정 중 파일이 바뀌었거나 저장하지 않은 사용자 편집이 있으면 적용을 거부합니다.
- 기본적으로 검증된 수정안을 자동 적용·저장합니다. `파일 수정 전 미리보기 확인`을 켜면 diff 확인 후 적용할 수 있습니다.
- 생성·수정한 파일은 일반 VS Code 편집 및 Git diff로 검토할 수 있습니다.
- `중지` 이후의 응답은 파일에 적용하지 않습니다. 이미 적용·저장된 파일은 유지합니다.
- 이번 버전은 파일 목록/읽기/검색, 새 파일 생성, 기존 파일 전체 교체를 지원합니다. 삭제·이름 변경·터미널 명령 실행은 지원하지 않습니다.
- 테스트 코드는 작성할 수 있지만 테스트 실행을 수행하지 않습니다.

`.git`, `node_modules`, 가상환경, `.env*`, 개인 키·인증서 등의 경로와 루트 `.gitignore` / `.m365agentignore`에 지정된 파일은 제외합니다.
심볼릭 링크·정션 및 프로젝트 밖 경로는 접근하지 않습니다. 단일 로컬 폴더를 대상으로 동작하며 다중 루트에서는 작업할 폴더를 선택합니다.
각 파일은 최대 128KB, 한 번의 변경은 최대 30개 파일/총 512KB로 제한합니다. 응답 문맥이 크면 더 작은 작업으로 나눠 요청하세요.

## 회사 Code Assistant 에이전트 사용

기존에 만든 M365 Code Assistant를 사용할 수 있습니다. 그 에이전트를 연 웹 주소를 VS Code 설정의
`m365Agent.copilotUrl`에 입력합니다. 필수는 아니며 일반 M365 Copilot 대화에서도 프로토콜 지침을 매 요청 전달합니다.
데스크톱 M365 앱에 직접 IPC/API로 연결하는 제품은 아닙니다. Edge에서 M365 웹을 자동 조작합니다.

## 연결 진단과 화면 변경

실제 회사 테넌트의 로그인된 화면에서는 아직 검증하지 못했습니다. M365의 화면 구조·실험적 UI·조직 정책에 따라 자동 감지를 조정해야 할 수 있습니다.
`진단`은 현재 주소, 제목, 입력창 감지 결과를 VS Code 출력 패널에 표시합니다. 쿠키·토큰과 파일 내용은 진단 로그에 기록하지 않습니다.

설정에서 다음을 조정할 수 있습니다.

- `m365Agent.composerSelector`: 입력창의 CSS 선택자. 기본값은 자동 감지입니다.
- `m365Agent.sendButtonSelector`: 전송 버튼의 CSS 선택자. 기본값은 입력창에서 Enter로 전송합니다.
- `m365Agent.responseSelector`: 응답 코드/메시지를 감싸는 CSS 선택자. 기본값은 코드 블록과 알려진 응답 컨테이너입니다.
- `m365Agent.responseTimeoutSeconds`: 응답 대기 제한(기본 240초).
- `m365Agent.maxRounds`: 읽기·수정 반복 제한(기본 12회).
- `m365Agent.browserChannel`: Edge(msedge) 또는 Chrome(chrome).

설정을 변경한 뒤 VS Code의 `개발자: 창 다시 로드`로 전용 브라우저 연결을 다시 만드세요.
Copilot 입력창에 직접 작성 중인 내용이 있으면 덮어쓰지 않고 작업을 중단합니다.
응답은 요청별 ID가 일치하는 구조화된 JSON만 받습니다. 응답 형식 오류나 시간 초과 시 파일을 적용하거나 요청을 자동 재전송하지 않습니다.

## 동작 방식과 제약

`VS Code 파일 도구 ↔ Playwright ↔ 전용 Edge의 M365 Copilot 웹`

파일 내용은 사용자가 로그인한 M365 Copilot 웹에 프롬프트로 전달됩니다. 별도 개발자 서버, 텔레메트리, 다른 AI 서비스로 보내지 않습니다.
비공개 API 호출, 로그인 토큰 추출, 회사 보안 정책 우회는 하지 않습니다.
이 방식은 Microsoft의 공식 Copilot API 연동이 아니며 웹 UI 변경, 조직의 브라우저 자동화 정책, 사용량 제한에 영향을 받습니다.
완전히 보이지 않는 API 방식이 아니라 전용 브라우저가 실행되는 자동화입니다. 창을 수동으로 닫으면 다시 연결해야 합니다.
WSL/SSH/컨테이너 등 원격 프로젝트는 이번 버전의 대상이 아닙니다.

## 개발과 검증

```powershell
npm ci
npm run check
npm test
npm run package
```

테스트는 로컬 파일 시스템, 해시·경로 보호, 모의 Copilot 페이지를 사용한 실제 Edge 입출력,
별도 VS Code 테스트 호스트의 파일 생성·편집·저장 동작을 확인합니다. 모의 페이지 검증이 회사 테넌트의 연동 검증을 대신하지는 않습니다.

참고: [Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[VS Code Webview](https://code.visualstudio.com/api/extension-guides/webview),
[VSIX 설치·패키징](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
