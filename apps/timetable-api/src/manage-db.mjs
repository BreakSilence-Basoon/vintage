import { applyLocalOperation, migrateWithBackup } from '@vintage/timetable-store/operations';

try {
  const operation = process.argv[2];
  if (operation === 'migrate') {
    await migrateWithBackup(process.env.VINTAGE_DATABASE_FILE, process.env.VINTAGE_BACKUP_FILE);
  } else if (operation === 'add-viewer' || operation === 'add-history' || operation === 'deactivate-viewer') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 8192) throw new Error('Input too large');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    applyLocalOperation(process.env.VINTAGE_DATABASE_FILE, operation, input);
  } else throw new Error('Unknown operation');
  console.log('Local operation completed.');
} catch {
  console.error('Local operation failed. Data and any completed backup were preserved; check the configuration and input.');
  process.exitCode = 1;
}
