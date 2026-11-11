import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';

test('concurrent reactivations create one audit and invalidate earlier tokens', async () => {
  const prefix = join(tmpdir(), 'vintage-reactivation-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    for (const staff of ['admin-a', 'staff-a']) db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', staff);
    const insert = db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)');
    insert.run('https://identity.example.invalid', 'example-admin', 'shop-a', 'admin-a', 'ADMIN', 1);
    insert.run('https://identity.example.invalid', 'example-user', 'shop-a', 'staff-a', 'VIEWER', 0);
    db.close();
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    backup = new DatabaseSync(join(temp, 'backup-v9.sqlite'), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 9);
    const before = Math.floor(Date.now() / 1000);
    const moduleUrl = new URL('../src/admin.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { applyAuthenticatedOperation } from ${JSON.stringify(moduleUrl)};
      const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=2000');
      try { applyAuthenticatedOperation(db, { issuer: 'https://identity.example.invalid', subject: 'example-admin', issuedAt: Math.floor(Date.now()/1000) }, 'reactivate-viewer',
        { staffId: 'staff-a', reason: 'Example restoration' }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = () => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', fail);
      child.on('close', (code) => code === 0 ? done(output) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all([run(), run()]);
    assert.deepEqual(outcomes.sort(), ['denied', 'ok']);
    db = new DatabaseSync(path, { readOnly: true });
    const result = db.prepare('SELECT active,token_valid_after FROM memberships WHERE subject = ?').get('example-user');
    assert.equal(result.active, 1);
    assert.ok(result.token_valid_after > before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM membership_reactivation_events').get().n, 1);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('reactivation migration failure preserves version 9 and its backup', async () => {
  const prefix = join(tmpdir(), 'vintage-reactivation-failure-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE membership_reactivation_events (example TEXT)');
    db.close();
    const backupPath = join(temp, 'backup-v9.sqlite');
    await assert.rejects(migrateWithBackup(path, backupPath));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('memberships') WHERE name = 'token_valid_after'").get().n, 0);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
