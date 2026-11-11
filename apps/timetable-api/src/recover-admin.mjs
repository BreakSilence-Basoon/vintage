import { unlockRecoveredAdmin } from '@vintage/timetable-store/recover-admin';

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8192) throw new Error('Input too large');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  unlockRecoveredAdmin(process.env.VINTAGE_PREPARED_RESTORE_FILE, input);
  console.log('One verified administrator was enabled. Review all other staff access before reactivation.');
} catch {
  console.error('Administrator recovery failed or could not be confirmed. Inspect the prepared copy before retrying.');
  process.exitCode = 1;
}
