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
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Unsupported database version');
  const authorizedHistory = db.prepare(`SELECT h.business_id AS businessId, h.staff_id AS recordStaffId,
    h.id, h.starts_at AS startsAt, h.ends_at AS endsAt, m.staff_id AS actorStaffId, m.role, m.active
    FROM memberships m JOIN history h ON h.business_id = m.business_id
    WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND h.id = ?`);
  return {
    async findAccessAndHistory(issuer, subject, recordId) {
      const row = authorizedHistory.get(issuer, subject, recordId);
      return row ? {
        actor: { businessId: row.businessId, staffId: row.actorStaffId, role: row.role, active: row.active === 1 },
        record: { businessId: row.businessId, staffId: row.recordStaffId, id: row.id, startsAt: row.startsAt, endsAt: row.endsAt },
      } : null;
    },
  };
}
