import { setLedgerGrantWithBackup } from '@vintage/ledger-store/authority';

try {
  if (process.argv.length !== 3 || process.argv[2] !== 'change') throw new Error('Invalid command');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 8192) throw new Error('Too large'); chunks.push(chunk); }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, ''));
  await setLedgerGrantWithBackup(process.env.VINTAGE_LEDGER_DATABASE_FILE, process.env.VINTAGE_LEDGER_BACKUP_FILE, input);
  console.log('Ledger grant change completed.');
} catch {
  console.error('Ledger grant change failed. Preserve the database and any created backup before checking the input.');
  process.exitCode = 1;
}
