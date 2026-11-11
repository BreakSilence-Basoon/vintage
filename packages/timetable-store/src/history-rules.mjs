export function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

// Intervals are [start, end); null end is open-ended. Call only inside a write transaction.
export function historyOverlaps(db, businessId, staffId, startsAt, endsAt, excludedId = null) {
  return Boolean(db.prepare(`SELECT 1 FROM history
    WHERE business_id = ? AND staff_id = ? AND (? IS NULL OR id <> ?) AND (? IS NULL OR starts_at < ?)
      AND (ends_at IS NULL OR ends_at > ?) LIMIT 1`)
    .get(businessId, staffId, excludedId, excludedId, endsAt, endsAt, startsAt));
}
