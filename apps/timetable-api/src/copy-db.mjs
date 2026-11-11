import { copyTimetableDatabase } from '@vintage/timetable-store/backup';

try {
  const mode = process.argv[2];
  if (mode !== 'backup' && mode !== 'restore') throw new Error('Invalid operation');
  const source = mode === 'backup' ? process.env.VINTAGE_DATABASE_FILE : process.env.VINTAGE_BACKUP_FILE;
  const destination = mode === 'backup' ? process.env.VINTAGE_BACKUP_FILE : process.env.VINTAGE_DATABASE_FILE;
  await copyTimetableDatabase(source, destination);
  console.log('Database copy completed and integrity checked.');
  if (mode === 'restore') console.error('This is an unchanged copy: tokens, device credentials and challenges may be restored. Do not use before recovery security and staff authority checks.');
} catch {
  console.error('Database copy failed. Existing files are never overwritten; inspect the destination directory for a .vintage-copy-* staging folder.');
  process.exitCode = 1;
}
