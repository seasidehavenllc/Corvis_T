import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSolPairs, passesFilters, exitReason, todayPnl, createEngine, STRATEGY_DEFAULTS, SOL_MINT } from '../engine.js';

const now = Date.parse('2026-10-27T12:00:00Z');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
function pair(overrides = {}) {
  return {
    chainId: 'solana', url: 'https://dexscreener.com/solana/x',
    baseToken: { address: MINT, symbol: 'TEST' }, quoteToken: { address: SOL_MINT },
    priceNative: '0.001', liquidity: { usd: 20000 }, txns: { m5: { buys: 40 } },
    pairCreatedAt: now - 5 * 60_000, ...overrides
  };
}
const bot = { ...STRATEGY_DEFAULTS, id: 'b1', name: 'Test', enabled: true, takeProfitMultiplier: 1.5, stopLossPercent: 20, maxPositionSol: 0.1, stats: { trades: 0, wins: 0, losses: 0, realizedPnlSol: 0, feesSol: 0 } };

test('bestSolPairs keeps the most liquid SOL-quoted pair per token', () => {
  const best = bestSolPairs([pair({ liquidity: { usd: 1 } }), pair(), pair({ quoteToken: { address: 'USDC' }, liquidity: { usd: 1e9 } }), pair({ chainId: 'base' })]);
  assert.equal(best.size, 1);
  assert.equal(best.get(MINT).liquidity.usd, 20000);
});
test('entry filters reject thin, old or quiet pairs', () => {
  assert.deepEqual(passesFilters(pair(), bot, now), []);
  assert.deepEqual(passesFilters(pair({ liquidity: { usd: 10 } }), bot, now), ['liquidity']);
  assert.deepEqual(passesFilters(pair({ pairCreatedAt: now - 3 * 3600_000 }), bot, now), ['age']);
  assert.deepEqual(passesFilters(pair({ txns: { m5: { buys: 1 } } }), bot, now), ['buys', 'momentum']);
  assert.deepEqual(passesFilters(pair({ txns: { m5: { buys: 40, sells: 60 } } }), bot, now), ['momentum']);
});
test('exit rules: take profit, stop loss, max hold', () => {
  const pos = { entryPrice: 1, openedAt: new Date(now - 60_000).toISOString() };
  assert.equal(exitReason(pos, bot, 1.5, now), 'take_profit');
  assert.equal(exitReason(pos, bot, 0.8, now), 'stop_loss');
  assert.equal(exitReason(pos, bot, 1.1, now), null);
  assert.equal(exitReason({ ...pos, openedAt: new Date(now - 2 * 3600_000).toISOString() }, bot, 1.1, now), 'max_hold');
});
test('trailing stop arms after a rise and sells on pullback from the peak', () => {
  const b = { ...bot, takeProfitMultiplier: 3, trailingStopPercent: 10 };
  const pos = { entryPrice: 1, openedAt: new Date(now - 60_000).toISOString() };
  assert.equal(exitReason({ ...pos, peakPrice: 1.05 }, b, 0.95, now), null); // not armed yet
  assert.equal(exitReason({ ...pos, peakPrice: 1.5 }, b, 1.4, now), null);   // 6.7% off peak
  assert.equal(exitReason({ ...pos, peakPrice: 1.5 }, b, 1.34, now), 'trailing_stop');
});
test('todayPnl only counts today', () => {
  const trades = [{ botId: 'b1', pnlSol: -0.1, closedAt: '2026-10-27T01:00:00Z' }, { botId: 'b1', pnlSol: -5, closedAt: '2026-10-26T01:00:00Z' }];
  assert.equal(todayPnl(trades, 'b1', now), -0.1);
});

test('paper engine buys a safe candidate and sells at take profit', async () => {
  let price = '0.001';
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }]
      : url.includes('token-boosts') ? []
      : [pair({ priceNative: price, pairCreatedAt: Date.now() - 60_000 })]
  });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl });
  await engine.tick();
  assert.equal(db.positions.length, 1);
  assert.ok(Math.abs(db.bots[0].paperBalanceSol - 0.9) < 1e-9);
  price = '0.002';
  await engine.tick();
  assert.equal(db.positions.length, 0);
  assert.equal(db.trades.length, 1);
  assert.equal(db.trades[0].reason, 'take_profit');
  assert.ok(db.trades[0].pnlSol > 0.09);
  assert.equal(db.bots[0].stats.wins, 1);
});

test('engine skips tokens with an active mint authority', async () => {
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [pair({ pairCreatedAt: Date.now() - 60_000 })] });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: 'someone', freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl });
  await engine.tick();
  assert.equal(db.positions.length, 0);
});

test('live bots never trade when live trading is not allowed', async () => {
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [pair({ pairCreatedAt: Date.now() - 60_000 })] });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, mode: 'live', stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => { throw new Error('should not sign'); }, liveAllowed: false, fetchImpl });
  await engine.tick();
  assert.equal(db.positions.length, 0);
});
