# 웹 API

기본 주소: `http://127.0.0.1:3210`. 요청/응답은 JSON이며 인증은 HttpOnly 세션 쿠키입니다. 로그인/가입 응답의 `csrfToken`을 이후 변경 요청의 `X-CSRF-Token` 헤더로 전송합니다. 비밀번호·쿠키·CSRF 값을 로그에 기록하지 마세요.

| API | 용도 |
|---|---|
| `GET /api/bootstrap` | 로그인 상태, 회원가입 활성 여부, 관리자 초기 설정 여부 |
| `POST /api/signup` | `username`, `displayName`, `password`, `passwordConfirmation`; 일반 사용자 가입과 로그인 |
| `POST /api/login` | `username`, `password`; 앱 로그인 |
| `POST /api/logout` | 현재 세션 종료 |
| `GET /api/me` | 내 계정과 연결 상태 |
| `PUT /api/me/password` | `currentPassword`, `newPassword`; 앱 비밀번호 변경 |
| `GET /api/portal-credentials` | 암호문 원문이 아닌 마스킹된 연결 상태 |
| `PUT /api/portal-credentials` | `portalId`, `portalPassword`; 암호화 저장 |
| `DELETE /api/portal-credentials` | 저장된 학교 계정 제거 |
| `GET /api/schedules/:year/:month` | 내 일정과 예상 시수 |
| `GET /api/portal-records/:year/:month` | 내 계정·해당 월의 마지막 성공 조회/변경 결과. 학교 재조회 없이 달력 복원 |
| `POST /api/portal-records/:year/:month/mutate` | 미확인 포털 일지 1건 수정/삭제, 재조회 검증 |
| `PUT /api/schedules/:year/:month` | 내 일정 저장. 학교 포털 쓰기와 별도 |
| `POST /api/jobs` | `type: query` 또는 `submit`, `year`, `month`; 비동기 조회/입력 |
| `GET /api/jobs` | 내 작업 목록 |
| `GET /api/jobs/:id` | 작업 상태·결과·로그 |
| `GET /api/jobs/:id/events` | SSE 진행 상태 |

`query` 작업 결과의 `summary.assignments`에서 실제 승인된 장학 유형과 근무지를 선택해 일정의 `portalAssignment`에 저장합니다. 클라이언트가 보낸 이름은 권한 근거가 아니며, 학교 API가 반환한 코드 조합·기간·계정 정보로 재검증합니다. `submit`은 실제 학교 일지를 변경하므로 사용자가 최종 확인한 일정에만 요청하세요.

일정 예시(실제 근무 사실을 확인한 값으로 작성):

```json
{
  "content": "실제 근무내용",
  "portalAssignment": { "scholarshipCode": "승인된 코드", "workDepartmentCode": "승인된 코드" },
  "regularRules": [],
  "specialDates": { "1": { "start": "0900", "end": "1300" } },
  "vacationDates": [],
  "extraHolidayDates": []
}
```

근무내용은 UTF-8 100바이트 이내입니다. 학교 로그인·SSO·배정 조회·일지 조회·신규 저장은 서버에서 HTTP로 실행되며 사용자는 학교 브라우저 창을 열 필요가 없습니다. 학교 세션이나 비밀번호는 웹 API 응답에 반환하지 않습니다.

일정 응답은 공휴일 이름을 포함한 `calendar`도 제공합니다. `holidayDates`는 서버가 공휴일 달력에서 계산하며 클라이언트 값을 신뢰하지 않습니다. 실제 근무한 공휴일은 `holidayWorkDates: [17]`처럼 저장합니다. 수동 제외일/휴가가 있으면 그것이 우선합니다. 공휴일 조회 실패 시 오류 안내와 기존 저장된 공휴일을 유지합니다.

일지 변경 요청은 `operation: update` 또는 `delete`, `confirmed: true`, 마지막 조회 결과의 대상 `record`를 전송합니다. 수정은 추가로 `changes: {start, end, content}`를 전송합니다. 서버는 세션 사용자와 배정으로 원본을 조회한 뒤 `sequence`, 날짜, 원래 시간/내용이 일치하는 본인 미확인 행만 처리합니다. 확인 완료 행, 오래된 원본, 동시 작업은 거절합니다. 요청 후 결과가 불확실하면 재전송하지 않고 오류를 반환하므로 `query` 작업으로 다시 확인하세요.

배정 선택은 현재 월 신규 자동입력의 기본값 하나이며, 시간·내용 수정과 삭제는 대상 기록의 원래 배정을 사용합니다. 담당자 승인, 확인 상태 변경은 API로 제공하지 않습니다.

관리자 초기 설정은 `POST /api/setup`이며 운영 환경에서는 `setupToken`이 필요합니다. `/api/admin/users` 계열은 관리자 전용입니다. 일반 회원가입에 관리자 권한을 지정해도 적용되지 않습니다.
