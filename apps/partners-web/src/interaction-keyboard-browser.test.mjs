import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function enter(page, locator) { await locator.waitFor({ state: 'visible' }); await page.waitForFunction(el => !el.disabled, await locator.elementHandle()); await locator.focus(); await page.keyboard.press('Enter'); }

test('public guides navigate languages, copy and open images on desktop and mobile', { timeout: 120000 }, async () => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', VINTAD3E_PARTNERS_FIXTURE: '1', VINTAD3E_PARTNERS_FIXTURE_ORIGIN: origin }, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error('fixture server exited'); try { if ((await fetch(`${origin}/guide/dj`)).ok) { ready = true; break; } } catch {} await delay(250); }
    assert.ok(ready);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      try {
        const page = await context.newPage();
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (window.failGuideCopy) throw new Error('clipboard unavailable'); window.copiedGuide = text; } } }));
        await page.goto(`${origin}/guide/dj`);
        await enter(page, page.getByRole('link', { name: 'English', exact: true }));
        await page.waitForURL('**/guide/dj/en');
        await enter(page, page.getByRole('link', { name: 'House music guide', exact: true }));
        await page.waitForURL('**/guide/dj/en-house');
        await page.getByRole('heading', { name: 'House music guide', exact: true }).waitFor();
        await enter(page, page.getByRole('link', { name: 'DJ guide', exact: true }));
        await page.waitForURL('**/guide/dj/en');
        await enter(page, page.getByRole('link', { name: 'R&B and hip-hop music guide', exact: true }));
        await page.waitForURL('**/guide/dj/en-rnb-hiphop');
        await enter(page, page.getByRole('link', { name: '한국어', exact: true }));
        await page.waitForURL('**/guide/dj/ko-rnb-hiphop');
        assert.equal(await page.locator('nav[aria-label="가이드 탐색"] a[lang="ko"]').getAttribute('aria-current'), 'page');
        await enter(page, page.getByRole('link', { name: 'DJ 가이드로', exact: true }));
        await page.waitForURL('**/guide/dj');
        assert.equal((await page.goto(`${origin}/guide/dj/unknown`)).status(), 404);
        await page.goto(`${origin}/proj-bedroom/guide/ko`);
        await page.locator('.bedroom-read-time').getByText(/^약 \d+분$/u).waitFor();
        const disclosure = page.locator('#guide-disclosure-0');
        await enter(page, disclosure.locator('summary'));
        assert.equal(await disclosure.evaluate(element => element.open), true);
        await enter(page, page.getByRole('button', { name: '내용 복사', exact: true }));
        await page.waitForFunction(() => typeof window.copiedGuide === 'string' && window.copiedGuide.includes('# proj.bedroom'));
        await page.evaluate(() => { window.failGuideCopy = true; });
        await enter(page, page.getByRole('button', { name: '복사됨', exact: true }));
        await page.getByRole('status').filter({ hasText: '복사하지 못했습니다. 다시 눌러 주세요.' }).waitFor();
        await enter(page, page.getByRole('button', { name: /사진 크게 보기/ }).first());
        const dialog = page.getByRole('dialog', { name: '사진 크게 보기' });
        await dialog.waitFor();
        await enter(page, dialog.locator('.bedroom-zoom-controls').getByRole('button', { name: '확대', exact: true }));
        await enter(page, dialog.getByRole('button', { name: '닫기', exact: true }));
        await dialog.waitFor({ state: 'hidden' });
        await enter(page, page.getByRole('button', { name: '언어 선택', exact: true }));
        await enter(page, page.locator('.guest-language-float__choices button[lang=en]'));
        await page.waitForURL('**/proj-bedroom/guide/en');
        await page.getByText('Artist Brief', { exact: true }).waitFor();
        await page.locator('.bedroom-read-time').getByText(/^About \d+ min$/u).waitFor();
        await page.waitForFunction(() => document.querySelector('#guide-disclosure-0')?.open === true);
        await enter(page, page.getByRole('button', { name: 'Select language', exact: true }));
        await enter(page, page.locator('.guest-language-float__choices button[lang=ja]'));
        await page.waitForURL('**/proj-bedroom/guide/ja');
        await page.getByText('アーティスト向けブリーフ', { exact: true }).waitFor();
        await page.locator('.bedroom-read-time').getByText(/^約\d+分$/u).waitFor();
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('partner ledger and DJ form respond to keyboard input and errors', { timeout: 120000 }, async () => {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', VINTAD3E_PARTNERS_FIXTURE: '1', VINTAD3E_PARTNERS_FIXTURE_ORIGIN: origin }, stdio: 'ignore' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error('fixture server exited'); try { if ((await fetch(`${origin}/dj`)).ok) { ready = true; break; } } catch {} await delay(250); }
    assert.ok(ready);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await context.newPage();
      try {
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (window.failCopy) throw new Error('clipboard unavailable'); window.copiedText = text; } } }));
        await page.goto(`${origin}/sign-in?error=AccessDenied&next=%2Fdj`);
        await page.getByText('회사 계정 정보를 확인하지 못했습니다. 다시 로그인해주세요.', { exact: true }).waitFor();
        await page.waitForFunction(() => !new URL(location.href).searchParams.has('error'));
        assert.equal(new URL(page.url()).searchParams.get('next'), '/dj');
        await page.goto(`${origin}/accounts`);
        assert.equal(new URL(page.url()).pathname, '/sign-in');
        await page.goto(`${origin}/proj-bedroom/partner-01`);
        await page.waitForURL('**/sign-in?next=%2Fproj-bedroom%2Fpartner-01');
        await page.goto(`${origin}/proj-bedroom/partner-02`);
        await page.waitForURL('**/sign-in?next=%2Fproj-bedroom%2Fpartner-02');
        await page.goto(`${origin}/proj-bedroom/partner-01/guest`);
        assert.equal(new URL(page.url()).pathname, '/proj-bedroom/partner-01/sign-in');
        await page.goto(`${origin}/dj`);
        await page.waitForURL('**/sign-in?next=%2Fdj');
        await enter(page, page.getByRole('button', { name: '회사 계정으로 로그인' }));
        await page.waitForURL('**/dj');
        await page.goto(`${origin}/sign-in?mode=cover&mode=other&next=%2Fdj`);
        await page.getByRole('link', { name: 'Partners로 돌아가기' }).waitFor();
        await page.goto(`${origin}/dj`);
        await enter(page, page.getByRole('link', { name: 'staff01@example.invalid 로그인 전 화면 보기' }));
        await enter(page, page.getByRole('link', { name: 'Partners로 돌아가기' }));
        await page.waitForURL('**/dj');
        if (width === 390) {
          await enter(page, page.locator('summary[aria-label="메뉴"]'));
          await enter(page, page.getByRole('navigation', { name: 'Partners 모바일 메뉴' }).getByRole('link', { name: '계정 추가' }));
        } else {
          await enter(page, page.getByRole('navigation', { name: 'Partners 메뉴' }).getByRole('link', { name: '계정 추가' }));
        }
        await page.waitForURL('**/accounts');
        await page.goto(`${origin}/proj-bedroom/partner-01/sign-in`);
        assert.equal(await page.locator('.partners-staff-shell').count(), 0);
        await page.goto(`${origin}/guide/dj/ko`);
        assert.equal(await page.locator('.partners-staff-shell').count(), 0);
        await page.goto(`${origin}/dj`);
        const form = page.locator('.partners-accountant');
        await enter(page, form.getByRole('button', { name: '전달문 복사' }));
        await form.locator('input[aria-invalid="true"]').first().waitFor();
        assert.ok(await form.locator('input[aria-invalid="true"]').count() >= 3);
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
        const row = form.locator('.partners-accountant__row').first();
        const name = row.getByLabel('이름', { exact: true });
        const id = row.getByLabel('주민등록번호', { exact: true });
        const amount = row.getByLabel('입금 금액 (원)', { exact: true });
        await name.focus(); await page.keyboard.type('DJ A');
        await id.focus(); await page.keyboard.type('123');
        await amount.focus(); await page.keyboard.type('abc');
        await enter(page, form.getByRole('button', { name: '전달문 복사' }));
        assert.equal(await id.getAttribute('aria-invalid'), 'true');
        assert.equal(await amount.getAttribute('aria-invalid'), 'true');
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
        await id.fill('0000000000000'); await amount.fill('10000');
        await page.locator('.partners-accountant__preview').waitFor();
        assert.ok(!(await page.locator('.partners-accountant__preview').innerText()).includes('0000000000000'));
        await page.evaluate(() => { window.failCopy = true; });
        await enter(page, form.getByRole('button', { name: '전달문 복사' }));
        await form.getByRole('alert').waitFor();
        await page.evaluate(() => { window.failCopy = false; });
        await form.getByRole('button', { name: '전달문 복사' }).click();
        await form.getByRole('status').filter({ hasText: '복사했습니다.' }).waitFor();
        assert.ok(await page.evaluate(() => window.copiedText?.includes('DJ A 000000-0000000 10,000원')));
        await enter(page, form.getByRole('button', { name: 'DJ 추가' }));
        assert.equal(await form.locator('.partners-accountant__row').count(), 2);
        await enter(page, form.getByRole('button', { name: 'DJ 2 삭제' }));
        assert.equal(await form.locator('.partners-accountant__row').count(), 1);
        await enter(page, form.getByRole('button', { name: '입력 지우기' }));
        assert.equal(await form.getByLabel('이름', { exact: true }).inputValue(), '');

        const ledger = page.locator('.partners-ledger');
        await ledger.locator('input[name=from]').fill('2026-11-20');
        await ledger.locator('input[name=to]').fill('2026-11-01');
        await enter(page, ledger.getByRole('button', { name: '조회' }));
        await ledger.getByRole('alert').waitFor();
        await enter(page, ledger.getByRole('button', { name: '초기화' }));
        assert.equal(await ledger.getByRole('alert').count(), 0);
        await ledger.locator('input[name=query]').fill('찾을 수 없는 협업처');
        await enter(page, ledger.getByRole('button', { name: '조회' }));
        await ledger.locator('.staff-empty').waitFor();

        await page.goto(`${origin}/proj-bedroom/partner-01`);
        await enter(page,page.locator('.partners-history summary'));
        await page.getByRole('region',{name:'정산 항목'}).getByText('123,460원').waitFor();
        const settlement=page.getByRole('region',{name:'정산',exact:true});
        await settlement.locator('input[type=search]').fill('없는 협업처'); await settlement.getByText('브랜드를 찾을 수 없습니다.').waitFor();
        await settlement.locator('input[type=search]').fill('브랜드 01'); await settlement.getByRole('combobox',{name:'기간'}).selectOption('custom');
        await settlement.getByLabel('시작일').fill('2026-11-19'); await settlement.getByLabel('종료일').fill('2026-11-19'); await settlement.getByRole('button',{name:'닫기'}).click();
        await enter(page,settlement.getByRole('button',{name:'적용'})); await settlement.getByText('24,690원',{exact:true}).first().waitFor();
        assert.ok((await settlement.innerText()).includes('1,235원'));
        await enter(page,settlement.getByRole('button',{name:/판매액/})); await page.getByRole('dialog',{name:/판매 내역/}).waitFor();
        await enter(page,page.getByRole('button',{name:'판매 내역 창 닫기'})); assert.equal(await page.getByRole('dialog').count(),0);
        await enter(page,page.getByRole('button',{name:'숨김 0'})); await page.getByText('숨긴 상품이 없습니다.').waitFor();
        await enter(page,page.getByRole('button',{name:'진열 1'})); await enter(page,page.getByRole('button',{name:'협업 티셔츠 재고 상세 보기'}));
        await page.getByRole('dialog').waitFor(); assert.equal(await page.getByRole('dialog').getByRole('row').count(),3);
        await enter(page,page.getByRole('button',{name:'재고 상세 창 닫기'})); assert.equal(await page.getByRole('dialog').count(),0);
        await context.clearCookies();
        await page.goto(`${origin}/proj-bedroom/partner-01/guest`);
        assert.equal(new URL(page.url()).pathname, '/proj-bedroom/partner-01/sign-in');
        await enter(page, page.getByRole('button', { name: '게스트 계정으로 로그인하기' }));
        await page.waitForURL('**/proj-bedroom/partner-01/guest');
        await page.getByRole('heading', { name: /협업처 01/ }).waitFor();
        await page.goto(`${origin}/proj-bedroom/partner-01`);
        await page.waitForURL('**/sign-in?next=%2Fproj-bedroom%2Fpartner-01');
        await page.goto(`${origin}/proj-bedroom/partner-01/guest`);
        await page.getByRole('tab', { name: '하의' }).click();
        assert.equal(await page.getByRole('tab', { name: '하의' }).getAttribute('aria-selected'), 'true');
        await page.getByRole('status').filter({ hasText: '이 분류에 등록된 상품이 없습니다.' }).waitFor();
        await page.getByRole('tab', { name: '상의' }).click();
        await page.getByRole('button', { name: '협업 티셔츠' }).click();
        await page.getByRole('dialog').waitFor();
        assert.equal(await page.getByRole('dialog').getByRole('row').count(), 3);
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').count(), 0);
        if (width === 390) {
          await page.getByRole('button', { name: '정산 내역 보기' }).click();
          await page.waitForFunction(() => document.querySelector('[aria-label="정산 내역 보기"]')?.getAttribute('aria-current') === 'true');
        } else {
          await page.getByRole('region', { name: '정산 내역', exact: true }).waitFor();
        }
        await page.goto(`${origin}/proj-bedroom/partner-02/guest`);
        assert.equal(new URL(page.url()).pathname, '/proj-bedroom/partner-02/sign-in');
        await page.goto(`${origin}/proj-bedroom/partner-01/guest`);
        await page.getByRole('button', { name: '로그아웃', exact: true }).click();
        if (width === 390) await page.getByRole('button', { name: '로그아웃 하시겠습니까?' }).click();
        await page.waitForURL('**/proj-bedroom/partner-01/sign-in');
        await page.goto(`${origin}/proj-bedroom/partner-01/guest`);
        assert.equal(new URL(page.url()).pathname, '/proj-bedroom/partner-01/sign-in');
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close(); child.kill('SIGTERM');
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
