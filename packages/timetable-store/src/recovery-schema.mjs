export const recoveryGuardSchema = `CREATE TABLE recovery_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1), preparation_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'unlocked')),
  FOREIGN KEY (preparation_id) REFERENCES restore_preparation_events(id)
); CREATE TABLE recovery_admin_candidates (
  preparation_id INTEGER NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  business_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  PRIMARY KEY (preparation_id, issuer, subject),
  FOREIGN KEY (preparation_id) REFERENCES restore_preparation_events(id),
  FOREIGN KEY (issuer, subject) REFERENCES memberships(issuer, subject),
  FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id)
); CREATE TABLE recovery_admin_unlock_events (
  id INTEGER PRIMARY KEY, preparation_id INTEGER NOT NULL UNIQUE, business_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK (actor_kind = 'local-operator'),
  FOREIGN KEY (preparation_id) REFERENCES restore_preparation_events(id),
  FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id)
); PRAGMA user_version = 13;`;
