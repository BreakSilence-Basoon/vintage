import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLedgerFact } from '../src/index.mjs';

const example = { id: 'example-a', type: 'invoice-issued', date: '2024-02-29', currency: 'XXX', amountMinor: '100' };

test('records each explicit fact independently and preserves exact integer strings', () => {
  for (const type of ['invoice-issued', 'payment-made', 'reimbursement-settled']) {
    const amountMinor = '9'.repeat(80);
    const input = { ...example, type, amountMinor };
    const result = validateLedgerFact(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
    assert.equal(Object.isFrozen(result), true);
    input.amountMinor = '0';
    assert.equal(result.amountMinor, amountMinor);
  }
  assert.equal(validateLedgerFact({ ...example, amountMinor: '-5' }).amountMinor, '-5');
  assert.equal(validateLedgerFact({ ...example, amountMinor: '0' }).amountMinor, '0');
  assert.deepEqual(validateLedgerFact({ ...example, description: 'Example item' }), { ...example, description: 'Example item' });
});

test('rejects invalid shapes without echoing the input', () => {
  const invalid = [null, [], {}, { ...example, id: '' }, { ...example, type: 'paid' },
    { ...example, date: '2023-02-29' }, { ...example, date: '0000-01-01' }, { ...example, date: '2024-13-01' },
    { ...example, currency: 'xx' }, { ...example, currency: 'xxx' }, { ...example, amountMinor: 100 },
    { ...example, amountMinor: '1.00' }, { ...example, amountMinor: '-0' }, { ...example, amountMinor: '01' },
    { ...example, amountMinor: '9'.repeat(81) }, { ...example, extra: 'example-secret' },
    { ...example, description: '' }, { ...example, description: ' leading' }, { ...example, description: 'a\nb' },
    { ...example, description: 'x'.repeat(501) }, { ...example, description: null }, { ...example, description: '\ud800' }];
  for (const input of invalid) assert.throws(() => validateLedgerFact(input), (error) => error.message === 'Invalid ledger fact');
});
