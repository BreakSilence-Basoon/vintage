import { validateLedgerFact } from '@vintage/ledger-facts';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const types = new Set(['invoice-issued', 'payment-made', 'reimbursement-settled']);
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function parse(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['limit','type','from','to','currency','amountMinor','descriptionContains','cursor'].includes(key))) throw new Error('Invalid search');
  const limit = input.limit ?? 20, type = input.type ?? null, from = input.from ?? null, to = input.to ?? null;
  const currency = input.currency ?? null, amount = input.amountMinor ?? null;
  const text = input.descriptionContains ?? null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (type !== null && !types.has(type)) ||
      (from !== null && !date(from)) || (to !== null && !date(to)) || (from !== null && to !== null && from >= to) ||
      (currency !== null && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) ||
      (amount !== null && (currency === null || typeof amount !== 'string' || !/^(?:0|[1-9][0-9]{0,79}|-[1-9][0-9]{0,79})$/.test(amount))) ||
      (text !== null && (typeof text !== 'string' || text.length < 1 || text.length > 100 || !text.isWellFormed() || text !== text.trim() || /[\x00-\x1f\x7f]/.test(text)))) throw new Error('Invalid search');
  let after = '';
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error('Invalid cursor');
    const raw = Buffer.from(input.cursor, 'base64url');
    if (raw.toString('base64url') !== input.cursor) throw new Error('Invalid cursor');
    const data = JSON.parse(raw.toString('utf8'));
    const old = Array.isArray(data) && data.length === 5 && data[0] === 1 && currency === null && amount === null && text === null;
    const prior = Array.isArray(data) && data.length === 7 && data[0] === 2 && data[5] === currency && data[6] === amount && text === null;
    const current = Array.isArray(data) && data.length === 8 && data[0] === 3 && data[5] === currency && data[6] === amount && data[7] === text;
    if ((!old && !prior && !current) || !id(data[1]) || data[2] !== type || data[3] !== from || data[4] !== to) throw new Error('Invalid cursor');
    after = data[1];
  }
  return { limit, type, from, to, currency, amount, text, after };
}

// Caller owns the read transaction and must verify current authorization within it.
export function listLedgerFactsInTransaction(db, input) {
  const { limit, type, from, to, currency, amount, text, after } = parse(input);
  const rows = db.prepare(`SELECT id,revision,fact_json FROM ledger_facts WHERE id>?
    AND (? IS NULL OR json_extract(fact_json,'$.type')=?)
    AND (? IS NULL OR json_extract(fact_json,'$.date')>=?)
    AND (? IS NULL OR json_extract(fact_json,'$.date')<?)
    AND (? IS NULL OR json_extract(fact_json,'$.currency')=?)
    AND (? IS NULL OR json_extract(fact_json,'$.amountMinor')=?)
    AND (? IS NULL OR instr(json_extract(fact_json,'$.description'),?)>0) ORDER BY id LIMIT ?`)
    .all(after, type, type, from, from, to, to, currency, currency, amount, amount, text, text, limit + 1);
  const items = rows.slice(0, limit).map((row) => {
    const fact = validateLedgerFact(JSON.parse(row.fact_json));
    if (fact.id !== row.id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error('Invalid record');
    return { revision: row.revision, fact };
  });
  const cursor = text !== null ? [3, items.at(-1)?.fact.id, type, from, to, currency, amount, text] : currency === null && amount === null ? [1, items.at(-1)?.fact.id, type, from, to] : [2, items.at(-1)?.fact.id, type, from, to, currency, amount];
  const nextCursor = rows.length > limit ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
  return { items, nextCursor };
}
