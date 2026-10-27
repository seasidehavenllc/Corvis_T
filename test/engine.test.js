import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSolPairs, passesFilters, exitReason, todayPnl, tradeJournal, createEngine, STRATEGY_DEFAULTS, SOL_MINT } from '../engine.js';

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
  assert.equal(exitReason({ ...pos, peakMultiple: 1.05 }, b, 0.95, now), null); // not armed yet
  assert.equal(exitReason({ ...pos, peakMultiple: 1.5 }, b, 1.4, now), null);   // 6.7% off peak
  assert.equal(exitReason({ ...pos, peakMultiple: 1.5 }, b, 1.34, now), 'trailing_stop');
});
test('todayPnl only counts today', () => {
  const trades = [{ botId: 'b1', pnlSol: -0.1, closedAt: '2026-10-27T01:00:00Z' }, { botId: 'b1', pnlSol: -5, closedAt: '2026-10-26T01:00:00Z' }];
  assert.equal(todayPnl(trades, 'b1', now), -0.1);
});

test('paper engine buys a safe candidate and sells at take profit', async () => {
  let price = '0.001';
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    const out = u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / Number(price) * 1e6 : amt / 1e6 * Number(price) * 1e9;
    return { outAmount: String(Math.floor(out)) };
  };
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }]
      : url.includes('token-boosts') ? []
      : [pair({ priceNative: price, pairCreatedAt: Date.now() - 60_000 })]
  });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl });
  await engine.tick();
  assert.equal(db.positions.length, 1);
  assert.ok(Math.abs(db.bots[0].paperBalanceSol - (0.9 - 0.000005 - STRATEGY_DEFAULTS.priorityFeeSol)) < 1e-9, 'paper pays the position plus network and priority fees');
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

// Real paper runs showed "take profit" sells that lost money: the price feed said 2x while the pool
// would only pay back 70%. Exits must follow what selling actually returns.
test('exits follow the real sell quote, not a price feed that disagrees with it', async () => {
  let feedPrice = '0.001', poolPrice = 0.001;
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    const out = u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / poolPrice * 1e6 : amt / 1e6 * poolPrice * 1e9;
    return { outAmount: String(Math.floor(out)) };
  };
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }]
      : url.includes('token-boosts') ? [] : [pair({ priceNative: feedPrice, pairCreatedAt: Date.now() - 60_000 })]
  });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl });
  await engine.tick();
  assert.equal(db.positions.length, 1);
  feedPrice = '0.002'; poolPrice = 0.0007;
  await engine.tick();
  assert.equal(db.trades.length, 1);
  assert.equal(db.trades[0].reason, 'stop_loss');
  assert.ok(db.trades[0].pnlSol < 0);
});

test('tokens that cannot be sold back are never bought', async () => {
  const fetchImpl = async url => {
    if (url.includes('/quote') && !url.includes(`inputMint=${SOL_MINT}`)) return { ok: false, status: 400, text: async () => '{"error":"No routes found"}', json: async () => ({}) };
    return { ok: true, json: async () => url.includes('/quote') ? { outAmount: '100000000' } : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [pair({ pairCreatedAt: Date.now() - 60_000 })] };
  };
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl });
  await engine.tick();
  assert.equal(db.positions.length, 0);
  assert.equal(db.bots[0].paperBalanceSol, 1);
});

test('an armed trailing stop never lets a winner turn into a loss', () => {
  const b = { ...bot, takeProfitMultiplier: 3, trailingStopPercent: 20 };
  const pos = { openedAt: new Date(now - 60_000).toISOString(), peakMultiple: 1.21 };
  assert.equal(exitReason(pos, b, 1.05, now), null);
  assert.equal(exitReason(pos, b, 0.99, now), 'trailing_stop');
});

test('rug filters reject dev-heavy, serial-launcher and flagged tokens', () => {
  const b = { ...bot, maxDevHoldingPct: 10, maxDevLaunches: 20, minHolders: 0, maxTopHoldersPct: 0 };
  const fresh = pair({ pairCreatedAt: now - 60_000 });
  assert.deepEqual(passesFilters({ ...fresh, devPct: 3, devMints: 2 }, b, now), []);
  assert.ok(passesFilters({ ...fresh, devPct: 25 }, b, now).includes('dev_holding'));
  assert.ok(passesFilters({ ...fresh, devMints: 300 }, b, now).includes('serial_launcher'));
  assert.ok(passesFilters({ ...fresh, isSus: true }, b, now).includes('flagged'));
  assert.ok(passesFilters(fresh, { ...b, minPairAgeMinutes: 5 }, now).includes('too_new'));
});

test('scaling out banks part at the first target and the rest cannot turn into a loss', async () => {
  let poolPrice = 0.001;
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    const out = u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / poolPrice * 1e6 : amt / 1e6 * poolPrice * 1e9;
    return { outAmount: String(Math.floor(out)) };
  };
  const fetchImpl = async url => ({
    ok: true,
    json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }]
      : url.includes('token-boosts') ? [] : [pair({ priceNative: String(poolPrice), pairCreatedAt: Date.now() - 60_000 })]
  });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const b = { ...bot, paperBalanceSol: 1, takeProfitMultiplier: 3, partialTakeProfitMultiplier: 1.3, partialSellPercent: 50, trailingStopPercent: 0, stats: { ...bot.stats } };
  const db = { bots: [b], trades: [], positions: [] };
  let t = Date.now();
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  await engine.tick();
  assert.equal(db.positions.length, 1);
  poolPrice = 0.0015; t += 20_000;
  await engine.monitor();
  assert.equal(db.positions.length, 1);
  assert.ok(db.positions[0].partialDone && db.positions[0].realizedSol > 0.07, 'half was sold at about 1.5x');
  poolPrice = 0.0005; t += 20_000; // the rest crashes 66%
  await engine.monitor();
  assert.equal(db.trades.length, 1);
  assert.equal(db.trades[0].reason, 'protect_profit');
  assert.ok(Math.abs(b.paperBalanceSol - (1 + db.trades[0].pnlSol)) < 1e-9, 'paper balance matches booked P&L');
});

test('trade journal groups closed trades by entry signal', () => {
  const trades = [
    { pnlSol: 0.02, features: { devPct: 0.5 } }, { pnlSol: -0.05, features: { devPct: 12 } }, { pnlSol: 0.01, features: { devPct: 0.2 } }
  ];
  const dev = tradeJournal(trades).find(s => s.key === 'devPct');
  assert.equal(dev.ranges[0].trades, 2);
  assert.equal(dev.ranges[0].winRate, 1);
  assert.equal(dev.ranges[3].trades, 1);
});

test('a stop loss that follows the price sits below the peak, not the buy price', () => {
  const pos = { entryPrice: 1, openedAt: new Date(now - 60_000).toISOString() };
  const b = { ...bot, takeProfitMultiplier: 5, stopLossPercent: 15, trailingStopPercent: 0, stopLossFollowsPrice: true };
  assert.equal(exitReason({ ...pos, peakMultiple: 1 }, b, 0.85, now), 'stop_loss');       // never rose: 15% below entry
  assert.equal(exitReason({ ...pos, peakMultiple: 1.5 }, b, 1.3, now), null);             // 13% off a 1.5x peak
  assert.equal(exitReason({ ...pos, peakMultiple: 1.5 }, b, 1.27, now), 'trailing_stop'); // 15% off the peak
  assert.equal(exitReason({ ...pos, peakMultiple: 1.5 }, { ...b, stopLossFollowsPrice: false }, 1.27, now), null);
});

test('a token whose pool is drained is flagged as unsellable instead of showing a stale value', async () => {
  let t = Date.now(), drained = false;
  const fetchImpl = async url => {
    if (drained && url.includes('/quote') && !url.includes(`inputMint=${SOL_MINT}`)) {
      return { ok: false, status: 400, text: async () => '{"error":"Cannot compute other amount threshold, with amount 1 and slippageBps 500","errorCode":"CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD"}', json: async () => ({}) };
    }
    return { ok: true, json: async () => url.includes('/quote') ? { outAmount: url.includes(`inputMint=${SOL_MINT}`) ? '100000000' : '99000000' } : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [pair({ pairCreatedAt: t - 60_000 })] };
  };
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  await engine.tick();
  assert.equal(db.positions.length, 1);
  drained = true; t += 20_000;
  await engine.tick();
  assert.match(db.positions[0].sellError, /no(body| Jupiter route)/i);
  assert.equal(db.positions[0].sellFailures, 1);
});

test('copycat tickers and tokens about to leave their bonding curve are skipped', () => {
  assert.deepEqual(passesFilters(pair({ baseToken: { address: MINT, symbol: 'sol' } }), bot, now), ['impostor']);
  assert.deepEqual(passesFilters(pair({ bondingCurvePct: 92 }), bot, now), ['graduating']);
  assert.deepEqual(passesFilters(pair({ bondingCurvePct: 40 }), bot, now), []);
});

test('pump.fun coins are priced from their bonding curve on chain, so a dump is caught on the next tick', async () => {
  let t = Date.now(), poolPrice = 0.001;
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    const out = u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / poolPrice * 1e6 : amt / 1e6 * poolPrice * 1e9;
    return { outAmount: String(Math.floor(out)) };
  };
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [pair({ pairCreatedAt: t - 60_000 })] });
  const { PublicKey } = await import('@solana/web3.js');
  const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  const curve = () => {
    const d = Buffer.alloc(49);
    const vToken = 1_000_000_000n * 1_000_000n; // 1B tokens, 6 decimals
    d.writeBigUInt64LE(vToken, 8);
    d.writeBigUInt64LE(BigInt(Math.round(poolPrice * 1e9 * 1e9)), 16); // SOL reserves (lamports) for that price
    return { owner: PUMP, data: d };
  };
  const connection = {
    getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }),
    getMultipleAccountsInfo: async keys => keys.map(() => curve())
  };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, takeProfitMultiplier: 3, partialSellPercent: 0, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  await engine.tick();
  assert.equal(db.positions.length, 1);
  poolPrice = 0.0007; t += 500; // DexScreener still shows the old price
  await engine.tick();
  assert.equal(db.trades.length, 1);
  assert.equal(db.trades[0].reason, 'stop_loss');
});
test('coins left in a wallet after a restart are taken back and sold by the exit rules', async () => {
  let t = Date.now(), out = '20000000';
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/quote') ? { outAmount: out } : url.includes('/tokens/') ? [pair()] : [] });
  const { Keypair } = await import('@solana/web3.js');
  const owner = Keypair.generate();
  const connection = {
    getParsedTokenAccountsByOwner: async () => ({ value: [{ pubkey: owner.publicKey, account: { owner: owner.publicKey, lamports: 2039280, data: { parsed: { info: { tokenAmount: { amount: '5000000', uiAmount: 5 } } } } } }] })
  };
  const b = { ...bot, enabled: false, stopLossPercent: 12, stats: { ...bot.stats } };
  const db = { bots: [b], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => owner, liveAllowed: true, fetchImpl, clock: () => t });
  const adopted = await engine.adoptHoldings(b, [MINT]);
  assert.equal(adopted.length, 1);
  assert.equal(db.positions[0].mode, 'live');
  assert.equal(db.positions[0].tokenRaw, '5000000');
  assert.ok(Math.abs(db.positions[0].sizeSol - 0.02) < 0.001); // valued at what it sells for now
  assert.equal((await engine.adoptHoldings(b, [MINT])).length, 0); // never adopted twice
});
