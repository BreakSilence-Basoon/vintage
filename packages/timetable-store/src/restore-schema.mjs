export const restorePreparationSchema = `CREATE TABLE restore_preparation_events (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, token_cutoff INTEGER NOT NULL,
  disabled_devices INTEGER NOT NULL, invalidated_challenges INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'local-operator')
); PRAGMA user_version = 12;`;
