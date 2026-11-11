// A caller owns the database connection, location, permissions and backup.
// Initialization is explicit: ordinary reads never create or reset a database.
export function initializeTimetableStore(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      throw new Error('Database is not empty');
    }
    db.exec(`
    CREATE TABLE businesses (id TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE staff (
      business_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (business_id, id),
      FOREIGN KEY (business_id) REFERENCES businesses(id)
    );
    CREATE TABLE memberships (
      issuer TEXT NOT NULL, subject TEXT NOT NULL,
      business_id TEXT NOT NULL, staff_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('ADMIN', 'VIEWER')),
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      PRIMARY KEY (issuer, subject),
      FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id)
    );
    CREATE TABLE history (
      business_id TEXT NOT NULL, id TEXT NOT NULL, staff_id TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT,
      PRIMARY KEY (business_id, id),
      FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id)
    );
    PRAGMA user_version = 1;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createTimetableStore(db) {
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![1, 2, 3, 4].includes(version)) throw new Error('Unsupported database version');
  if (version >= 2) db.prepare('SELECT id, business_id, operation, staff_id, record_id, created_at, actor_kind FROM audit_events LIMIT 0');
  if (version >= 3) db.prepare('SELECT id, business_id, actor_staff_id, operation, staff_id, record_id, created_at FROM authenticated_audit_events LIMIT 0');
  if (version >= 4) db.prepare('SELECT id, business_id, actor_staff_id, staff_id, record_id, ends_at, created_at FROM history_close_events LIMIT 0');
  const authorizedHistory = db.prepare(`SELECT h.business_id AS businessId, h.staff_id AS recordStaffId,
    h.id, h.starts_at AS startsAt, h.ends_at AS endsAt, m.staff_id AS actorStaffId, m.role, m.active
    FROM memberships m JOIN history h ON h.business_id = m.business_id
    WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND h.id = ?`);
  const ownHistory = db.prepare(`SELECT h.id, h.starts_at AS startsAt, h.ends_at AS endsAt
    FROM memberships m LEFT JOIN history h ON h.business_id = m.business_id AND h.staff_id = m.staff_id
      AND (? IS NULL OR (h.starts_at, h.id) < (?, ?))
    WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND m.role IN ('VIEWER', 'ADMIN')
    ORDER BY h.starts_at DESC, h.id DESC LIMIT ?`);
  return {
    async findOwnHistory(issuer, subject, cursor, limit) {
      const rows = ownHistory.all(cursor?.startsAt ?? null, cursor?.startsAt ?? null, cursor?.id ?? null, issuer, subject, limit);
      return rows.length ? rows.filter((row) => row.id !== null) : null;
    },
    async findAccessAndHistory(issuer, subject, recordId) {
      const row = authorizedHistory.get(issuer, subject, recordId);
      return row ? {
        actor: { businessId: row.businessId, staffId: row.actorStaffId, role: row.role, active: row.active === 1 },
        record: { businessId: row.businessId, staffId: row.recordStaffId, id: row.id, startsAt: row.startsAt, endsAt: row.endsAt },
      } : null;
    },
  };
}
