import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDevFeeLamports } from '../policy.js';

test('fee is 10% of positive realized profit, in lamports', () => {
  assert.equal(calculateDevFeeLamports(1, 10), 100_000_000);
  assert.equal(calculateDevFeeLamports(0.125, 10), 12_500_000);
});
test('no fee is charged on zero or negative profit', () => {
  assert.equal(calculateDevFeeLamports(0, 10), 0);
  assert.equal(calculateDevFeeLamports(-0.5, 10), 0);
});
test('custom fee percentages are supported within safe bounds', () => {
  assert.equal(calculateDevFeeLamports(2, 5), 100_000_000);
  assert.throws(() => calculateDevFeeLamports(1, 101), /between 0 and 100/);
});
