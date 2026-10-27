import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSolPairs, passesFilters, exitReason, todayPnl, tradeJournal, createEngine, STRATEGY_DEFAULTS, SOL_MINT } from '../engine.js';

const now = Date.parse('2026-10-27T12:00:00Z');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
function pair(overrides = {}) {
  return {
    chainId: 'solana', url: 'https://dexscreener.com/solana/x',
    baseToken: { address: MINT, symbol: 'TEST' }, quoteToken: { address: SOL_MINT },
    priceNative: '0.001', liquidity: { usd: 20000 }, txns: { m5: { buys: 40 } }, holders: 500,
    pairCreatedAt: now - 5 * 60_000, ...overrides
  };
}
// Most tests buy a one-minute-old coin at once, so the fixture bot allows that; the defaults wait 10 minutes and for a breakout.
const bot = { ...STRATEGY_DEFAULTS, minPairAgeMinutes: 0, breakoutPct: 0, id: 'b1', name: 'Test', enabled: true, takeProfitMultiplier: 1.5, stopLossPercent: 20, maxPositionSol: 0.1, stats: { trades: 0, wins: 0, losses: 0, realizedPnlSol: 0, feesSol: 0 } };

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

test('default filters skip brand-new launches, thin pools and pools losing liquidity', () => {
  const d = { ...STRATEGY_DEFAULTS };
  const ok = pair({ pairCreatedAt: now - 10 * 60_000, liquidity: { usd: 20000 }, holders: 250, topHoldersPct: 20, devPct: 1 });
  assert.deepEqual(passesFilters(ok, d, now), []);
  assert.ok(passesFilters({ ...ok, pairCreatedAt: now - 2 * 60_000 }, d, now).includes('too_new'));
  assert.ok(passesFilters({ ...ok, liquidity: { usd: 9000 } }, d, now).includes('liquidity'));
  assert.ok(passesFilters({ ...ok, liquidityChange5m: -25 }, d, now).includes('liquidity_falling'));
  assert.ok(passesFilters({ ...ok, holders: 60 }, d, now).includes('holders'));
});
test('a big pool with few holders is skipped as creator-seeded', () => {
  const d = { ...STRATEGY_DEFAULTS };
  // Cmatdesk: $62k pool, 183 holders ($339 each) at 5 minutes old, then rugged -97%.
  const seeded = pair({ pairCreatedAt: now - 6 * 60_000, liquidity: { usd: 62000 }, holders: 183, topHoldersPct: 4, devPct: 0 });
  assert.ok(passesFilters(seeded, d, now).includes('seeded_pool'));
  assert.ok(!passesFilters({ ...seeded, holders: 700 }, d, now).includes('seeded_pool'));
  assert.ok(!passesFilters(seeded, { ...d, maxLiquidityPerHolderUsd: 0 }, now).includes('seeded_pool'));
});
test('the Jupiter token feed works with no open positions (SOL price is fetched on its own)', async () => {
  const t = Date.now();
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const body = url.includes('/price/v3') ? { [SOL_MINT]: { usdPrice: 150 } }
      : url.includes('/tokens/v2/recent') ? [{ id: MINT, symbol: 'TEST', usdPrice: 0.15, liquidity: 20000, firstPool: { id: 'p', createdAt: new Date(t - 10 * 60_000).toISOString() } }]
      : url.includes('/quote') ? { outAmount: '0' } : [];
    return { ok: true, json: async () => body };
  };
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } }) };
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  await engine.scan();
  assert.ok(urls.some(u => u.includes('/price/v3')));
  assert.equal(engine.health.sources.jupiter, 'ok');
});

// Every coin that went to zero in one tick (DOCK, DOGE, "4", jenny) came from a feed with no holder count.
test('a coin with no holder count is skipped unless Jupiter can supply one', () => {
  const d = { ...STRATEGY_DEFAULTS };
  const blind = pair({ pairCreatedAt: now - 12 * 60_000, liquidity: { usd: 24000 }, holders: undefined, txns: { m5: { buys: 640, sells: 280 } } });
  assert.deepEqual(passesFilters(blind, d, now), ['unknown_holders']);
  assert.deepEqual(passesFilters(blind, { ...d, requireHolderData: false }, now), []);
});
test('holder count is looked up on Jupiter before buying a coin found on DexScreener', async () => {
  const t = Date.now();
  const scanWith = async holderCount => {
    const urls = [];
    let searches = 0;
    const fetchImpl = async url => {
      urls.push(url);
      // The watchlist refresh finds nothing on Jupiter, so the coin comes from DexScreener without holders.
      const body = url.includes('/price/v3') ? { [SOL_MINT]: { usdPrice: 150 } }
        : url.includes('/tokens/v2/search') ? (searches++ ? [{ id: MINT, symbol: 'TEST', usdPrice: 0.15, liquidity: 20000, holderCount }] : [])
        : url.includes('/quote') ? { outAmount: String(new URL(url).searchParams.get('inputMint') === SOL_MINT ? 1e8 : 9.95e7) }
        : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : url.includes('dexscreener') ? [pair({ pairCreatedAt: t - 60_000, holders: undefined })] : [];
      return { ok: true, json: async () => body };
    };
    const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6 } } } } }) };
    const db = { bots: [{ ...bot, maxSingleHolderPct: 0, insiderSellPct: 0, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
    const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
    await engine.scan();
    return { db, urls };
  };
  const found = await scanWith(800);
  assert.equal(found.urls.filter(u => u.includes(`/tokens/v2/search?query=${MINT}`)).length, 2);
  assert.equal(found.db.positions.length, 1);
  assert.equal(found.db.positions[0].features.holders, 800);
  assert.equal((await scanWith(undefined)).db.positions.length, 0);
});

test('a breakout is a climb off the recent low that is still going up', () => {
  const t = 1_000_000;
  const series = prices => prices.map((price, i) => ({ at: t + i * 30_000, price }));
  const end = t + 5 * 30_000;
  assert.equal(breakoutRise(series([1, 1, 1, 1.05, 1.1, 1.2]), end, 15).toFixed(0), '20');
  assert.equal(breakoutRise(series([1, 1, 1, 1.02, 1.04, 1.06]), end, 15), null, 'not enough rise');
  assert.equal(breakoutRise(series([1, 1.3, 1.4, 1.2, 1.25, 1.3]), end, 15), null, 'below the high: a bounce, not a breakout');
  assert.equal(breakoutRise(series([1, 1, 1.1, 1.2, 1.3, 1.25]), end, 15), null, 'last sample fell');
  assert.equal(breakoutRise(series([1, 1.1, 1.2]), t + 60_000, 15), null, 'too little history');
});
test('a breakout bot keeps watching a coin and buys once it starts climbing', async () => {
  let t = Date.now(), price = 0.001;
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    return { outAmount: String(Math.floor(u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / price * 1e6 : amt / 1e6 * price * 1e9)) };
  };
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : url.includes('dexscreener') ? [pair({ pairCreatedAt: t - 20 * 60_000, priceNative: String(price) })] : [] });
  const connection = { getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6 } } } } }) };
  const db = { bots: [{ ...bot, breakoutPct: 15, maxSingleHolderPct: 0, insiderSellPct: 0, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  for (const p of [0.001, 0.001, 0.001, 0.001]) { price = p; await engine.scan(); t += 30_000; }
  assert.equal(db.positions.length, 0, 'flat: keeps watching');
  for (const p of [0.00105, 0.0011, 0.0012]) { price = p; await engine.scan(); t += 30_000; }
  assert.equal(db.positions.length, 1, 'bought on the climb');
  assert.ok(db.positions[0].features.breakoutRisePct >= 15);
});

// Rug guard: a fake chain where the coin's biggest wallets can be read and made to sell.
import { Keypair, PublicKey } from '@solana/web3.js';
import { insiderWallets, rugSignal, breakoutRise } from '../engine.js';
const SUPPLY = 1e15;
function fakeChain(holders) {
  // holders: [{ owner, amount }] -> token accounts with those balances; amounts can be changed later.
  const accounts = holders.map(h => ({ ...h, address: Keypair.generate().publicKey }));
  const tokenAccount = amount => { const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(amount), 64); return { data: d }; };
  return {
    accounts,
    connection: {
      getParsedAccountInfo: async () => ({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: String(SUPPLY) } } } } }),
      getTokenLargestAccounts: async () => ({ value: accounts.map(a => ({ address: a.address, amount: String(a.amount) })) }),
      getAccountInfo: async () => null,
      getMultipleParsedAccounts: async keys => ({ value: keys.map(k => ({ data: { parsed: { info: { owner: accounts.find(a => a.address.equals(k)).owner } } } })) }),
      getMultipleAccountsInfo: async keys => keys.map(k => { const a = accounts.find(x => x.address.equals(k)); return a ? tokenAccount(a.amount) : null; })
    }
  };
}
const wallet = () => Keypair.generate().publicKey.toBase58();
const pool = () => PublicKey.findProgramAddressSync([Buffer.from('pool')], Keypair.generate().publicKey)[0].toBase58();
function paperEngine(connection) {
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    return { outAmount: String(Math.floor(u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / 0.001 * 1e6 : amt / 1e6 * 0.001 * 1e9)) };
  };
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [pair({ pairCreatedAt: Date.now() - 60_000 })] });
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  let t = Date.now();
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => (t += 2_000) });
  return { db, engine };
}

test('only real wallets count as insiders, not pools or curves', () => {
  const dev = wallet();
  const ws = insiderWallets([{ account: 'a', owner: pool(), amount: 5e14 }, { account: 'b', owner: dev, amount: 3e13 }, { account: 'c', owner: wallet(), amount: 5e13 }], SUPPLY, { creator: dev });
  assert.deepEqual(ws.map(w => w.account), ['c', 'b']);
  assert.equal(ws[1].dev, true);
  assert.equal(ws[0].pct, 5);
});

test('rug signal: creator dumping or top wallets selling together', () => {
  const watch = { supply: SUPPLY, wallets: [{ account: 'dev', amount: 2e13, dev: true }, { account: 'w1', amount: 4e13 }, { account: 'w2', amount: 3e13 }] };
  const b = { insiderSellPct: 2 };
  assert.equal(rugSignal(watch, new Map([['dev', 2e13], ['w1', 4e13], ['w2', 3e13]]), b), null);
  assert.match(rugSignal(watch, new Map([['dev', 1e13]]), b), /creator sold 1\.0%/);
  assert.equal(rugSignal(watch, new Map([['w1', 3e13]]), b), null); // 1% of supply: normal selling
  assert.match(rugSignal(watch, new Map([['w1', 2e13], ['w2', 2e13]]), b), /biggest wallets sold 3\.0%/);
  assert.equal(rugSignal(watch, new Map([['w1', 0]]), { insiderSellPct: 0 }), null); // turned off
});

test('coins where one wallet holds too much are never bought', async () => {
  const { connection } = fakeChain([{ owner: pool(), amount: 6e14 }, { owner: wallet(), amount: 2e14 }]);
  const { db, engine } = paperEngine(connection);
  await engine.tick();
  assert.equal(db.positions.length, 0);
});

test('the bot sells as soon as the biggest wallets start dumping, before the price moves', async () => {
  const chain = fakeChain([{ owner: pool(), amount: 6e14 }, { owner: wallet(), amount: 6e13 }, { owner: wallet(), amount: 5e13 }]);
  const { db, engine } = paperEngine(chain.connection);
  await engine.tick();
  assert.equal(db.positions.length, 1);
  assert.equal(db.positions[0].holderWatch.wallets.length, 2);
  await engine.monitor();
  assert.equal(db.positions.length, 1, 'no selling, no warning');
  chain.accounts[1].amount = 5e12; // a 6% wallet sells 5.5% of the supply
  await engine.monitor(); // sees the sell
  await engine.monitor(); // sells
  assert.equal(db.positions.length, 0);
  assert.equal(db.trades[0].reason, 'rug_warning');
});

test('old coins from the top organic list do not crowd new launches out of the watchlist', async () => {
  const t = Date.now();
  const old = Array.from({ length: 100 }, (_, i) => ({ id: `Old${i}`.padEnd(32, '1'), symbol: `O${i}`, usdPrice: 1, liquidity: 1e6, firstPool: { id: `p${i}`, createdAt: new Date(t - 400 * 86400_000).toISOString() } }));
  const fresh = { id: MINT, symbol: 'NEW', usdPrice: 0.15, liquidity: 20000, firstPool: { id: 'pn', createdAt: new Date(t - 10 * 60_000).toISOString() } };
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/price/v3') ? { [SOL_MINT]: { usdPrice: 150 } }
    : url.includes('toporganicscore') ? [...old, fresh] : url.includes('/quote') ? { outAmount: '0' } : [] });
  const db = { bots: [{ ...bot, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection: {}, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  await engine.scan();
  assert.equal(engine.health.watching, 1);
});

import { walletTrades } from '../engine.js';
const tokenBal = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });
test('a followed wallet\'s buys and sells are read from its token balances', () => {
  const w = wallet(), other = wallet();
  const buy = { meta: { err: null, preTokenBalances: [tokenBal(w, SOL_MINT, 5e9)], postTokenBalances: [tokenBal(w, MINT, 1000), tokenBal(other, MINT, 9e9), tokenBal(w, SOL_MINT, 4e9)] } };
  assert.deepEqual(walletTrades(buy, w), [{ mint: MINT, side: 'buy' }]); // SOL paid and the pool's side are ignored
  const sell = { meta: { err: null, preTokenBalances: [tokenBal(w, MINT, 1000)], postTokenBalances: [tokenBal(w, MINT, 0)] } };
  assert.deepEqual(walletTrades(sell, w), [{ mint: MINT, side: 'sell' }]);
  assert.deepEqual(walletTrades({ meta: { ...sell.meta, err: { InstructionError: [] } } }, w), []); // failed transaction
});

test('copy trading: buys what a followed wallet buys and sells when it sells', async () => {
  const leader = wallet();
  const chain = fakeChain([{ owner: pool(), amount: 6e14 }]);
  const history = [{ signature: 'old', err: null }];
  const txs = new Map();
  const conn = {
    ...chain.connection,
    getSignaturesForAddress: async (pk, { limit, until }) => {
      assert.equal(pk.toBase58(), leader);
      const i = until ? history.findIndex(s => s.signature === until) : history.length;
      return history.slice(0, i).slice(0, limit);
    },
    getParsedTransaction: async sig => txs.get(sig)
  };
  const quote = url => {
    const u = new URL(url); const amt = Number(u.searchParams.get('amount'));
    return { outAmount: String(Math.floor(u.searchParams.get('inputMint') === SOL_MINT ? amt / 1e9 / 0.001 * 1e6 : amt / 1e6 * 0.001 * 1e9)) };
  };
  let t = now;
  // A one-minute-old coin with little trading yet: the default filters would skip it, a copied buy doesn't.
  const young = pair({ pairCreatedAt: now - 60_000, txns: { m5: { buys: 2, sells: 0 } } });
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes('/quote') ? quote(url) : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? [] : [young] });
  const db = { bots: [{ ...STRATEGY_DEFAULTS, id: 'c1', name: 'Copy', enabled: true, maxPositionSol: 0.1, paperBalanceSol: 1, followWallets: [leader], followOnly: true, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection: conn, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  assert.deepEqual(passesFilters(young, db.bots[0], now).length > 0, true);

  await engine.watchLeaders(); // first look: earlier history is not copied
  await engine.scan();
  assert.equal(db.positions.length, 0, 'nothing bought before the followed wallet buys');

  t += 5_000;
  history.unshift({ signature: 'buy', err: null });
  txs.set('buy', { meta: { err: null, preTokenBalances: [], postTokenBalances: [tokenBal(leader, MINT, 5e9)] } });
  await engine.watchLeaders();
  await engine.scan();
  assert.equal(db.positions.length, 1);
  assert.equal(db.positions[0].leader, leader);

  t += 5_000;
  history.unshift({ signature: 'sell', err: null });
  txs.set('sell', { meta: { err: null, preTokenBalances: [tokenBal(leader, MINT, 5e9)], postTokenBalances: [tokenBal(leader, MINT, 0)] } });
  await engine.watchLeaders();
  t += 1_000;
  await engine.monitor();
  assert.equal(db.positions.length, 0);
  assert.equal(db.trades[0].reason, 'leader_sold');
  assert.equal(db.trades[0].features.copied, true);
});

import { walletRecord } from '../engine.js';
test('a wallet\'s record counts finished trades, and old coins it never sold as losses', () => {
  const w = wallet(), A = 'A'.repeat(43) + '1', B = 'B'.repeat(43) + '1', C = 'C'.repeat(43) + '1';
  const swap = (mint, tokensBefore, tokensAfter, solBefore, solAfter, minute) => ({
    blockTime: now / 1000 + minute * 60,
    transaction: { message: { accountKeys: [{ pubkey: w }] } },
    meta: { err: null, preBalances: [solBefore * 1e9], postBalances: [solAfter * 1e9],
      preTokenBalances: [tokenBal(w, mint, tokensBefore)], postTokenBalances: [tokenBal(w, mint, tokensAfter)] }
  });
  const r = walletRecord([
    swap(A, 0, 100, 10, 9, 0), swap(A, 100, 0, 9, 10.5, 5),     // A: +0.5 SOL
    swap(B, 0, 100, 10.5, 9.5, 10), swap(B, 100, 0, 9.5, 9.8, 12), // B: -0.7 SOL
    swap(C, 0, 100, 9.8, 9.3, 20), swap(MINT, 0, 100, 9.3, 9.2, 200) // C never sold for 3 hours: a loss; MINT just bought
  ], w);
  assert.equal(r.closed, 3);
  assert.equal(r.unsold, 1);
  assert.equal(r.wins, 1);
  assert.ok(Math.abs(r.pnlSol - (0.5 - 0.7 - 0.5)) < 1e-9);
});

import { profitableTraders, worthCopying } from '../engine.js';
const geckoTrade = (wallet, kind, usd) => ({ attributes: { tx_from_address: wallet, kind, volume_in_usd: String(usd) } });
test('traders who sold a coin for 1.5x or more are picked out of its pool trades', () => {
  const good = wallet(), meh = wallet(), dumper = wallet();
  const r = profitableTraders([geckoTrade(good, 'buy', 100), geckoTrade(good, 'sell', 400), geckoTrade(meh, 'buy', 100), geckoTrade(meh, 'sell', 120), geckoTrade(dumper, 'sell', 5000)]);
  assert.deepEqual(r.map(x => x.wallet), [good]);
});
test('only wallets with a real, profitable, human-paced record are worth copying', () => {
  const ok = { closed: 12, winRate: 0.5, pnlSol: 3, swapsPerHour: 4 };
  assert.equal(worthCopying(ok), true);
  assert.equal(worthCopying({ ...ok, closed: 3 }), false);
  assert.equal(worthCopying({ ...ok, winRate: 0.3 }), false);
  assert.equal(worthCopying({ ...ok, pnlSol: -1 }), false);
  assert.equal(worthCopying({ ...ok, swapsPerHour: 200 }), false);
});

test('auto-find: a coin that runs 3x leads to its profitable traders, and good ones are kept to copy', async () => {
  const trader = wallet();
  // The trader's history: 10 coins bought for 1 SOL and sold for 1.5 SOL, an hour apart.
  const txs = [];
  for (let i = 0; i < 10; i++) {
    const mint = Keypair.generate().publicKey.toBase58();
    const at = now / 1000 - (20 - i * 2) * 3600;
    const mk = (pre, post, solPre, solPost, t) => ({ blockTime: t, transaction: { message: { accountKeys: [{ pubkey: trader }] } },
      meta: { err: null, preBalances: [solPre * 1e9], postBalances: [solPost * 1e9], preTokenBalances: [tokenBal(trader, mint, pre)], postTokenBalances: [tokenBal(trader, mint, post)] } });
    txs.push(mk(0, 100, 10, 9, at), mk(100, 0, 9, 10.5, at + 600));
  }
  const conn = {
    getSignaturesForAddress: async () => txs.map((_, i) => ({ signature: `s${i}`, err: null })),
    getParsedTransaction: async sig => txs[Number(sig.slice(1))]
  };
  let price = 0.001, t = now;
  const fetchImpl = async url => ({ ok: true, json: async () =>
    url.includes('/tokens/') && url.includes('/pools') ? { data: [{ attributes: { address: 'Pool1111111111111111111111111111111111111111' } }] }
    : url.includes('/trades') ? { data: [geckoTrade(trader, 'buy', 50), geckoTrade(trader, 'sell', 300)] }
    : url.includes('token-profiles') ? [{ chainId: 'solana', tokenAddress: MINT }] : url.includes('token-boosts') ? []
    : url.includes('/quote') ? { outAmount: '0' } : [pair({ priceNative: String(price), liquidity: { usd: 50000 } })] });
  const db = { bots: [{ ...STRATEGY_DEFAULTS, id: 'a1', name: 'Auto', enabled: true, autoFollow: true, followOnly: true, paperBalanceSol: 1, stats: { ...bot.stats } }], trades: [], positions: [] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection: conn, getKeypair: () => null, liveAllowed: false, fetchImpl, clock: () => t });
  await engine.scan(); // first sight at 0.001
  price = 0.0035; t += 60_000;
  await engine.scan(); // now 3.5x
  t += 3 * 60_000;
  await engine.scout();
  assert.equal(db.smartWallets.length, 1);
  assert.equal(db.smartWallets[0].address, trader);
  assert.equal(db.smartWallets[0].closed, 10);
});

test('wallet clean-up burns coins nobody can buy and closes their accounts for the deposit', async () => {
  const owner = Keypair.generate();
  const dead = Keypair.generate().publicKey, empty = Keypair.generate().publicKey, open = Keypair.generate().publicKey;
  const acct = (mint, amount) => ({ pubkey: Keypair.generate().publicKey, account: { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), lamports: 2039280, data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount: String(amount) } } } } } });
  const sent = [];
  let balance = 1e8;
  const connection = {
    getBalance: async () => balance,
    getParsedTokenAccountsByOwner: async (_o, { programId }) => ({ value: programId.toBase58().startsWith('Tokenkeg') ? [acct(dead, 5000), acct(empty, 0), acct(open, 100)] : [] }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1e9 }),
    sendRawTransaction: async raw => { sent.push(raw); balance += 2 * 2039280; return 'sig'; },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed' }] })
  };
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => 'COULD_NOT_FIND_ANY_ROUTE' });
  const b = { ...bot, mode: 'live' };
  const db = { bots: [b], trades: [], positions: [{ botId: b.id, mint: open.toBase58() }] };
  const engine = createEngine({ db, save: async () => {}, log: () => {}, connection, getKeypair: () => owner, liveAllowed: true, fetchImpl, clock: () => now, sleep: async () => {} });
  const r = await engine.cleanupWallet(b);
  assert.deepEqual(r.burned, [dead.toBase58()]);
  assert.equal(r.closed, 2); // the dead coin and the empty account; the open position's coin is untouched
  assert.equal(sent.length, 1);
  assert.ok(r.recoveredSol > 0.004);
});
