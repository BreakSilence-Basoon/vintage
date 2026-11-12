import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyLedgerDatabase } from '@vintage/ledger-store/backup';
import { prepareLedgerRecovery, compareLedgerRecovery, unlockLedgerRecovery } from '@vintage/ledger-store/recovery';

// Offline trusted operator only. Never print paths, inputs or record contents.
try {
  if (process.argv.length !== 3) throw new Error('Invalid command');
  const source = process.env.VINTAGE_LEDGER_DATABASE_FILE;
  const destination = process.env.VINTAGE_LEDGER_DESTINATION_FILE;
  const reference = process.env.VINTAGE_LEDGER_REFERENCE_FILE;
  switch (process.argv[2]) {
    case 'backup':
      await copyLedgerDatabase(source, destination);
      console.log('Ledger backup completed.');
      break;
    case 'prepare':
      await prepareLedgerRecovery(source, destination);
      console.log('Ledger recovery copy prepared for review.');
      break;
    case 'compare':
      console.log(JSON.stringify(compareLedgerRecovery(source, reference)));
      break;
    case 'unlock': {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 8192) throw new Error('Too large'); chunks.push(chunk); }
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, ''));
      if (!isAbsolute(source ?? '') || !lstatSync(source).isFile()) throw new Error('Existing database required');
      const db = new DatabaseSync(source);
      try { unlockLedgerRecovery(db, input); } finally { db.close(); }
      console.log('Ledger recovery review recorded.');
      break;
    }
    default: throw new Error('Invalid command');
  }
} catch {
  console.error('Ledger recovery operation failed. Preserve the source and any created files before checking the result.');
  process.exitCode = 1;
}
