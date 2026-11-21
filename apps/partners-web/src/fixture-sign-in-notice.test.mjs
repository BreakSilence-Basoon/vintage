import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSignInNotice } from './fixture-sign-in-notice.mjs';

test('sign-in notices follow the original error categories without proving access or expiry', () => {
  assert.equal(fixtureSignInNotice(undefined), null);
  assert.equal(fixtureSignInNotice(''), null);
  const cases = [
    ['LoginServiceUnavailable', '로그인 서비스에 연결하지 못했습니다.'],
    ['SessionExpired', '다시 로그인이 필요합니다.'], ['ReauthRequired', '다시 로그인이 필요합니다.'],
    ['StaffAccessDenied', '직원 권한을 확인하지 못했습니다.'], ['GlobalLogoutUnavailable', '회사 전체 로그아웃을 확인하지 못했습니다.'],
    ['AccessDenied', '로그인을 완료하지 못했습니다.'], ['Configuration', '로그인 설정을 확인하지 못했습니다.'],
    ['OAuthCallbackError', '로그인을 완료하지 못했습니다.'], ['__proto__', '로그인을 완료하지 못했습니다.'],
  ];
  for (const [code, title] of cases) assert.equal(fixtureSignInNotice(code).title, title);
  assert.equal(fixtureSignInNotice('AccessDenied').message, '회사 계정 정보를 확인하지 못했습니다. 다시 로그인해주세요.');
  assert.equal(fixtureSignInNotice('Configuration').message, '회사 로그인 설정을 확인할 수 없습니다. 관리자에게 문의해주세요.');
  assert.equal(fixtureSignInNotice('__proto__').message, '로그인을 완료하지 못했습니다. 다시 시도해주세요.');
  assert.equal(fixtureSignInNotice('SessionExpired').title === '로그인이 만료됐습니다.', false);
});
