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
| `GET /api/monthly-automation` | 내 예약 설정, 다음 실행 시각, 마지막 예약 작업 |
| `PUT /api/monthly-automation` | 매월 자동 등록 예약 설정/해제. CSRF 및 `revision` 필요 |

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

근무내용은 선택 입력이며 빈 문자열도 허용합니다(UTF-8 100바이트 이내). 학교 로그인·SSO·배정 조회·일지 조회·신규 저장은 서버에서 HTTP로 실행되며 사용자는 학교 브라우저 창을 열 필요가 없습니다. 학교 세션이나 비밀번호는 웹 API 응답에 반환하지 않습니다.

일정 응답의 `regularRules`는 해당 월에 적용되는 반복 규칙입니다. 변경한 월부터 다음 변경 전까지 이어지며, 월별 예외·배정·내용은 상속하지 않습니다. 응답의 `recurringRuleRevision`을 PUT 본문에 그대로 보내면 다른 화면의 변경을 덮어쓰지 않도록 검사합니다(충돌 시 409). `recurringRuleFrom`은 적용 시작 월(YYYYMM)입니다.

조회 작업에 `automatic: true`를 보내면 1분 이내 성공 결과를 `{cached: true, snapshot}`으로 재사용할 수 있습니다. 같은 월의 진행 중 조회는 기존 `{job, reused: true}`를 반환합니다. 다른 작업 진행 중에는 409와 대기 중 작업(`job`, 있는 경우), 요청 제한 시에는 429와 `retryAfterMs`를 반환합니다. 수동 조회는 성공 캐시를 우회하며, `submit`에는 자동 조회 캐시가 적용되지 않습니다.

일정 응답은 공휴일 이름을 포함한 `calendar`도 제공합니다. `holidayDates`는 서버가 공휴일 달력에서 계산하며 클라이언트 값을 신뢰하지 않습니다. 실제 근무한 공휴일은 `holidayWorkDates: [17]`처럼 저장합니다. 수동 제외일/휴가가 있으면 그것이 우선합니다. 공휴일 조회 실패 시 오류 안내와 기존 저장된 공휴일을 유지합니다.

일지 변경 요청은 `operation: update` 또는 `delete`, `confirmed: true`, 마지막 조회 결과의 대상 `record`를 전송합니다. 수정은 추가로 `changes: {start, end, content}`를 전송합니다. 서버는 세션 사용자와 배정으로 원본을 조회한 뒤 `sequence`, 날짜, 원래 시간/내용이 일치하는 본인 미확인 행만 처리합니다. 확인 완료 행, 오래된 원본, 동시 작업은 거절합니다. 요청 후 결과가 불확실하면 재전송하지 않고 오류를 반환하므로 `query` 작업으로 다시 확인하세요.

배정 선택은 현재 월 신규 자동입력의 기본값 하나이며, 시간·내용 수정과 삭제는 대상 기록의 원래 배정을 사용합니다. 담당자 승인, 확인 상태 변경은 API로 제공하지 않습니다.

관리자 초기 설정은 `POST /api/setup`이며 운영 환경에서는 `setupToken`이 필요합니다. `/api/admin/users` 계열은 관리자 전용입니다. 일반 회원가입에 관리자 권한을 지정해도 적용되지 않습니다.

## 월간 예약

활성화 본문: `{enabled: true, day: 1, time: "0900", targetMonth: "current", assignment: {scholarshipCode, workDepartmentCode}, revision: 0, confirmed: true}`. `day: 0`은 말일, 1~31은 해당 일이며 없는 날짜는 말일로 처리합니다. 시각은 한국 시간 00:00~23:59, `targetMonth`는 `current` 또는 `previous`입니다. 응답의 `nextRunAt`은 UTC ISO 시각이며 `timezone`은 `Asia/Seoul`입니다.

해제는 `{enabled: false, revision}`만 전송합니다. 다른 화면에서 설정하거나 예약 실행이 시작되어 버전이 바뀌면 409를 반환합니다. 설정 저장 자체는 포털 쓰기를 하지 않습니다. 실제 실행 시 대상 월 저장 배정이 우선하며 없으면 예약 기본 배정으로 검증합니다. 기본 설정은 비활성화이며 포털 계정 변경/삭제가 성공하면 예약이 꺼지므로 다시 확인해야 합니다.

예약 작업의 `triggerSource`는 `monthly`입니다. 실행 이력은 중복 실행 방지용이며 삭제/재시도 API를 제공하지 않습니다. 저장 요청 전 `FindWork` 결과에 선택한 승인 배정이 없는 경우만 다음 날 예약 시각에 같은 대상 월을 재확인합니다. `retryAt`은 다음 승인 확인 UTC ISO 시각이며, 다음 정기 예약 전까지 재확인합니다. 설정 변경·해제는 이 대기를 취소합니다. 로그인·통신·저장 오류는 재시도하지 않습니다. 오래된 예약(24시간 초과)은 과거 달 전체를 소급 입력하지 않고 실패 기록을 남깁니다.

포털 인증 세션은 앱 사용자·연결정보 버전에 묶인 서버 메모리 캐시를 재사용합니다. 공개 토큰 API는 제공하지 않습니다. 재사용 시 `Resettime`으로 접속 시간을 연장하고 학생 정보와 메뉴 권한을 확인합니다. 30분 미사용/최대 8시간/로그아웃/연결정보 변경 시 폐기합니다. 만료된 조회는 한 번 재인증 후 다시 조회할 수 있지만 학교 쓰기 요청은 재전송하지 않습니다. 연결정보 저장 전 검증에는 캐시를 사용하지 않습니다.

자동 등록 결과의 `skippedDayCount`는 기존 일지가 있어 제외한 날짜 수, `skippedCount`는 제외한 예정 구간 수입니다. 다른 승인 배정의 일지가 있어도 그날 전체를 건너뛰며 기존 일지는 변경하지 않습니다. 이전 달 복사는 기존 일정 GET의 `preview.logs`를 날짜별로 매핑하고 현재 월 PUT으로 앱에만 저장합니다.
