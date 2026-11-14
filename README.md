# M365 Code Agent

**Experimental preview · Unofficial · Windows + Microsoft Edge**

An independent VS Code coding agent that uses your signed-in Microsoft 365 Copilot web session through Playwright.
It can read, search, create and edit files in your local workspace without a browser extension, clipboard relay or separate AI API key.
This project is not affiliated with, endorsed by, or supported by Microsoft. You need an eligible Microsoft 365 Copilot account and permission to use browser automation in your organization.

이 확장은 Microsoft가 제공하거나 보증하는 제품이 아닙니다. 실제 회사 테넌트 연동은 아직 검증되지 않은 실험적 버전입니다.

VS Code의 프로젝트를 읽고 수정하며, 로그인된 M365 Copilot 웹과 자동으로 대화하는 로컬 확장입니다.
별도 Edge 확장, 클립보드 중계, Copilot Studio, 외부 AI API 키를 사용하지 않습니다.

## 설치

1. [Marketplace](https://marketplace.visualstudio.com/items?itemName=jhoon-dev.m365-code-agent)에서 설치하거나, `…` → `VSIX에서 설치…`에서 `m365-code-agent-0.2.1.vsix`를 선택합니다.
2. 프로젝트 폴더를 열고 왼쪽 활동 표시줄의 M365 Agent 아이콘을 선택합니다.
3. 입력창 아래 `연결`을 누릅니다. PC에 설치된 Edge가 확장 전용 프로필로 열립니다.
4. 이 전용 창에서 **회사 계정 로그인과 MFA를 직접** 완료하고 Copilot 대화 화면으로 이동합니다.
5. VS Code에서 작업 요청을 입력하고 Enter 또는 `↑`를 누릅니다. Shift+Enter로 줄바꿈합니다. 이후 입력·전송·응답 수집은 자동입니다.

회사 PC에는 VS Code와 Microsoft Edge가 필요합니다. Python 또는 별도 Node.js 설치는 필요하지 않습니다.
기존 Edge의 기본 프로필이나 비밀번호를 가져오지 않습니다. 전용 프로필에 로그인 상태를 보관합니다.
첫 로그인, 인증 만료, MFA와 CAPTCHA는 직접 처리해야 합니다.

## 사용

채팅 중심으로 작업하고, 파일 문맥을 첨부하고, 도구 실행과 변경을 검토하는 흐름입니다.
GitHub Copilot·Codex·Claude Code의 일반적인 작업 방식을 참고한 독립 구현이며, 동일한 성능·기능 전체를 제공하는 제품은 아닙니다.

| 모드 | 동작 |
| --- | --- |
| Ask | 파일 읽기·검색으로 설명과 코드 검토. 파일 수정·명령 실행 불가 |
| Plan | 코드를 조사한 뒤 구현·검증 계획 작성. 파일 수정·명령 실행 불가 |
| Agent | 파일 조사 → 수정안 → 적용 → 승인받은 명령으로 테스트·빌드 |

- `＋ 파일`로 최대 5개 파일을 명시적으로 첨부합니다. `현재 파일`은 열린 편집기 또는 선택 영역을 포함합니다.
- `/plan`, `/review`, `/test`로 계획, 코드 검토, 테스트 요청을 시작합니다.
- 대화 문맥을 이어서 요청할 수 있습니다. `＋`는 새 대화, `기록`은 이전 대화를 엽니다. 최근 20개 대화를 현재 VS Code 작업 영역의 로컬 저장소에 보관합니다. 모델에 전달하는 이전 대화는 크기에 맞춰 최근 일부로 제한됩니다.
- 파일 읽기·검색·명령의 진행 상태는 채팅의 도구 카드에 표시됩니다. 명령의 실제 출력은 `M365 Code Agent` 출력 패널에 표시됩니다.

예: `src/average.js가 빈 배열을 받으면 null을 반환하도록 수정하고 테스트 파일을 만들어줘.`

- 현재 작업 폴더의 파일 목록을 전달한 뒤, Copilot이 필요한 파일 읽기·텍스트 검색을 요청합니다.
- 읽은 파일의 해시가 맞는 수정안만 적용합니다. 수정 중 파일이 바뀌었거나 저장하지 않은 사용자 편집이 있으면 적용을 거부합니다.
- 기본적으로 `변경 승인`이 켜져 있습니다. 파일명을 눌러 VS Code diff를 열고 `적용` 또는 `거절`을 선택합니다. 체크를 해제하면 검증된 수정안을 자동 적용·저장합니다.
- 생성·수정한 파일은 일반 VS Code 편집 및 Git diff로 검토할 수 있습니다.
- `중지` 이후의 응답은 파일에 적용하지 않습니다. 이미 적용·저장된 파일은 유지합니다.
- `되돌리기`는 마지막 파일 수정 묶음을 복원합니다. 새로 만든 파일도 제거합니다. 이후 사용자 편집이 있으면 덮어쓰지 않습니다. 최대 20개 묶음을 이번 확장 실행 동안 보관하며 VS Code 재시작 후에는 사용할 수 없습니다. 터미널에서 발생한 변경은 포함하지 않습니다.
- Agent가 테스트·빌드 명령을 요청하면 **실행할 명령과 작업 폴더를 표시하고 매번 승인**받습니다. 명령은 해당 PC의 기본 셸에서 실행되며, 별도 샌드박스는 아닙니다. 120초 제한, 중지, 출력 크기 제한이 적용됩니다. 프로젝트 실행 도구(Node.js, Python 등)는 해당 프로젝트에 맞게 설치되어 있어야 합니다.
- 파일 편집 도구는 생성·전체 교체를 지원합니다. 파일 삭제·이름 변경 전용 도구, 인라인 자동 완성, 원격·백그라운드 에이전트는 제공하지 않습니다.

`.git`, `node_modules`, 가상환경, `.env*`, 개인 키·인증서 등의 경로와 루트 `.gitignore` / `.m365agentignore`에 지정된 파일은 제외합니다.
심볼릭 링크·정션 및 프로젝트 밖 경로는 접근하지 않습니다. 단일 로컬 폴더를 대상으로 동작하며 다중 루트에서는 작업할 폴더를 선택합니다.
각 파일은 최대 128KB, 한 번의 변경은 최대 30개 파일/총 512KB로 제한합니다. 응답 문맥이 크면 더 작은 작업으로 나눠 요청하세요.

## 회사 Code Assistant 에이전트 사용

기존에 만든 M365 Code Assistant를 사용할 수 있습니다. 그 에이전트를 연 웹 주소를 VS Code 설정의
`m365Agent.copilotUrl`에 입력합니다. 필수는 아니며 일반 M365 Copilot 대화에서도 프로토콜 지침을 매 요청 전달합니다.
데스크톱 M365 앱에 직접 IPC/API로 연결하는 제품은 아닙니다. Edge에서 M365 웹을 자동 조작합니다.

## 연결 진단과 화면 변경

실제 회사 테넌트의 로그인된 화면에서는 아직 검증하지 못했습니다. M365의 화면 구조·실험적 UI·조직 정책에 따라 자동 감지를 조정해야 할 수 있습니다.
`⋯`는 현재 주소, 제목, 입력창 감지 결과와 최근 전송 단계를 VS Code 출력 패널에 표시합니다. 쿠키·토큰과 파일 내용은 연결 진단 로그에 기록하지 않습니다. 승인한 명령과 그 출력은 출력 패널에 표시됩니다.

설정에서 다음을 조정할 수 있습니다.

- `m365Agent.composerSelector`: 입력창의 CSS 선택자. 기본값은 자동 감지입니다.
- `m365Agent.sendButtonSelector`: 전송 버튼의 CSS 선택자. 기본값은 한국어·영어 버튼 자동 감지입니다. 활성화된 버튼을 클릭하고 입력창 초기화·생성 시작·새 응답으로 제출을 확인합니다. 제출을 확인하지 못하면 빠르게 오류를 표시하고 자동 재전송하지 않습니다.
- `m365Agent.responseSelector`: 응답 코드/메시지를 감싸는 CSS 선택자. 기본값은 코드 블록과 알려진 응답 컨테이너입니다.
- `m365Agent.responseTimeoutSeconds`: 응답 대기 제한(기본 240초).
- `m365Agent.maxRounds`: 읽기·수정 반복 제한(기본 12회).
- `m365Agent.maxPromptCharacters`: 요청 길이 상한(기본 12,000자). 입력창의 실제 한도가 더 작다고 전송 전에 확인되면 오래된 대화·파일 목록·첨부 문맥을 줄여 재구성합니다. 큰 파일 본문을 넘기지 못하면 도구 오류로 모델에 알리고 좁은 검색을 요청합니다. 사용자 요청과 코드 내용을 중간에서 잘라 보내지 않습니다.
- `m365Agent.browserChannel`: Edge(msedge) 또는 Chrome(chrome).

설정을 변경한 뒤 VS Code의 `개발자: 창 다시 로드`로 전용 브라우저 연결을 다시 만드세요.
Copilot 입력창에 직접 작성 중인 내용이 있으면 덮어쓰지 않고 작업을 중단합니다.
응답은 요청별 ID가 일치하는 구조화된 JSON만 받습니다. 응답 형식 오류나 시간 초과 시 파일을 적용하거나 요청을 자동 재전송하지 않습니다.
응답 코드 블록은 표준 `json`을 사용합니다. 과거 `m365-agent` 언어 이름으로 인한 구문 강조 경고를 피합니다.
입력은 DOM의 문단과 실제 텍스트로 검증하고, 진단에는 요청·확인 글자 수와 표시된 한도를 포함합니다. 길이가 달라도 곧바로 길이 제한으로 단정하지 않습니다.
0.2.0이 남긴 식별 가능한 자동화 요청 초안은 다음 작업 전에 정리합니다. 일반 사용자 초안은 자동 삭제하지 않습니다. 자동 전송이 중단됐을 때 브라우저의 전송 버튼을 직접 누르지 말고 오류를 확인하세요.

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
웹뷰의 키보드·한글 입력·승인 UI, 별도 VS Code 테스트 호스트의 파일 생성·편집·저장·되돌리기 및 명령 승인을 확인합니다. 모의 페이지 검증이 회사 테넌트의 연동 검증을 대신하지는 않습니다.

참고: [Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[VS Code Webview](https://code.visualstudio.com/api/extension-guides/webview),
[VSIX 설치·패키징](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
