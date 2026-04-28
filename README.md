# 근로장학생 일지 자동화

포털의 **근로장학생 일지** 입력을 자동화하는 Node.js 스크립트입니다.  
사용자별 설정 파일(`users\사용자명.json`)을 읽어 월간 근무 일정을 생성하고, 중복 입력을 피하면서 신규 일지를 등록합니다.

## 1. 주요 기능

- 사용자별 설정 파일 기반 자동 입력
- 정기 근무 규칙(`regularRules`) + 특정일 예외(`specialDates`) + 휴가 제외(`vacationDates`)
- 공휴일 API 조회 기반 자동 제외(`date.nager.at`)
- 기존 일지와 비교해 중복 일정 건너뛰기
- 옵션(`cleanupUnexpectedRows`)으로 예상 외 기존 행 삭제 시도
- 미승인 월/로그인 실패 등 주요 예외 메시지 처리

## 2. 실행 환경

- Windows / macOS
- Node.js 18 이상 권장
- npm
- 크롬(또는 Chromium 실행 가능 환경)
- 인터넷 연결(공휴일 API 호출)

## 3. 설치

```powershell
npm install
```

## 4. 사용자 설정 파일 만들기

예시 파일을 복사해 본인 파일을 생성하세요.

Windows:
```powershell
Copy-Item .\users\사용자명.json.example .\users\내이름.json
```

macOS:
```bash
cp ./users/사용자명.json.example ./users/내이름.json
```

`users\내이름.json`에서 아래 항목을 수정합니다.

- `id`, `password`: 포털 로그인 계정
- `schedule.year`, `schedule.month`, `schedule.content`
- `regularRules`: 요일별 기본 근무 시간
- `specialDates`: 특정 날짜 시간 덮어쓰기
- `vacationDates`: 입력 제외 날짜
- `cleanupUnexpectedRows`: `true`면 이번 달 대상 날짜의 예상 외 행 삭제 시도

### 설정 예시

```json
{
  "id": "사용자ID",
  "password": "비밀번호",
  "schedule": {
    "year": 2026,
    "month": 1,
    "content": "실습실 점검"
  },
  "regularRules": [
    { "day": 1, "week": "월", "start": "0900", "end": "1700" },
    { "day": 2, "week": "화", "start": "0900", "end": "1700" }
  ],
  "specialDates": {
    "22": { "start": "1300", "end": "1800" }
  },
  "vacationDates": [15, 16],
  "cleanupUnexpectedRows": false
}
```

## 5. 실행

```powershell
npm start
```

실행 후 콘솔에 사용자 이름(파일명 기준, 확장자 제외)을 입력하세요.

예: `users\시영.json` 파일을 쓸 경우 입력값은 `시영`

## 6. 동작 순서

1. 사용자 설정 로드
2. 월간 일정 생성(공휴일/휴가/예외 반영)
3. 포털 로그인 및 근로장학생일지 화면 이동
4. 학년도/근로월 보정 후 조회
5. 기존 행 읽기 → 중복 제외/선택 삭제
6. 신규 일정만 입력 후 저장

## 7. 주의사항

- 포털 화면 구조(DOM)가 바뀌면 셀렉터 수정이 필요할 수 있습니다.
- 브라우저는 `headless: false`로 열리며, 완료 후 창이 자동으로 닫히지 않습니다.
- 사용자 계정 파일(`users\*.json`)은 민감 정보이므로 Git에 포함하지 마세요.

## 8. 트러블슈팅

### 로그인 후 진행이 멈춤/실패

- 계정 ID/비밀번호 확인
- 포털 점검 시간 여부 확인
- 포털의 UI 변경 시 `시간표.js`의 `SELECTORS` 점검

### `공휴일 API 조회 실패` 오류

- 인터넷 연결 상태 확인
- 잠시 후 재실행(API 일시 장애 가능)
