import { validateLedgerFact } from '@vintage/ledger-facts';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const types = new Set(['invoice-issued', 'payment-made', 'reimbursement-settled']);
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['limit','type','from','to','currency','amountMinor','cursor'].includes(key))) throw new Error('Invalid search');
  const limit = input.limit ?? 20, type = input.type ?? null, from = input.from ?? null, to = input.to ?? null;
  const currency = input.currency ?? null, amount = input.amountMinor ?? null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (type !== null && !types.has(type)) ||
      (from !== null && !date(from)) || (to !== null && !date(to)) || (from !== null && to !== null && from >= to) ||
      (currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) ||
      (amount !== null && (currency === null || typeof amount !== 'string' || !/^(?:0|[1-9][0-9]{0,79}|-[1-9][0-9]{0,79})$/.test(amount)))) throw new Error('Invalid search');
  let after = '';
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 768 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error('Invalid cursor');
    const raw = Buffer.from(input.cursor, 'base64url');
    if (raw.toString('base64url') !== input.cursor) throw new Error('Invalid cursor');
    const data = JSON.parse(raw.toString('utf8'));
    const old = Array.isArray(data) && data.length === 5 && data[0] === 1 && currency === null && amount === null;
    const current = Array.isArray(data) && data.length === 7 && data[0] === 2 && data[5] === currency && data[6] === amount;
    if ((!old && !current) || !id(data[1]) || data[2] !== type || data[3] !== from || data[4] !== to) throw new Error('Invalid cursor');
    after = data[1];
  }
  return { limit, type, from, to, currency, amount, after };
}

// Caller owns the read transaction and must verify current authorization within it.
export function listLedgerFactsInTransaction(db, input) {
  const { limit, type, from, to, currency, amount, after } = parse(input);
  const rows = db.prepare(`SELECT id,revision,fact_json FROM ledger_facts WHERE id>?
    AND (? IS NULL OR json_extract(fact_json,'$.type')=?)
    AND (? IS NULL OR json_extract(fact_json,'$.date')>=?)
    AND (? IS NULL OR json_extract(fact_json,'$.date')<?)
    AND (? IS NULL OR json_extract(fact_json,'$.currency')=?)
    AND (? IS NULL OR json_extract(fact_json,'$.amountMinor')=?) ORDER BY id LIMIT ?`)
    .all(after, type, type, from, from, to, to, currency, currency, amount, amount, limit + 1);
  const items = rows.slice(0, limit).map((row) => {
    const fact = validateLedgerFact(JSON.parse(row.fact_json));
    if (fact.id !== row.id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid record');
    return { revision: row.revision, fact };
  });
  const cursor = currency === null && amount === null ? [1, items.at(-1)?.fact.id, type, from, to] : [2, items.at(-1)?.fact.id, type, from, to, currency, amount];
  const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
  return { items, nextCursor };
}
