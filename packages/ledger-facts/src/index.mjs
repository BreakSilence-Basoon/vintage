// This validates explicitly supplied facts only. It does not authenticate, store, reconcile or calculate money.
const types = new Set(['invoice-issued', 'payment-made', 'reimbursement-settled']);
const keys = ['id', 'type', 'date', 'currency', 'amountMinor'];

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateLedgerFact(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)) ||
      typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) ||
      !types.has(input.type) || !validDate(input.date) ||
      typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency) ||
      typeof input.amountMinor !== 'string' || !/^(?:0|[1-9][0-9]{0,79}|-[1-9][0-9]{0,79})$/.test(input.amountMinor)) {
    throw new Error('Invalid ledger fact');
  }
  return Object.freeze({ id: input.id, type: input.type, date: input.date, currency: input.currency, amountMinor: input.amountMinor });
}
