import { PublicKey, VersionedTransaction, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { randomUUID } from 'node:crypto';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEXSCREENER = 'https://api.dexscreener.com';
export const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2';
// A key from portal.jup.ag (JUPITER_API_KEY) moves requests to api.jup.ag. The free key allows about
// 60 requests a minute; set JUPITER_RPM to your plan's limit if you upgrade.
const JUP_KEY = process.env.JUPITER_API_KEY || '';
const JUP_BASE = JUP_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
export const JUPITER = process.env.JUPITER_API_URL || `${JUP_BASE}/swap/v1`;
export const JUPITER_PRICE = process.env.JUPITER_PRICE_URL || `${JUP_BASE}/price/v3`;
export const JUPITER_TOKENS = process.env.JUPITER_TOKENS_URL || `${JUP_BASE}/tokens/v2`;
export const JUPITER_HEADERS = JUP_KEY ? { 'x-api-key': JUP_KEY } : {};
export const JUPITER_RPM = Number(process.env.JUPITER_RPM || (JUP_KEY ? 60 : 50));
const TX_FEE_SOL = 0.000005;
const LOCKED_FLOOR = 1.02; // whole-trade multiple kept once the first target is banked
const NO_ROUTE = 'No Jupiter route for this token: nobody can buy it right now (its pool is drained or moving). The bot keeps retrying.';
const AUDIT_KEYS = ['holders', 'topHoldersPct', 'devPct', 'devMints', 'isSus', 'organicScore', 'traders5m', 'organicBuyers5m', 'bondingCurvePct'];
const SEEN_TTL_MS = 30 * 60 * 1000;
const WATCHLIST_MAX = 120;
const REVALUE_MS = 15_000; // re-quote each open position at least this often
const MAX_ACCOUNT_RENT_SOL = 0.0025; // a token account deposit (Token-2022 accounts are a little bigger)
const GRADUATION_PCT = 80; // skip launchpad tokens this far along their bonding curve
const REVALUE_MIN_MS = 2_000; // ...and up to this often when few positions share the Jupiter budget
// Tokens named after major coins are almost always copycat rugs.
const IMPOSTOR_SYMBOLS = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'BTC', 'WBTC', 'ETH', 'WETH', 'JUP', 'BONK', 'WIF', 'TRUMP', 'PYTH', 'RAY', 'JTO']);
const PRICE_MS = 3_000; // spot price refresh for open positions
const DEX_PRICE_MS = 1_000; // DexScreener price refresh for open positions
// pump.fun bonding curves are read straight from the chain every tick, the fastest price there is.
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export const STRATEGY_DEFAULTS = {
  mode: 'paper',
  takeProfitMultiplier: 1.5,
  stopLossPercent: 12,
  stopLossFollowsPrice: true,
  maxPositionSol: 0.05,
  minLiquidityUsd: 8000,
  maxPairAgeMinutes: 30,
  minBuys5m: 10,
  minBuySellRatio: 1.5,
  maxOpenPositions: 3,
  maxHoldMinutes: 30,
  trailingStopPercent: 12,
  slippageBps: 500,
  maxPriceImpactPct: 8,
  maxRoundTripPct: 4,
  minHolders: 40,
  maxTopHoldersPct: 35,
  maxDevHoldingPct: 10,
  maxDevLaunches: 20,
  minOrganicScore: 0,
  minPairAgeMinutes: 0,
  partialTakeProfitMultiplier: 1.15,
  partialSellPercent: 50,
  priorityFeeSol: 0.0003,
  maxDailyLossSol: 0.2,
  paperBalanceSol: 1
};

// Pick the most liquid SOL-quoted pair for each token from a DexScreener pairs list.
export function bestSolPairs(pairs) {
  const best = new Map();
  for (const p of pairs || []) {
    if (p?.chainId !== 'solana' || p?.quoteToken?.address !== SOL_MINT) continue;
    const mint = p.baseToken?.address;
    const price = Number(p.priceNative);
    if (!mint || !(price > 0)) continue;
    const current = best.get(mint);
    if (!current || (p.liquidity?.usd || 0) > (current.liquidity?.usd || 0)) best.set(mint, p);
  }
  return best;
}

export function passesFilters(pair, bot, now = Date.now()) {
  const reasons = [];
  if (IMPOSTOR_SYMBOLS.has(String(pair.baseToken?.symbol || '').trim().toUpperCase())) reasons.push('impostor');
  const buys = pair.txns?.m5?.buys || 0;
  const sells = pair.txns?.m5?.sells || 0;
  if ((pair.liquidity?.usd || 0) < bot.minLiquidityUsd) reasons.push('liquidity');
  if (!pair.pairCreatedAt || now - pair.pairCreatedAt > bot.maxPairAgeMinutes * 60_000) reasons.push('age');
  if (bot.minPairAgeMinutes > 0 && pair.pairCreatedAt && now - pair.pairCreatedAt < bot.minPairAgeMinutes * 60_000) reasons.push('too_new');
  // Rug signals from Jupiter's token audit (skipped when a feed doesn't report them).
  if (pair.isSus) reasons.push('flagged');
  // A launchpad token about to finish its bonding curve moves to a new pool, and for a while nothing can
  // sell it. Buying just before that is how a position ends up stuck with no route.
  if (pair.bondingCurvePct != null && pair.bondingCurvePct >= GRADUATION_PCT) reasons.push('graduating');
  if (bot.maxDevHoldingPct > 0 && pair.devPct != null && pair.devPct > bot.maxDevHoldingPct) reasons.push('dev_holding');
  if (bot.maxDevLaunches > 0 && pair.devMints != null && pair.devMints > bot.maxDevLaunches) reasons.push('serial_launcher');
  if (bot.minOrganicScore > 0 && pair.organicScore != null && pair.organicScore < bot.minOrganicScore) reasons.push('organic');
  if (buys < bot.minBuys5m) reasons.push('buys');
  // Holder spread (from Jupiter's token data; skipped when a feed doesn't report it).
  if (bot.minHolders > 0 && pair.holders != null && pair.holders < bot.minHolders) reasons.push('holders');
  if (bot.maxTopHoldersPct > 0 && pair.topHoldersPct != null && pair.topHoldersPct > bot.maxTopHoldersPct) reasons.push('concentration');
  // Momentum: more buyers than sellers in the last 5 minutes.
  if (bot.minBuySellRatio > 0 && buys < bot.minBuySellRatio * Math.max(sells, 1)) reasons.push('momentum');
  return reasons;
}

// Whether to bank part of a position at the first target (scale out, like most successful traders do).
export function partialDue(position, bot, multiple) {
  return !position.partialDone && bot.partialSellPercent > 0 && bot.partialSellPercent < 100 &&
    bot.partialTakeProfitMultiplier > 1 && multiple >= bot.partialTakeProfitMultiplier && multiple < bot.takeProfitMultiplier;
}

// Decide whether an open position should be closed. `multiple` is what selling now would return
// (after fees) divided by the SOL spent, so take profit and stop loss match the P&L actually booked.
export function exitReason(position, bot, multiple, now = Date.now()) {
  const peak = Math.max(position.peakMultiple || 0, multiple);
  if (multiple >= bot.takeProfitMultiplier) return 'take_profit';
  // After the first target has been banked, the rest of the position may not turn the trade into a loss.
  if (position.partialDone && multiple <= LOCKED_FLOOR) return 'protect_profit';
  // A stop loss that follows the price sits that far below the highest value the trade has reached,
  // so it moves up as the price climbs and never moves down.
  const stopBase = bot.stopLossFollowsPrice ? Math.max(1, peak) : 1;
  if (multiple <= stopBase * (1 - bot.stopLossPercent / 100)) return stopBase > 1 ? 'trailing_stop' : 'stop_loss';
  // Trailing stop arms once the position is up by the trail distance. It then sells on that much pullback
  // from the peak, and never lets an armed winner fall back below break-even.
  const trail = (bot.trailingStopPercent || 0) / 100;
  if (trail > 0 && peak >= 1 + trail && (multiple <= peak * (1 - trail) || multiple <= 1)) return 'trailing_stop';
  if (now - Date.parse(position.openedAt) >= bot.maxHoldMinutes * 60_000) return 'max_hold';
  return null;
}

// Trade journal: for each signal seen at entry, split trades into ranges and show how each range did.
const JOURNAL = [
  ['ageMin', 'Pair age (min)', [2, 5, 15]], ['liquidityUsd', 'Liquidity ($)', [10_000, 25_000, 60_000]],
  ['buys5m', 'Buys in 5m', [20, 50, 150]], ['buySellRatio', 'Buy/sell ratio', [1.5, 2, 3]],
  ['holders', 'Holders', [100, 300, 1000]], ['topHoldersPct', 'Top 10 hold (%)', [15, 25, 35]],
  ['devPct', 'Dev holds (%)', [1, 3, 10]], ['devMints', 'Dev launches', [1, 5, 20]],
  ['organicScore', 'Organic score', [10, 30, 60]], ['traders5m', 'Traders in 5m', [20, 50, 150]],
  ['roundTripPct', 'Round-trip cost (%)', [2, 4, 6]], ['priceImpactPct', 'Price impact (%)', [1, 3, 6]]
];
export function tradeJournal(trades) {
  const withFeatures = trades.filter(t => t.features);
  return JOURNAL.map(([key, label, cuts]) => {
    const ranges = [...cuts, Infinity].map((hi, i) => ({ lo: i ? cuts[i - 1] : -Infinity, hi, trades: 0, wins: 0, pnlSol: 0 }));
    for (const t of withFeatures) {
      const v = t.features[key];
      if (v == null) continue;
      const r = ranges.find(x => v < x.hi);
      r.trades += 1; r.pnlSol += t.pnlSol; if (t.pnlSol > 0) r.wins += 1;
    }
    return { key, label, ranges: ranges.map(r => ({ label: r.lo === -Infinity ? `< ${r.hi}` : r.hi === Infinity ? `≥ ${r.lo}` : `${r.lo}–${r.hi}`, trades: r.trades, winRate: r.trades ? r.wins / r.trades : null, pnlSol: r.pnlSol })) };
  });
}

export function todayPnl(trades, botId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return trades.filter(t => t.botId === botId && t.closedAt?.startsWith(day)).reduce((s, t) => s + t.pnlSol, 0);
}

export function createEngine({
  db, save, log, connection, marketConnection = connection, getKeypair, liveAllowed,
  fetchImpl = fetch, monitorMs = 2_000, scanMs = 6_000, jupiterRpm = JUPITER_RPM,
  clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms))
}) {
  const watch = new Map(); // mint -> first seen time
  const safety = new Map(); // mint -> boolean
  const decimals = new Map(); // mint -> token decimals
  const timers = [];
  let monitoring = false;
  let scanning = false;
  const health = { lastTickAt: null, lastScanAt: null, lastError: null, candidates: 0, watching: 0, ticks: 0, scans: 0 };
  const iso = () => new Date(clock()).toISOString();
  // Live P&L is measured from wallet balance changes, so one bot's swaps must never overlap.
  const walletLocks = new Map();
  function withWallet(bot, fn) {
    const run = (walletLocks.get(bot.id) || Promise.resolve()).then(fn, fn);
    walletLocks.set(bot.id, run.catch(() => {}));
    return run;
  }

  // Jupiter request budget (token bucket). Background calls (prices, feeds) may only use 60% of it,
  // so quotes and swaps for real trades always have room.
  const JUP_HOST = new URL(JUPITER).host;
  const bucket = { tokens: jupiterRpm, at: clock() };
  async function takeJupiter(priority) {
    for (let waited = 0; ; waited += 250) {
      const t = clock();
      bucket.tokens = Math.min(jupiterRpm, bucket.tokens + (t - bucket.at) * jupiterRpm / 60_000);
      bucket.at = t;
      if (bucket.tokens >= 1 + (priority ? 0 : jupiterRpm * 0.4)) { bucket.tokens -= 1; return; }
      if (!priority) throw new Error('Jupiter budget kept for trades');
      if (waited > 10_000) throw new Error('Jupiter request budget exhausted');
      await sleep(250);
    }
  }
  async function getJson(url, init, { priority = false } = {}) {
    const jup = new URL(url).host === JUP_HOST;
    if (jup) await takeJupiter(priority);
    const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(jup ? JUPITER_HEADERS : {}), ...(init?.headers || {}) } });
    if (!res.ok) {
      // Jupiter counts its limit over a rolling window; after a 429 everyone waits ~3 s so the next
      // request (often a sell) isn't refused too.
      if (jup && res.status === 429) { bucket.tokens = Math.min(bucket.tokens, -jupiterRpm / 20); bucket.at = clock(); }
      const body = await res.text?.().catch(() => '') || '';
      // Jupiter answers 400 when a token has no route (e.g. liquidity pulled); report it as such.
      // CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD means the sell would return next to nothing: the pool is drained.
      if (res.status === 400 && /route|not tradable|TOKEN_NOT_TRADABLE|CANNOT_COMPUTE_OTHER_AMOUNT/i.test(body)) throw new Error(NO_ROUTE);
      throw new Error(`${new URL(url).host} responded ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    }
    return res.json();
  }
  // Free market-data APIs rate-limit shared hosting IPs (Render included). A source that answers 429 is
  // skipped for a while instead of failing the scan, and the other sources carry on.
  const cooldown = new Map(); // host -> until
  const available = host => clock() >= (cooldown.get(host) || 0);
  async function feedJson(url, ms = 60_000) {
    const host = new URL(url).host;
    if (!available(host)) throw new Error(`${host} cooling down after a rate limit`);
    try { return await getJson(url); }
    catch (e) { if (/ 429/.test(e.message)) cooldown.set(host, clock() + ms); throw e; }
  }
  const DEX_HOST = new URL(DEXSCREENER).host;
  async function dexPairs(mints) {
    const out = new Map();
    for (let i = 0; i < mints.length && available(DEX_HOST); i += 30) {
      const pairs = await feedJson(`${DEXSCREENER}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`, 120_000).catch(() => []);
      for (const [mint, pair] of bestSolPairs(pairs)) out.set(mint, pair);
    }
    return out;
  }
  // SOL price of tokens still on a pump.fun bonding curve, from the curve's reserves at the latest slot.
  // Mints without a live curve are remembered and skipped.
  const curves = new Map(); // mint -> curve address, or null when the mint has no live curve
  async function curvePrices(mints) {
    const out = new Map();
    for (const m of mints) if (!curves.has(m)) curves.set(m, PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(m).toBuffer()], PUMP_PROGRAM)[0]);
    const live = mints.filter(m => curves.get(m));
    for (let i = 0; i < live.length; i += 100) {
      const batch = live.slice(i, i + 100);
      const infos = await marketConnection.getMultipleAccountsInfo(batch.map(m => curves.get(m)), 'processed');
      batch.forEach((m, j) => {
        const d = infos[j]?.data;
        if (!infos[j]?.owner?.equals?.(PUMP_PROGRAM) || !d || d.length < 49 || d[48] !== 0) { curves.set(m, null); return; }
        const vToken = Number(d.readBigUInt64LE(8)), vSol = Number(d.readBigUInt64LE(16));
        if (vToken > 0 && vSol > 0) out.set(m, (vSol / LAMPORTS_PER_SOL) / (vToken / 1e6));
      });
    }
    return out;
  }
  let solUsd = null;
  let lastSearchAt = 0;
  // Current SOL price of each token, from Jupiter's price API, with DexScreener filling any gaps.
  async function pricesFor(mints) {
    const out = new Map();
    try {
      for (let i = 0; i < mints.length; i += 49) {
        const ids = [SOL_MINT, ...mints.slice(i, i + 49)];
        const data = await feedJson(`${JUPITER_PRICE}?ids=${ids.join(',')}`, 10_000);
        const sol = Number(data?.[SOL_MINT]?.usdPrice);
        if (!(sol > 0)) break;
        solUsd = sol;
        for (const m of ids.slice(1)) { const usd = Number(data?.[m]?.usdPrice); if (usd > 0) out.set(m, usd / sol); }
      }
    } catch (e) { health.lastError = `Jupiter price: ${e.message}`; }
    const missing = mints.filter(m => !out.has(m));
    if (missing.length) for (const [m, pair] of await dexPairs(missing)) out.set(m, Number(pair.priceNative));
    return out;
  }
  const num = v => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  // Jupiter token (from /tokens/v2) -> the DexScreener-shaped pair the filters expect.
  function jupiterPair(t) {
    const price = Number(t?.usdPrice) / solUsd;
    if (!t?.id || !(price > 0)) return null;
    return {
      chainId: 'solana', dexId: t.firstPool?.id ? 'jupiter' : 'unknown', pairAddress: t.firstPool?.id,
      url: `https://jup.ag/tokens/${t.id}`, baseToken: { address: t.id, symbol: t.symbol || '?' }, quoteToken: { address: SOL_MINT },
      priceNative: String(price), liquidity: { usd: Number(t.liquidity) || 0 },
      txns: { m5: { buys: t.stats5m?.numBuys || 0, sells: t.stats5m?.numSells || 0 } },
      pairCreatedAt: Date.parse(t.firstPool?.createdAt) || null,
      holders: num(t.holderCount), topHoldersPct: num(t.audit?.topHoldersPercentage),
      devPct: num(t.audit?.devBalancePercentage), devMints: num(t.audit?.devMints), isSus: t.audit?.isSus === true,
      organicScore: num(t.organicScore), traders5m: num(t.stats5m?.numTraders), organicBuyers5m: num(t.stats5m?.numOrganicBuyers),
      bondingCurvePct: t.graduatedPool ? null : num(t.bondingCurve)
    };
  }
  // GeckoTerminal pool -> the DexScreener-shaped pair the filters expect.
  function geckoPair(pool) {
    const a = pool?.attributes || {};
    const base = pool?.relationships?.base_token?.data?.id || '';
    const quote = pool?.relationships?.quote_token?.data?.id || '';
    if (!base.startsWith('solana_') || quote !== `solana_${SOL_MINT}`) return null;
    const price = Number(a.base_token_price_native_currency);
    if (!(price > 0)) return null;
    const mint = base.slice(7);
    return {
      chainId: 'solana', dexId: pool?.relationships?.dex?.data?.id || 'unknown', pairAddress: a.address,
      url: `https://www.geckoterminal.com/solana/pools/${a.address}`,
      baseToken: { address: mint, symbol: String(a.name || '').split(' / ')[0] || '?' }, quoteToken: { address: SOL_MINT },
      priceNative: String(price), liquidity: { usd: Number(a.reserve_in_usd) || 0 },
      txns: { m5: { buys: a.transactions?.m5?.buys || 0, sells: a.transactions?.m5?.sells || 0 } },
      pairCreatedAt: Date.parse(a.pool_created_at) || null
    };
  }
  // New launches come from Jupiter's recent-tokens list, GeckoTerminal's newest pools and DexScreener's
  // latest profiles and boosts, whichever are answering. Tokens are watched for SEEN_TTL_MS and re-checked
  // every scan, so a launch that is too quiet at first can still be bought once it picks up.
  async function discover(now) {
    for (const [mint, at] of watch) if (now - at > SEEN_TTL_MS) watch.delete(mint);
    const add = mint => { if (mint && !watch.has(mint)) watch.set(mint, now); };
    const pairs = new Map();
    const keep = pair => {
      if (!pair) return;
      add(pair.baseToken.address);
      const cur = pairs.get(pair.baseToken.address);
      if (!cur) return pairs.set(pair.baseToken.address, pair);
      // Keep the deeper pool's price and liquidity, plus any holder/audit data either feed has.
      const [main, other] = pair.liquidity.usd > cur.liquidity.usd ? [pair, cur] : [cur, pair];
      for (const k of AUDIT_KEYS) if (main[k] == null && other[k] != null) main[k] = other[k];
      pairs.set(pair.baseToken.address, main);
    };
    const sources = {};
    if (!solUsd) await pricesFor([]);
    if (solUsd) {
      try { for (const t of await feedJson(`${JUPITER_TOKENS}/recent`, 30_000) || []) keep(jupiterPair(t)); sources.jupiter = 'ok'; }
      catch (e) { sources.jupiter = e.message; }
    }
    try { for (const pool of (await feedJson(`${GECKOTERMINAL}/networks/solana/new_pools?page=1`, 90_000))?.data || []) keep(geckoPair(pool)); sources.geckoterminal = 'ok'; }
    catch (e) { sources.geckoterminal = e.message; }
    if (available(DEX_HOST)) {
      const feeds = await Promise.allSettled([feedJson(`${DEXSCREENER}/token-profiles/latest/v1`, 120_000), feedJson(`${DEXSCREENER}/token-boosts/latest/v1`, 120_000)]);
      for (const feed of feeds) if (feed.status === 'fulfilled' && Array.isArray(feed.value)) for (const item of feed.value) if (item?.chainId === 'solana') add(item.tokenAddress);
      sources.dexscreener = feeds.some(f => f.status === 'fulfilled') ? 'ok' : feeds[0].reason?.message;
    } else sources.dexscreener = 'cooling down after a rate limit';
    while (watch.size > WATCHLIST_MAX) watch.delete(watch.keys().next().value);
    health.watching = watch.size;
    // Refresh watched tokens that weren't in this scan's feeds: Jupiter token search first, then DexScreener.
    let stale = [...watch.keys()].filter(m => !pairs.has(m));
    if (stale.length && solUsd && now - lastSearchAt >= 30_000) {
      lastSearchAt = now;
      for (let i = 0; i < stale.length; i += 100) {
        try { for (const t of await feedJson(`${JUPITER_TOKENS}/search?query=${stale.slice(i, i + 100).join(',')}`, 30_000) || []) { const p = jupiterPair(t); if (p) pairs.set(p.baseToken.address, p); } }
        catch { break; }
      }
      stale = stale.filter(m => !pairs.has(m));
    }
    for (const [m, pair] of await dexPairs(stale)) pairs.set(m, pair);
    health.sources = sources;
    health.jupiterBudget = `${Math.floor(bucket.tokens)}/${jupiterRpm} per min`;
    if (!Object.values(sources).includes('ok')) health.lastError = `No market feed answered: ${JSON.stringify(sources)}`;
    return pairs;
  }
  // Reject tokens whose creator can still mint more supply or freeze holders' accounts.
  async function mintIsSafe(mint) {
    if (safety.has(mint)) return safety.get(mint);
    const info = await marketConnection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const parsed = info.value?.data?.parsed?.info;
    const ok = Boolean(parsed) && parsed.mintAuthority == null && parsed.freezeAuthority == null;
    if (parsed) decimals.set(mint, parsed.decimals);
    safety.set(mint, ok);
    return ok;
  }

  // Send, then rebroadcast every 2s until confirmed or the blockhash expires.
  async function sendAndConfirm(tx, lastValidBlockHeight) {
    const raw = tx.serialize();
    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    let lastSend = clock();
    for (;;) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status?.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(status.err)}`);
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return signature;
      if (lastValidBlockHeight && (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error('Swap expired before it was confirmed.');
      if (clock() - lastSend >= 2000) { await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); lastSend = clock(); }
      await sleep(400);
    }
  }
  // Quotes and swaps are trade-critical: they jump the budget queue and retry briefly on a 429.
  async function jupiterTrade(url, init) {
    for (let attempt = 0; ; attempt++) {
      try { return await getJson(url, init, { priority: true }); }
      catch (e) { if (!/ 429/.test(e.message) || attempt >= 3) throw e; await sleep(500 * 2 ** attempt); }
    }
  }
  async function jupiterQuote(inputMint, outputMint, amount, bot, { priority = true } = {}) {
    const url = `${JUPITER}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${bot.slippageBps}&restrictIntermediateTokens=true`;
    const quote = priority ? await jupiterTrade(url) : await getJson(url);
    if (!quote?.outAmount || quote.outAmount === '0') throw new Error(NO_ROUTE);
    return quote;
  }
  function checkImpact(quote, bot) {
    const impact = Number(quote.priceImpactPct || 0) * 100;
    if (bot.maxPriceImpactPct > 0 && impact > bot.maxPriceImpactPct) throw new Error(`price impact ${impact.toFixed(1)}% is over the ${bot.maxPriceImpactPct}% limit`);
  }
  async function jupiterSwap(owner, inputMint, outputMint, amount, bot, { buying = false, quote = null } = {}) {
    quote ||= await jupiterQuote(inputMint, outputMint, amount, bot);
    if (buying) checkImpact(quote, bot);
    const { swapTransaction, lastValidBlockHeight } = await jupiterTrade(`${JUPITER}/swap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote, userPublicKey: owner.publicKey.toBase58(), wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true, dynamicSlippage: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.floor((bot.priorityFeeSol ?? 0.0005) * LAMPORTS_PER_SOL), priorityLevel: 'veryHigh' } }
      })
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    if (buying && connection.simulateTransaction) await checkBuyCost(owner, tx, Number(amount), bot);
    tx.sign([owner]);
    return { signature: await sendAndConfirm(tx, lastValidBlockHeight), quote };
  }
  // Dry-run the buy first. A swap that would fail (slippage, missing accounts) is skipped without paying
  // its fee, and so is one that would take more SOL than the trade, one token account deposit and the
  // priority fee: some routes open extra accounts or charge launchpad fees that are never paid back.
  async function checkBuyCost(owner, tx, lamports, bot) {
    const address = owner.publicKey.toBase58();
    const before = await connection.getBalance(owner.publicKey, 'processed');
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'processed', accounts: { encoding: 'base64', addresses: [address] } });
    if (sim.value?.err) throw new Error(`the buy would fail on-chain: ${JSON.stringify(sim.value.err)}`);
    const after = sim.value?.accounts?.[0]?.lamports;
    if (after == null) return;
    const extra = (before - after - lamports) / LAMPORTS_PER_SOL;
    const allowed = MAX_ACCOUNT_RENT_SOL + (bot.priorityFeeSol || 0) + 0.0001;
    if (extra > allowed) throw new Error(`the buy would cost ${extra.toFixed(4)} SOL on top of the trade (extra accounts or launchpad fees)`);
  }
  async function tokenHoldings(owner, mint) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, 'confirmed');
    return res.value.map(a => ({
      pubkey: a.pubkey, programId: a.account.owner, lamports: a.account.lamports || 0,
      raw: BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0'),
      ui: Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount || 0)
    }));
  }
  // Close emptied token accounts so the ~0.002 SOL rent comes back to the bot wallet.
  async function reclaimRent(owner, accounts) {
    const empty = accounts.filter(a => a.raw === 0n);
    if (!empty.length) return false;
    const tx = new Transaction();
    for (const a of empty) tx.add(createCloseAccountInstruction(a.pubkey, owner.publicKey, owner.publicKey, [], a.programId));
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash; tx.feePayer = owner.publicKey; tx.sign(owner);
    await sendAndConfirm(tx, lastValidBlockHeight);
    return true;
  }
  // SOL the wallet spent (+) or received (-) in one transaction, from the transaction itself, so other
  // trades in the same wallet at the same time can't skew it. The bot wallet always pays the fee, so it
  // is account 0. Falls back to the balance difference when the RPC has not indexed the transaction yet.
  async function solDelta(signature, fallbackLamports) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const tx = await connection.getTransaction?.(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (tx?.meta) return (tx.meta.preBalances[0] - tx.meta.postBalances[0]) / LAMPORTS_PER_SOL;
      if (!connection.getTransaction) break;
      await sleep(500);
    }
    return fallbackLamports / LAMPORTS_PER_SOL;
  }
  // The token account's rent deposit is paid on the first buy and refunded when the empty account is
  // closed, so it is not part of the trade's cost.
  const rentOf = accounts => accounts.reduce((s, a) => s + (a.lamports || 0), 0) / LAMPORTS_PER_SOL;

  const exitFee = bot => TX_FEE_SOL + (bot.priorityFeeSol || 0);
  // What selling the whole position right now would return, after fees, from a real Jupiter quote.
  async function sellValue(bot, position, { priority = true } = {}) {
    const quote = await jupiterQuote(position.mint, SOL_MINT, position.tokenRaw, bot, { priority });
    return { quote, valueSol: Number(quote.outAmount) / LAMPORTS_PER_SOL - exitFee(bot) };
  }
  function markValue(position, valueSol, spot, now) {
    position.valueSol = valueSol;
    position.valueSpot = spot > 0 ? spot : position.lastPrice;
    position.valueAt = now;
    position.multiple = ((position.realizedSol || 0) + valueSol) / position.sizeSol;
    position.peakMultiple = Math.max(position.peakMultiple || 0, position.multiple);
  }
  // Between quotes, scale the last quoted value by how far the spot price has moved since.
  function estimateMultiple(position) {
    if (!(position.valueSol > 0)) return position.tokenRaw ? position.multiple ?? 1 : position.lastPrice / position.entryPrice;
    const scale = position.valueSpot > 0 && position.lastPrice > 0 ? position.lastPrice / position.valueSpot : 1;
    return ((position.realizedSol || 0) + position.valueSol * scale) / position.sizeSol;
  }

  const lowBalanceLoggedAt = new Map(); // bot id -> last time the low-balance warning was logged
  async function openPosition(bot, pair) {
    const price = Number(pair.priceNative);
    if (!(price > 0) || !(bot.maxPositionSol > 0)) return null;
    const now = clock();
    const position = {
      id: randomUUID(), botId: bot.id, mode: bot.mode, mint: pair.baseToken.address,
      symbol: pair.baseToken.symbol || '?', pairUrl: pair.url || null, entryPrice: price,
      lastPrice: price, sizeSol: bot.maxPositionSol, openedAt: iso()
    };
    const fee = TX_FEE_SOL + (bot.priorityFeeSol || 0);
    const lamports = Math.floor(bot.maxPositionSol * LAMPORTS_PER_SOL);
    let owner, before;
    if (bot.mode === 'live') {
      if (!liveAllowed) return null;
      owner = getKeypair(bot);
      before = await connection.getBalance(owner.publicKey, 'confirmed');
      if (before < lamports + 0.01 * LAMPORTS_PER_SOL) {
        if (now - (lowBalanceLoggedAt.get(bot.id) || 0) >= 60_000) {
          lowBalanceLoggedAt.set(bot.id, now);
          log('warn', `${bot.name}: wallet balance too low for a ${bot.maxPositionSol} SOL buy (needs ${(bot.maxPositionSol + 0.01).toFixed(3)} SOL: the buy plus 0.01 SOL kept for fees and account deposits).`);
        }
        return null;
      }
    } else if (bot.paperBalanceSol < bot.maxPositionSol + fee) return null;

    // Check the token can be sold back, and what a buy-then-sell round trip costs, before buying.
    // This catches tokens with no sell route (honeypots), transfer taxes and pools too thin to exit.
    const buyQuote = await jupiterQuote(SOL_MINT, position.mint, lamports, bot);
    checkImpact(buyQuote, bot);
    const backQuote = await jupiterQuote(position.mint, SOL_MINT, buyQuote.outAmount, bot);
    const roundTripPct = (1 - Number(backQuote.outAmount) / lamports) * 100;
    if (bot.maxRoundTripPct > 0 && roundTripPct > bot.maxRoundTripPct) throw new Error(`buying and selling back would cost ${roundTripPct.toFixed(1)}% (limit ${bot.maxRoundTripPct}%)`);
    if (!bot.enabled) return null; // paused while quoting

    if (bot.mode === 'live') {
      const { signature } = await jupiterSwap(owner, SOL_MINT, position.mint, lamports, bot, { buying: true, quote: buyQuote });
      const after = await connection.getBalance(owner.publicKey, 'confirmed');
      const holdings = await tokenHoldings(owner.publicKey, position.mint);
      position.rentSol = rentOf(holdings);
      position.sizeSol = await solDelta(signature, before - after) - position.rentSol;
      position.buySignature = signature;
      const raw = holdings.reduce((s, a) => s + a.raw, 0n);
      position.tokenRaw = (raw > 0n ? raw : BigInt(buyQuote.otherAmountThreshold || buyQuote.outAmount)).toString();
    } else {
      // Paper fills use real Jupiter quotes plus network and priority fees, so paper results match
      // what the same trade would have done live.
      position.tokenRaw = buyQuote.outAmount;
      position.sizeSol = bot.maxPositionSol + fee;
      bot.paperBalanceSol -= position.sizeSol;
    }
    position.tokens = Number(position.tokenRaw) / 10 ** (decimals.get(position.mint) ?? 6);
    position.roundTripPct = roundTripPct;
    // What the token looked like when bought, so the trade journal can show which signals win.
    position.features = {
      ageMin: pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : null, liquidityUsd: pair.liquidity?.usd ?? null,
      buys5m: pair.txns?.m5?.buys ?? null, buySellRatio: (pair.txns?.m5?.buys || 0) / Math.max(pair.txns?.m5?.sells || 0, 1),
      roundTripPct, priceImpactPct: Number(buyQuote.priceImpactPct || 0) * 100,
      ...Object.fromEntries(AUDIT_KEYS.filter(k => k !== 'isSus').map(k => [k, pair[k] ?? null]))
    };
    const spot = (await pricesFor([position.mint]).catch(() => new Map())).get(position.mint);
    if (spot > 0) position.entryPrice = position.lastPrice = spot;
    const scale = Number(position.tokenRaw) / Number(buyQuote.outAmount);
    markValue(position, Number(backQuote.outAmount) * scale / LAMPORTS_PER_SOL - exitFee(bot), position.lastPrice, now);
    position.peakMultiple = position.multiple;
    db.positions.push(position);
    log('info', `${bot.name} bought ${position.symbol} for ${position.sizeSol.toFixed(4)} SOL (${bot.mode}); worth ${position.valueSol.toFixed(4)} SOL if sold now.`);
    return position;
  }

  async function closePosition(bot, position, reason, { quote = null } = {}) {
    let exitSol;
    let sellSignature = null;
    if (position.mode === 'live') {
      const owner = getKeypair(bot);
      const before = await connection.getBalance(owner.publicKey, 'confirmed');
      const raw = (await tokenHoldings(owner.publicKey, position.mint)).reduce((s, a) => s + a.raw, 0n);
      if (raw > 0n) sellSignature = (await jupiterSwap(owner, position.mint, SOL_MINT, raw.toString(), bot, { quote: quote && String(raw) === quote.inAmount ? quote : null })).signature;
      const mid = await connection.getBalance(owner.publicKey, 'confirmed');
      exitSol = sellSignature ? -(await solDelta(sellSignature, before - mid)) : 0;
      // The rent deposit comes back when the empty account closes; if it can't be closed it is lost.
      const closed = await reclaimRent(owner, await tokenHoldings(owner.publicKey, position.mint)).catch(e => { log('warn', `${bot.name}: could not close empty ${position.symbol} account: ${e.message}`); return false; });
      exitSol -= closed ? TX_FEE_SOL : (position.rentSol || 0);
    } else if (position.tokenRaw === '0') {
      exitSol = 0;
    } else if (position.tokenRaw) {
      quote ||= (await sellValue(bot, position)).quote;
      exitSol = Number(quote.outAmount) / LAMPORTS_PER_SOL - exitFee(bot);
      bot.paperBalanceSol += exitSol;
    } else {
      exitSol = position.tokens * position.lastPrice * 0.99; // paper positions opened before quote-based fills
      bot.paperBalanceSol += exitSol;
    }
    exitSol += position.realizedSol || 0; // SOL already banked by a partial sell
    const pnlSol = exitSol - position.sizeSol;
    const trade = {
      id: randomUUID(), botId: bot.id, mode: position.mode, mint: position.mint, symbol: position.symbol,
      entrySol: position.sizeSol, exitSol, pnlSol, multiple: exitSol / position.sizeSol, reason,
      partialSol: position.realizedSol || 0, features: position.features || null,
      openedAt: position.openedAt, closedAt: iso(),
      buySignature: position.buySignature || null, sellSignature
    };
    db.trades.push(trade);
    db.positions = db.positions.filter(p => p.id !== position.id);
    bot.stats.trades += 1;
    if (pnlSol > 0) bot.stats.wins += 1; else bot.stats.losses += 1;
    bot.stats.realizedPnlSol += pnlSol;
    log(pnlSol > 0 ? 'info' : 'warn', `${bot.name} sold ${position.symbol} (${reason.replace('_', ' ')}): ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL.`);
    return trade;
  }

  // Back off after a failed sell. Routes often vanish for a few minutes (e.g. a pump.fun token moving to
  // its AMM), so a position is only booked as a total loss after 8 failures spread over 10+ minutes.
  // Any tokens stay in the wallet.
  function sellFailed(bot, position, error, now) {
    position.sellFailures = (position.sellFailures || 0) + 1;
    position.firstSellFailureAt ||= now;
    position.nextSellAt = now + Math.min(60_000, 2_000 * 2 ** position.sellFailures);
    position.sellError = error.message;
    log('error', `${bot.name}: sell of ${position.symbol} failed (attempt ${position.sellFailures}): ${error.message}`);
    if (position.sellFailures < 8 || now - position.firstSellFailureAt < 10 * 60_000) return;
    db.trades.push({
      id: randomUUID(), botId: bot.id, mode: position.mode, mint: position.mint, symbol: position.symbol,
      entrySol: position.sizeSol, exitSol: (position.realizedSol || 0) - (position.rentSol || 0), pnlSol: (position.realizedSol || 0) - (position.rentSol || 0) - position.sizeSol,
      multiple: (position.realizedSol || 0) / position.sizeSol, reason: 'unsellable', partialSol: position.realizedSol || 0, features: position.features || null,
      openedAt: position.openedAt, closedAt: iso(), buySignature: position.buySignature || null, sellSignature: null
    });
    db.positions = db.positions.filter(p => p.id !== position.id);
    // The token account stays open while it holds tokens, so its rent deposit is lost with them.
    const lost = position.sizeSol + (position.rentSol || 0) - (position.realizedSol || 0);
    bot.stats.trades += 1; bot.stats.losses += 1; bot.stats.realizedPnlSol -= lost;
    log('warn', `${bot.name}: wrote off ${position.symbol} as unsellable (-${lost.toFixed(4)} SOL). Tokens left in the wallet.`);
  }

  // Sell part of a position and bank the SOL; the rest keeps running.
  async function sellPart(bot, position, now) {
    const pct = BigInt(Math.round(bot.partialSellPercent));
    let got;
    if (position.mode === 'live') {
      const owner = getKeypair(bot);
      const before = await connection.getBalance(owner.publicKey, 'confirmed');
      const raw = (await tokenHoldings(owner.publicKey, position.mint)).reduce((s, a) => s + a.raw, 0n);
      const amount = raw * pct / 100n;
      if (amount <= 0n) return;
      const { signature } = await jupiterSwap(owner, position.mint, SOL_MINT, amount.toString(), bot);
      got = -(await solDelta(signature, before - await connection.getBalance(owner.publicKey, 'confirmed')));
      position.tokenRaw = (await tokenHoldings(owner.publicKey, position.mint)).reduce((s, a) => s + a.raw, 0n).toString();
    } else {
      const amount = BigInt(position.tokenRaw) * pct / 100n;
      if (amount <= 0n) return;
      const quote = await jupiterQuote(position.mint, SOL_MINT, amount.toString(), bot);
      got = Number(quote.outAmount) / LAMPORTS_PER_SOL - exitFee(bot);
      bot.paperBalanceSol += got;
      position.tokenRaw = (BigInt(position.tokenRaw) - amount).toString();
    }
    position.realizedSol = (position.realizedSol || 0) + got;
    position.partialDone = true;
    position.valueSol = position.valueSol * (100 - Number(pct)) / 100;
    position.multiple = (position.realizedSol + position.valueSol) / position.sizeSol;
    log('info', `${bot.name} banked ${pct}% of ${position.symbol} at ${position.multiple.toFixed(2)}x: +${got.toFixed(4)} SOL back, the rest keeps running.`);
  }

  // Check one position against its exit rules and sell if one triggers. The spot price only decides
  // when to look closer: every exit is confirmed with a real sell quote first.
  async function managePosition(bot, position, now) {
    if (position.nextSellAt && now < position.nextSellAt) return;
    const timeUp = now - Date.parse(position.openedAt) >= bot.maxHoldMinutes * 60_000;
    const est = estimateMultiple(position);
    // Within 5% of take profit counts as a hint too, so a fast spike is confirmed and sold without waiting.
    const hint = exitReason(position, bot, est, now) || (partialDue(position, bot, est) ? 'partial' : null) ||
      (est >= bot.takeProfitMultiplier * 0.95 ? 'near_target' : null);
    // Re-quote as often as the budget allows: about 40% of Jupiter requests go to checking open positions.
    // When no bot is looking for a buy, the scan needs no quotes and checks get the whole background share.
    const buying = db.bots.some(b => b.enabled && db.positions.filter(p => p.botId === b.id).length < b.maxOpenPositions);
    const revalueMs = Math.min(REVALUE_MS, Math.max(REVALUE_MIN_MS, db.positions.length * 60_000 / (jupiterRpm * (buying ? 0.4 : 0.6))));
    const stale = !position.valueAt || now - position.valueAt >= revalueMs;
    if (!hint && !timeUp && !stale) return;
    if (!position.tokenRaw) {
      if (hint && hint !== 'partial' && hint !== 'near_target') await closePosition(bot, position, hint);
      return;
    }
    let quote = null;
    try {
      const v = await sellValue(bot, position, { priority: Boolean(hint || timeUp) });
      quote = v.quote;
      markValue(position, v.valueSol, position.lastPrice, now);
      position.sellError = null;
    } catch (e) {
      if (/budget/.test(e.message)) return; // background re-quote skipped; try again next tick
      // No route means the shown value is stale and the token may be worthless: count it as a failed sell.
      if (hint || timeUp || e.message === NO_ROUTE) throw e;
      return;
    }
    const reason = exitReason(position, bot, position.multiple, now);
    if (reason) await closePosition(bot, position, reason, { quote: position.mode === 'paper' ? quote : null });
    else if (partialDue(position, bot, position.multiple)) await sellPart(bot, position, now);
  }

  // Fast loop: price every open position and sell the moment an exit rule triggers.
  let lastPriceAt = 0, lastDexAt = 0, lastSaveAt = 0, dexMiss = new Set();
  async function monitor() {
    if (monitoring) return;
    monitoring = true;
    const now = clock();
    try {
      // Positions are managed even for paused bots so nothing is left unattended.
      const open = db.positions.filter(p => db.bots.some(b => b.id === p.botId));
      const tradeCount = db.trades.length;
      if (open.length) {
        // Spot prices every tick from DexScreener, which has its own rate limit and leaves Jupiter's budget
        // for sell quotes. Jupiter's price API takes over while DexScreener is rate-limited.
        // Tokens on a pump.fun curve are priced from the chain every tick. The rest use DexScreener every
        // second (its own rate limit, so Jupiter's budget stays for sell quotes), then Jupiter's price API.
        const mints = [...new Set(open.map(p => p.mint))];
        const prices = await curvePrices(mints).catch(() => new Map());
        const rest = mints.filter(m => !prices.has(m));
        if (rest.length && available(DEX_HOST) && now - lastDexAt >= DEX_PRICE_MS) {
          lastDexAt = now;
          for (const [m, pair] of await dexPairs(rest)) prices.set(m, Number(pair.priceNative));
          dexMiss = new Set(rest.filter(m => !prices.has(m)));
        }
        const missing = rest.filter(m => !available(DEX_HOST) || dexMiss.has(m));
        if (missing.length && now - lastPriceAt >= PRICE_MS) {
          lastPriceAt = now;
          for (const [m, price] of await pricesFor(missing)) prices.set(m, price);
        }
        for (const position of open) { const price = prices.get(position.mint); if (price > 0) position.lastPrice = price; }
        await Promise.all(open.map(position => {
          const bot = db.bots.find(b => b.id === position.botId);
          return withWallet(bot, () => db.positions.includes(position) && managePosition(bot, position, now)).catch(e => sellFailed(bot, position, e, now));
        }));
        // Ticks are fast, so state is written at most every 2 s, or straight away when a trade closed.
        if (db.trades.length !== tradeCount || now - lastSaveAt >= 2_000) { lastSaveAt = now; await save(); }
      }
      for (const bot of db.bots.filter(b => b.enabled)) {
        if (todayPnl(db.trades, bot.id, now) <= -bot.maxDailyLossSol) {
          bot.enabled = false; bot.status = 'Stopped · daily loss limit hit';
          log('warn', `${bot.name} stopped: daily loss limit of ${bot.maxDailyLossSol} SOL reached.`);
          await save();
        }
      }
      health.lastError = null;
    } catch (e) {
      health.lastError = e.message;
      log('error', `Position check failed: ${e.message}`);
    } finally {
      health.lastTickAt = iso();
      health.ticks += 1;
      monitoring = false;
    }
  }

  // Tokens that failed a buy check are skipped for a while instead of being re-quoted every scan.
  const rejected = new Map(); // mint -> retry after
  const skips = {};
  let lastSummaryAt = clock();
  // Slower loop: refresh the watchlist and buy anything that passes a bot's filters.
  async function scan() {
    if (scanning) return;
    scanning = true;
    const now = clock();
    try {
      const hungry = db.bots.filter(b => b.enabled && db.positions.filter(p => p.botId === b.id).length < b.maxOpenPositions);
      if (!hungry.length) return;
      const candidates = await discover(now);
      health.candidates = candidates.size;
      // Newest launches first.
      const ordered = [...candidates].sort((a, b) => (b[1].pairCreatedAt || 0) - (a[1].pairCreatedAt || 0));
      let bought = false;
      for (const bot of hungry) {
        for (const [mint, pair] of ordered) {
          if (!bot.enabled || db.positions.filter(p => p.botId === bot.id).length >= bot.maxOpenPositions) break;
          if (db.positions.some(p => p.botId === bot.id && p.mint === mint)) continue;
          if (db.trades.some(t => t.botId === bot.id && t.mint === mint)) continue;
          if ((rejected.get(mint) || 0) > now) continue;
          const failed = passesFilters(pair, bot, now);
          if (failed.length) { skips[failed[0]] = (skips[failed[0]] || 0) + 1; continue; }
          if (!(await mintIsSafe(mint).catch(() => false))) { skips.mint_authority = (skips.mint_authority || 0) + 1; continue; }
          try { if (await withWallet(bot, () => openPosition(bot, pair))) bought = true; }
          catch (e) {
            rejected.set(mint, now + (/ 429|budget/.test(e.message) ? 30_000 : 5 * 60_000));
            const key = /round trip|selling back/.test(e.message) ? 'round_trip' : /impact/.test(e.message) ? 'price_impact' : /route/.test(e.message) ? 'no_route'
              : /on top of the trade/.test(e.message) ? 'hidden_cost' : /would fail/.test(e.message) ? 'would_fail' : / 429/.test(e.message) ? 'rate_limited' : 'error';
            skips[key] = (skips[key] || 0) + 1;
            if (key === 'error') log('error', `${bot.name}: buy of ${pair.baseToken?.symbol} failed: ${e.message}`);
          }
        }
      }
      for (const bot of db.bots) if (bot.enabled) bot.status = `Running · ${bot.mode}`;
      if (bought) await save();
      if (now - lastSummaryAt >= 60_000) {
        health.skips = { ...skips };
        log('info', `Scan: watching ${health.watching} tokens. Skipped in the last minute: ${Object.entries(skips).map(([k, n]) => `${k.replace('_', ' ')} ${n}`).join(', ') || 'none'}.`);
        for (const k of Object.keys(skips)) delete skips[k];
        lastSummaryAt = now;
      }
    } catch (e) {
      health.lastError = e.message;
      log('error', `Market scan failed: ${e.message}`);
    } finally {
      health.lastScanAt = iso();
      health.scans += 1;
      scanning = false;
    }
  }

  async function tick() { await monitor(); await scan(); }

  return {
    start() {
      if (timers.length) return;
      timers.push(setInterval(monitor, monitorMs), setInterval(scan, scanMs));
      tick();
    },
    stop() { timers.splice(0).forEach(clearInterval); },
    tick, monitor, scan, health, liveAllowed, jupiterSwap, estimateMultiple,
    closePosition: (bot, position, reason) => withWallet(bot, () => db.positions.includes(position) ? closePosition(bot, position, reason) : null)
  };
}
