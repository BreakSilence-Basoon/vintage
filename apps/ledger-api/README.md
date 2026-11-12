# Ledger 로컬 API 실험

이 앱은 가상 자료로 초기 설정, 명시적 권한, 기록 생성·조회·정정과 같은 요청의 재시도를 연결해 보는 **로컬 시험용 서버**입니다. 브라우저 화면, 실제 로그인 제공자 설정, 운영 배포와 실사용 설치 안내는 아닙니다. 실제 직원·고객·거래 자료를 넣거나 인터넷에 공개하지 마세요.

## 시험 경계

- 실행 명령은 `127.0.0.1`에만 수신하며 쿠키와 브라우저 `Origin`, 다른 Host, URL 쿼리를 거부합니다. HTTPS나 프록시를 제공하지 않으며, 다른 컴퓨터나 브라우저와 안전하게 연결하는 방식은 구현·검증하지 않았습니다.
- 별도의 읽기·쓰기 범위를 가진 서명 JWT와 같은 DB의 현재 활성 권한이 필요합니다. 서버가 사용하는 공개 검증 키 파일은 설치자가 신뢰할 수 있는 곳에서 준비해야 하며 비밀키를 포함하면 시작하지 않습니다. 실제 발급자, 키 교체·토큰 철회, 사용자 초대와 권한 관리 화면은 연결하지 않았습니다.
- 쓰기는 기본적으로 꺼져 있고 `VINTAGE_LEDGER_ENABLE_WRITES=true`를 명시해야 합니다. 명시적 읽기·쓰기 권한은 해당 DB의 모든 기록에 적용되며 기록별 역할·소유자 접근 정책은 없습니다. 권한 회수 후 다음 요청과 재시도는 거부되지만 이미 시작한 읽기는 이전 상태를 볼 수 있습니다.
- `POST /v1/facts/read`는 JSON `id`를, 쓰기가 켜진 `POST /v1/facts/write`는 `operationId`, `expectedRevision`, `fact`를 받습니다. `Authorization` 헤더에 접근 토큰을 넣고 `Content-Type: application/json`, 8KB 이하의 명시적 Content-Length를 사용합니다. ID와 토큰을 URL에 넣지 않습니다.
- 권한 실패, 충돌, DB 잠금 등은 구체적 이유를 공개하지 않고 `503 unavailable`로 처리할 수 있습니다. 이 응답이나 응답 유실이 미저장을 증명하지 않습니다. 같은 `operationId`와 같은 내용을 유지해 확인해야 합니다. 서로 다른 ID의 실제 거래 중복은 찾지 못합니다.

## 실험 설정

Node.js 24와 이 저장소의 pnpm 설정을 사용합니다. `init-db`는 `VINTAGE_LEDGER_DATABASE_FILE`에 아직 없는 절대 경로를 지정하고 표준 입력 JSON으로 `businessId`와 `grant`를 받아 빈 DB와 첫 명시적 권한을 만듭니다. `grant`는 신뢰된 운영자가 확인한 `issuer`, `subject`, `actorId`, `active`, `read`, `write`, `tokenValidAfter`, `operatorId`, `reason`을 포함해야 합니다. 이 명령은 입력자의 신원이나 권한의 정당성을 검증하지 않습니다. 실패해도 새 불완전 파일이 남을 수 있으므로 보존하고 확인한 뒤 조치해야 합니다.

실험용 `start`는 위 DB 경로 외에 `VINTAGE_LEDGER_JWKS_FILE`, `VINTAGE_LEDGER_PORT`, `VINTAGE_LEDGER_ISSUER`, `VINTAGE_LEDGER_AUDIENCE`, `VINTAGE_LEDGER_CLIENT_ID`, `VINTAGE_LEDGER_BUSINESS_ID`, `VINTAGE_LEDGER_READ_SCOPE`, `VINTAGE_LEDGER_WRITE_SCOPE`가 필요합니다. 사업장 값은 DB 설정과 같아야 하고 범위는 서로 달라야 합니다. DB와 공개 키 파일은 이미 존재하는 일반 파일의 절대 경로여야 합니다. 복구 확인이 끝나지 않은 사본은 시작하지 않습니다.

설치자에게 제공하는 완성된 지침은 아직 아닙니다. 기록 목록·검색, 요청 빈도 제한, DB·백업·임시 파일의 OS 접근권한과 암호화, 실제 신원 확인·권한 회수·복구, 토큰 보호, 증빙 수집, 통화 규칙, 대량 성능과 실제 업무 수락을 먼저 구현하고 검증해야 합니다. 과거 백업의 일반 복사는 예전 권한을 되살릴 수 있으며, 복구용 사본도 백업 이후 거래·외부 작업 대조가 필요합니다. [저장·복구 실험의 한계](../../packages/ledger-store/README.md)를 확인하세요.
