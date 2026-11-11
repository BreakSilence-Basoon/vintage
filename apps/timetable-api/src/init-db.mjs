import { openSync, closeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeTimetableStore } from '@vintage/timetable-store';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value;

export function initializeNewDatabase(path, input) {
  let issuer;
  try { issuer = new URL(input?.issuer); } catch { throw new Error('Invalid initialization'); }
  if (!isAbsolute(path ?? '') || !id(input?.businessId) || !id(input?.staffId) || !subject(input?.subject) ||
      issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash ||
      typeof input.issuer !== 'string' || input.issuer.trim() !== input.issuer) throw new Error('Invalid initialization');
  // Exclusive creation refuses existing files, including links; never reset an existing database.
  const descriptor = openSync(path, 'wx', 0o600);
  closeSync(descriptor);
  const db = new DatabaseSync(path);
  try {
    initializeTimetableStore(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO businesses (id) VALUES (?)').run(input.businessId);
      db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(input.businessId, input.staffId);
      db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
        .run(input.issuer, input.subject, input.businessId, input.staffId, 'ADMIN', 1);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 8192) throw new Error('Input too large');
      chunks.push(chunk);
    }
    initializeNewDatabase(process.env.VINTAGE_DATABASE_FILE, JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')));
    console.log('Database initialized.');
  } catch {
    console.error('Initialization failed. Existing files are never overwritten; inspect any new file before retrying.');
    process.exitCode = 1;
  }
}
