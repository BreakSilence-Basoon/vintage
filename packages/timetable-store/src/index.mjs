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
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(version)) throw new Error('Unsupported database version');
  if (version >= 2) db.prepare('SELECT id, business_id, operation, staff_id, record_id, created_at, actor_kind FROM audit_events LIMIT 0');
  if (version >= 3) db.prepare('SELECT id, business_id, actor_staff_id, operation, staff_id, record_id, created_at FROM authenticated_audit_events LIMIT 0');
  if (version >= 4) db.prepare('SELECT id, business_id, actor_staff_id, staff_id, record_id, ends_at, created_at FROM history_close_events LIMIT 0');
  if (version >= 5 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'history_owner_started_id' AND tbl_name = 'history'").get()) throw new Error('Missing history index');
  if (version >= 6) {
    db.prepare('SELECT business_id, id, label FROM schedule_locations LIMIT 0');
    db.prepare('SELECT business_id, id, staff_id, location_id, starts_at, ends_at, grace_minutes FROM scheduled_shifts LIMIT 0');
    db.prepare('SELECT business_id, actor_staff_id, operation, target_id, created_at FROM schedule_create_events LIMIT 0');
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'scheduled_shifts_owner_time' AND tbl_name = 'scheduled_shifts'").get()) throw new Error('Missing schedule index');
  }
  if (version >= 7) {
    db.prepare('SELECT revision, active FROM scheduled_shifts LIMIT 0');
    db.prepare('SELECT business_id, actor_staff_id, shift_id, operation, reason, before_json, after_json, created_at FROM schedule_change_events LIMIT 0');
  }
  if (version >= 8 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'scheduled_shifts_business_time' AND tbl_name = 'scheduled_shifts'").get()) throw new Error('Missing schedule index');
  const authorizedHistory = db.prepare(`SELECT h.business_id AS businessId, h.staff_id AS recordStaffId,
    h.id, h.starts_at AS startsAt, h.ends_at AS endsAt, m.staff_id AS actorStaffId, m.role, m.active
    FROM memberships m JOIN history h ON h.business_id = m.business_id
    WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND h.id = ?`);
  const ownHistoryQuery = (afterCursor) => db.prepare(`SELECT h.id, h.starts_at AS startsAt, h.ends_at AS endsAt
    FROM memberships m LEFT JOIN history h ON h.business_id = m.business_id AND h.staff_id = m.staff_id
      ${afterCursor ? 'AND (h.starts_at, h.id) < (?, ?)' : ''}
    WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND m.role IN ('VIEWER', 'ADMIN')
    ORDER BY h.starts_at DESC, h.id DESC LIMIT ?`);
  const firstOwnHistory = ownHistoryQuery(false);
  const nextOwnHistory = ownHistoryQuery(true);
  const ownShiftQuery = (afterCursor) => db.prepare(`SELECT s.id, s.starts_at AS startsAt, s.ends_at AS endsAt,
    s.grace_minutes AS graceMinutes, l.id AS locationId, l.label AS locationLabel
    FROM memberships m LEFT JOIN scheduled_shifts s ON s.business_id = m.business_id AND s.staff_id = m.staff_id
      AND s.starts_at < ? AND s.ends_at > ? ${version >= 7 ? 'AND s.active = 1' : ''} ${afterCursor ? 'AND (s.starts_at, s.id) < (?, ?)' : ''}
    LEFT JOIN schedule_locations l ON l.business_id = s.business_id AND l.id = s.location_id
    WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND m.role IN ('VIEWER', 'ADMIN')
    ORDER BY s.starts_at DESC, s.id DESC LIMIT ?`);
  const firstOwnShifts = version >= 6 ? ownShiftQuery(false) : null;
  const nextOwnShifts = version >= 6 ? ownShiftQuery(true) : null;
  return {
    async findOwnShifts(issuer, subject, from, to, cursor, limit) {
      if (!firstOwnShifts) throw new Error('Migration required');
      const rows = cursor ? nextOwnShifts.all(to, from, cursor.startsAt, cursor.id, issuer, subject, limit) :
        firstOwnShifts.all(to, from, issuer, subject, limit);
      return rows.length ? rows.filter((row) => row.id !== null) : null;
    },
    async findOwnHistory(issuer, subject, cursor, limit) {
      const rows = cursor ? nextOwnHistory.all(cursor.startsAt, cursor.id, issuer, subject, limit) : firstOwnHistory.all(issuer, subject, limit);
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
