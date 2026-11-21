# Library 합성 이관 확인

이 경로는 개발 환경에서 정해진 예시만 다룹니다. 실제 가게 문서나 외부 서비스 계정을 연결하지 않습니다. 실행 결과는 로컬 개발 서버의 메모리와 해당 합성 세션에만 남습니다.

1. [Library 안내](../apps/library-web/README.md)에 따라 합성 데이터를 켜고 로그인합니다.
2. 브라우저 개발자 도구의 콘솔을 엽니다. 아래 코드의 `single`은 단건, `batch`는 묶음 이관, `notion`은 Notion 이관 예시입니다. `reserve`와 `batch-reserve`는 각각 합성 첨부 한 건과 묶음 예약입니다. 합성 내부 문서를 적용한 뒤에는 `delete` 또는 `restore`로, Notion 예시를 발행한 뒤에는 `notion-delete` 또는 `notion-restore`로 삭제·복구를 확인할 수 있습니다. 합성 문서를 다시 이관하고 예약한 뒤 지정 합성 파일을 올리면 `attach`로 연결할 수 있습니다.
3. 코드를 실행하면 원본과 같은 확인 주소가 열립니다. 확인 후 적용하면 해당 세션에서 단건·묶음 예시는 `/ir/00000000-0000-4000-8000-000000000101`, Notion 예시는 `/native/00000000-0000-4000-8000-000000000104`를 열 수 있습니다.

```js
const response = await fetch('/api/fixture/ir-confirmation', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'prepare', kind: 'single' }),
});
if (!response.ok) throw new Error('합성 제안을 만들지 못했습니다.');
const proposal = await response.json();
sessionStorage.setItem(`vintad3e-library-ir-recovery:${proposal.proposalId}`, proposal.proof);
location.assign(`/confirmations/${encodeURIComponent(proposal.proposalId)}`);
```

같은 탭의 합성 로그인 복귀를 지원합니다. 제안 기한이 지나거나 서버가 재시작되면 제안을 다시 만들어야 합니다. 실제 인증·작업 권한과 문서 이관은 연결되지 않습니다.

첨부 예약은 정해진 합성 파일의 예약 상태만 바꿉니다. 연결에는 같은 합성 세션에서 파일 올리기 화면으로 올린 지정 합성 파일이 필요하며, 파일 형식도 `text/plain`으로 일치해야 합니다. 재로그인 후에는 합성 파일을 다시 올려야 합니다. 실제 파일이나 외부 저장소는 사용하지 않습니다.

첨부 정리 예시는 다른 문서와 회의에서 공유할 수 없는 별도 합성 파일만 사용합니다. 같은 세션에서 `single`과 `reserve`를 적용한 뒤 아래 코드를 실행하고, 위 확인 코드에서 차례로 `isolated-attach`, `delete`, `cleanup`을 실행합니다. 문서 삭제 전에 정리를 시도하면 거부됩니다. 일반 합성 파일은 정리하지 않으며 파일의 합성 내용도 지우지 않습니다.

별도 합성 파일과 합성 회의 보정 파일의 주소로 로그인하면 같은 주소로 돌아갑니다. 로그인만으로 이전 세션의 파일이나 문서가 복구되는 것은 아니며, 복구 정보가 없는 파일은 찾을 수 없습니다.

```js
const upload = await fetch('/api/fixture/ir-exclusive-upload', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '업무를 시작하기 전에 필요한 사항을 확인합니다.',
});
if (!upload.ok) throw new Error('합성 첨부를 준비하지 못했습니다.');
```
