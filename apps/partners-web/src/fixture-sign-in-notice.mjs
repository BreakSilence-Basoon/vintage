const notices = Object.freeze({
  LoginServiceUnavailable: { title: '로그인 서비스에 연결하지 못했습니다.', message: '잠시 후 다시 시도해주세요.' },
  SessionExpired: { title: '다시 로그인이 필요합니다.', message: '로그인 상태를 다시 확인해야 합니다. 다시 로그인해 주세요.' },
  ReauthRequired: { title: '다시 로그인이 필요합니다.', message: '로그인 상태를 다시 확인해야 합니다. 다시 로그인해 주세요.' },
  StaffAccessDenied: { title: '직원 권한을 확인하지 못했습니다.', message: '이 앱의 직원 권한을 확인하지 못했습니다. 관리자에게 문의해주세요.' },
  GlobalLogoutUnavailable: { title: '회사 전체 로그아웃을 확인하지 못했습니다.', message: '관리자에게 문의해 주세요.' },
  AccessDenied: { title: '로그인을 완료하지 못했습니다.', message: '회사 계정 정보를 확인하지 못했습니다. 다시 로그인해주세요.' },
  Configuration: { title: '로그인 설정을 확인하지 못했습니다.', message: '회사 로그인 설정을 확인할 수 없습니다. 관리자에게 문의해주세요.' },
});
const failed = Object.freeze({ title: '로그인을 완료하지 못했습니다.', message: '로그인을 완료하지 못했습니다. 다시 시도해주세요.' });
export function fixtureSignInNotice(code) {
  if (typeof code !== 'string' || !code) return null;
  return Object.hasOwn(notices, code) ? notices[code] : failed;
}
