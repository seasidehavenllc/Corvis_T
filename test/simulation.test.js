import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../sim/run.js';

for (const seed of [1, 2, 3]) {
  test(`simulated market run (seed ${seed}): live accounting reconciles and safety holds`, async () => {
    const { report, summary, errors } = await simulate({ hours: 1.5, seed, quiet: true });
    assert.equal(summary.openPositions, 0, 'every position is closed after wind-down');
    for (const r of report) {
      assert.ok(r.trades > 0, `${r.bot} traded`);
      assert.equal(r.boughtUnsafe, 0, `${r.bot} never bought a token with an active mint authority`);
      assert.ok(Math.abs(r.pnlSol - r.walletChangeSol) < 1e-6, `${r.bot} recorded P&L matches its wallet (${r.pnlSol} vs ${r.walletChangeSol})`);
    }
    for (const e of errors) assert.match(e, /No Jupiter route/, 'the only errors are sells into rugged tokens');
  });
}
