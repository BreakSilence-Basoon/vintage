import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const cwd = fileURLToPath(new URL('./fixtures/selection/', import.meta.url));
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this test with corepack pnpm test.');
const run = (filter) => spawnSync(process.execPath, [pnpmCli, '--fail-if-no-match', '--filter', filter, '-r', 'run', 'probe'], {
  cwd, encoding: 'utf8',
});

test('selected app includes its shared package and excludes the other app', () => {
  const result = run('@vintage-fixture/first...');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^apps\/first probe: fixture:first\r?$/m);
  assert.match(result.stdout, /^packages\/shared probe: fixture:shared\r?$/m);
  assert.doesNotMatch(result.stdout, /^apps\/second probe: fixture:second\r?$/m);
});

test('unknown app fails rather than silently succeeding', () => {
  const result = run('@vintage-fixture/missing...');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /No projects matched/i);
});

test('offline filtered install links only the selected app dependency', () => {
  const prefix = join(tmpdir(), 'vintage-selection-');
  const temp = mkdtempSync(prefix);
  try {
    cpSync(cwd, temp, { recursive: true });
    const result = spawnSync(process.execPath, [pnpmCli, 'install', '--offline', '--ignore-scripts', '--filter', '@vintage-fixture/first...'], {
      cwd: temp, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(temp, 'apps/first/node_modules/@vintage-fixture/shared')));
    assert.equal(existsSync(join(temp, 'apps/second/node_modules/@vintage-fixture/shared')), false);
  } finally {
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
