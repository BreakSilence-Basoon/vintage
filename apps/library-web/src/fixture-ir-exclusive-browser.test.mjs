import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

test('isolated synthetic cleanup preserves file bytes and leaves other files available', { timeout: 240000 }, async () => {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { env: { ...process.env, NODE_ENV: 'development', VINTAD3E_LIBRARY_FIXTURE: '1', VINTAD3E_LIBRARY_FIXTURE_ORIGIN: origin }, stdio: 'ignore' });
  let browser;
  try {
    let ready = false; for (let i = 0; i < 120; i++) { try { if ((await fetch(`${origin}/sign-in`)).ok) { ready = true; break; } } catch {} await delay(250); } assert.ok(ready);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] });
    for (const width of [1440, 390]) {
      for (const objectId of ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000108']) {
        const loginContext = await browser.newContext({ viewport: { width, height: 844 } });
        try {
          const loginPage = await loginContext.newPage();
          await loginPage.goto(`${origin}/objects/${objectId}`);
          await loginPage.getByRole('button', { name: '회사 계정으로 로그인' }).click();
          await loginPage.waitForURL(`${origin}/objects/${objectId}`);
          assert.equal((await loginPage.request.get(`${origin}/objects/${objectId}`)).status(), 404);
        } finally { await loginContext.close(); }
      }
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      try {
        const page = await context.newPage(); await page.goto(`${origin}/sign-in`); await page.getByRole('button', { name: '회사 계정으로 로그인' }).click(); await page.waitForURL(`${origin}/`);
        async function prepare(kind) {
          return page.evaluate(async value => {
            const response = await fetch('/api/fixture/ir-confirmation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prepare', kind: value }) });
            if (!response.ok) throw new Error('prepare failed'); const proposal = await response.json();
            sessionStorage.setItem(`vintad3e-library-ir-recovery:${proposal.proposalId}`, proposal.proof); return proposal.proposalId;
          }, kind);
        }
        async function apply(kind) {
          const id = await prepare(kind); await page.goto(`${origin}/confirmations/${id}`);
          for (const label of ['제안 검토', '이 변경 확인', '변경 적용']) await page.getByRole('button', { name: label, exact: true }).click();
          await page.getByRole('status').filter({ hasText: '변경 결과를 확인했습니다.' }).waitFor();
        }
        await apply('single'); await apply('reserve');
        const uploadStatus = await page.evaluate(async () => (await fetch('/api/fixture/ir-exclusive-upload', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '업무를 시작하기 전에 필요한 사항을 확인합니다.' })).status);
        assert.equal(uploadStatus, 200);
        const sharedStatus = await page.evaluate(async () => (await fetch('/api/fixture/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-vintad3e-content-type': 'text/plain' }, body: '업무를 시작하기 전에 필요한 사항을 확인합니다.' })).status);
        assert.equal(sharedStatus, 200);
        await apply('isolated-attach');
        const objectPath = '/api/objects/00000000-0000-4000-8000-000000000108/source', sharedPath = '/api/objects/00000000-0000-4000-8000-000000000009/source';
        assert.equal((await page.request.get(`${origin}${objectPath}`)).status(), 200);
        await apply('delete');
        assert.equal((await page.request.get(`${origin}${objectPath}`)).status(), 200);
        await apply('cleanup');
        assert.equal((await page.request.get(`${origin}${objectPath}`)).status(), 404);
        assert.equal((await page.request.get(`${origin}${sharedPath}`)).status(), 200);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } finally { await context.close(); }
    }
  } finally { await browser?.close(); server.kill('SIGTERM'); if (server.exitCode === null) await Promise.race([once(server, 'exit'), delay(5000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
});
