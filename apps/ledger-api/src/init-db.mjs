import { closeSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeLedgerStore } from '@vintage/ledger-store';
import { initializeLedgerAuthority, setLedgerGrant } from '@vintage/ledger-store/authority';

// Trusted local operator only. Failure can leave a new partial file; it is never deleted automatically.
export function initializeNewLedgerDatabase(path, input) {
  if (!isAbsolute(path ?? '') || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.hasOwn(input, 'businessId') || !Object.hasOwn(input, 'grant')) throw new Error('Invalid initialization');
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
  const db = new DatabaseSync(path);
  try { initializeLedgerStore(db); initializeLedgerAuthority(db, input.businessId); setLedgerGrant(db, input.grant); }
  finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 8192) throw new Error('Too large'); chunks.push(chunk); }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, ''));
    initializeNewLedgerDatabase(process.env.VINTAGE_LEDGER_DATABASE_FILE, input);
    console.log('Ledger initialization completed.');
  } catch {
    console.error('Ledger initialization failed. Preserve and inspect any new file before retrying.');
    process.exitCode = 1;
  }
}
