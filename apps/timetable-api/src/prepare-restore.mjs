import { prepareRestoredDatabase } from '@vintage/timetable-store/prepare-restore';

try {
  const result = await prepareRestoredDatabase(process.env.VINTAGE_BACKUP_FILE, process.env.VINTAGE_PREPARED_RESTORE_FILE);
  console.log('Prepared a new offline copy with staff disabled and service startup blocked. Verify an administrator before recovery.');
  if (result.cleanupIncomplete) console.error('A .vintage-restore-* staging folder may remain; inspect it securely.');
} catch {
  console.error('Restore preparation failed. Existing files were not overwritten; inspect the protected destination folder for .vintage-restore-* or .vintage-copy-* staging folders.');
  process.exitCode = 1;
}
