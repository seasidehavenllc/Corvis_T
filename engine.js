import { PublicKey, VersionedTransaction, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { randomUUID } from 'node:crypto';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEXSCREENER = 'https://api.dexscreener.com';
export const GECKOTERMINAL = 'https://api.geckoterminal.com/api/v2';
export const JUPITER = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1';
const SEEN_TTL_MS = 30 * 60 * 1000;
const WATCHLIST_MAX = 120;

export const STRATEGY_DEFAULTS = {
  mode: 'paper',
  minLiquidityUsd: 5000,
  maxPairAgeMinutes: 30,
  minBuys5m: 10,
  minBuySellRatio: 1.2,
  maxOpenPositions: 3,
  maxHoldMinutes: 30,
  trailingStopPercent: 12,
  slippageBps: 500,
  priorityFeeSol: 0.0005,
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
  const buys = pair.txns?.m5?.buys || 0;
  const sells = pair.txns?.m5?.sells || 0;
  if ((pair.liquidity?.usd || 0) < bot.minLiquidityUsd) reasons.push('liquidity');
  if (!pair.pairCreatedAt || now - pair.pairCreatedAt > bot.maxPairAgeMinutes * 60_000) reasons.push('age');
  if (buys < bot.minBuys5m) reasons.push('buys');
  // Momentum: more buyers than sellers in the last 5 minutes.
  if (bot.minBuySellRatio > 0 && buys < bot.minBuySellRatio * Math.max(sells, 1)) reasons.push('momentum');
  return reasons;
}

// Decide whether an open position should be closed at the current SOL price.
export function exitReason(position, bot, price, now = Date.now()) {
  const multiple = price / position.entryPrice;
  const peak = Math.max(position.peakPrice || position.entryPrice, price);
  if (multiple >= bot.takeProfitMultiplier) return 'take_profit';
  if (multiple <= 1 - bot.stopLossPercent / 100) return 'stop_loss';
  // Trailing stop arms once the position is up by the trail distance, then sells on that much pullback from the peak.
  const trail = (bot.trailingStopPercent || 0) / 100;
  if (trail > 0 && peak >= position.entryPrice * (1 + trail) && price <= peak * (1 - trail)) return 'trailing_stop';
  if (now - Date.parse(position.openedAt) >= bot.maxHoldMinutes * 60_000) return 'max_hold';
  return null;
}

export function todayPnl(trades, botId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return trades.filter(t => t.botId === botId && t.closedAt?.startsWith(day)).reduce((s, t) => s + t.pnlSol, 0);
}

export function createEngine({
  db, save, log, connection, marketConnection = connection, getKeypair, liveAllowed,
  fetchImpl = fetch, monitorMs = 2_000, scanMs = 5_000, paperCostPct = 1,
  clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms))
}) {
  const watch = new Map(); // mint -> first seen time
  const safety = new Map(); // mint -> boolean
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

  async function getJson(url, init) {
    const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } });
    if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
    return res.json();
  }
  async function pairsFor(mints) {
    const out = new Map();
    for (let i = 0; i < mints.length; i += 30) {
      const pairs = await getJson(`${DEXSCREENER}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`);
      for (const [mint, pair] of bestSolPairs(pairs)) out.set(mint, pair);
    }
    return out;
  }
  // New tokens come from three feeds. Each one is watched for SEEN_TTL_MS and re-checked every scan,
  // so a launch that is too quiet at first can still be bought once it picks up.
  async function discover(now) {
    for (const [mint, at] of watch) if (now - at > SEEN_TTL_MS) watch.delete(mint);
    const feeds = await Promise.allSettled([
      getJson(`${GECKOTERMINAL}/networks/solana/new_pools?page=1`),
      getJson(`${DEXSCREENER}/token-profiles/latest/v1`),
      getJson(`${DEXSCREENER}/token-boosts/latest/v1`)
    ]);
    const add = mint => { if (mint && !watch.has(mint)) watch.set(mint, now); };
    if (feeds[0].status === 'fulfilled') {
      for (const pool of feeds[0].value?.data || []) {
        const base = pool?.relationships?.base_token?.data?.id || '';
        const quote = pool?.relationships?.quote_token?.data?.id || '';
        if (base.startsWith('solana_') && quote === `solana_${SOL_MINT}`) add(base.slice(7));
      }
    }
    for (const feed of feeds.slice(1)) {
      if (feed.status !== 'fulfilled' || !Array.isArray(feed.value)) continue;
      for (const item of feed.value) if (item?.chainId === 'solana') add(item.tokenAddress);
    }
    while (watch.size > WATCHLIST_MAX) watch.delete(watch.keys().next().value);
    health.watching = watch.size;
    return watch.size ? pairsFor([...watch.keys()]) : new Map();
  }
  // Reject tokens whose creator can still mint more supply or freeze holders' accounts.
  async function mintIsSafe(mint) {
    if (safety.has(mint)) return safety.get(mint);
    const info = await marketConnection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const parsed = info.value?.data?.parsed?.info;
    const ok = Boolean(parsed) && parsed.mintAuthority == null && parsed.freezeAuthority == null;
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
  async function jupiterSwap(owner, inputMint, outputMint, amount, bot) {
    const quote = await getJson(`${JUPITER}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${bot.slippageBps}&restrictIntermediateTokens=true`);
    if (!quote?.outAmount) throw new Error('No Jupiter route for this token.');
    const { swapTransaction, lastValidBlockHeight } = await getJson(`${JUPITER}/swap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote, userPublicKey: owner.publicKey.toBase58(), wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true, dynamicSlippage: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.floor((bot.priorityFeeSol ?? 0.0005) * LAMPORTS_PER_SOL), priorityLevel: 'veryHigh' } }
      })
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([owner]);
    return { signature: await sendAndConfirm(tx, lastValidBlockHeight), quote };
  }
  async function tokenHoldings(owner, mint) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, 'confirmed');
    return res.value.map(a => ({
      pubkey: a.pubkey, programId: a.account.owner,
      raw: BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0'),
      ui: Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount || 0)
    }));
  }
  // Close emptied token accounts so the ~0.002 SOL rent comes back to the bot wallet.
  async function reclaimRent(owner, accounts) {
    const empty = accounts.filter(a => a.raw === 0n);
    if (!empty.length) return;
    const tx = new Transaction();
    for (const a of empty) tx.add(createCloseAccountInstruction(a.pubkey, owner.publicKey, owner.publicKey, [], a.programId));
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash; tx.feePayer = owner.publicKey; tx.sign(owner);
    await sendAndConfirm(tx, lastValidBlockHeight);
  }

  async function openPosition(bot, pair) {
    const price = Number(pair.priceNative);
    const position = {
      id: randomUUID(), botId: bot.id, mode: bot.mode, mint: pair.baseToken.address,
      symbol: pair.baseToken.symbol || '?', pairUrl: pair.url || null, entryPrice: price,
      lastPrice: price, peakPrice: price, sizeSol: bot.maxPositionSol, openedAt: iso()
    };
    if (bot.mode === 'live') {
      if (!liveAllowed) return null;
      const owner = getKeypair(bot);
      const before = await connection.getBalance(owner.publicKey, 'confirmed');
      const lamports = Math.floor(bot.maxPositionSol * LAMPORTS_PER_SOL);
      if (before < lamports + 0.01 * LAMPORTS_PER_SOL) { log('warn', `${bot.name}: wallet balance too low for a ${bot.maxPositionSol} SOL buy.`); return null; }
      const { signature } = await jupiterSwap(owner, SOL_MINT, position.mint, lamports, bot);
      const after = await connection.getBalance(owner.publicKey, 'confirmed');
      const held = (await tokenHoldings(owner.publicKey, position.mint)).reduce((s, a) => s + a.ui, 0);
      position.sizeSol = (before - after) / LAMPORTS_PER_SOL;
      // Track exits against the price actually paid (including fees and account rent), not the quoted one.
      if (held > 0) position.entryPrice = position.peakPrice = position.lastPrice = position.sizeSol / held;
      position.buySignature = signature;
    } else {
      if (bot.paperBalanceSol < bot.maxPositionSol) return null;
      position.tokens = bot.maxPositionSol * (1 - paperCostPct / 100) / price;
      bot.paperBalanceSol -= bot.maxPositionSol;
    }
    db.positions.push(position);
    log('info', `${bot.name} bought ${position.symbol} for ${position.sizeSol.toFixed(4)} SOL (${bot.mode}).`);
    return position;
  }

  async function closePosition(bot, position, reason, price = position.lastPrice) {
    let exitSol;
    let sellSignature = null;
    if (position.mode === 'live') {
      const owner = getKeypair(bot);
      const before = await connection.getBalance(owner.publicKey, 'confirmed');
      const raw = (await tokenHoldings(owner.publicKey, position.mint)).reduce((s, a) => s + a.raw, 0n);
      if (raw > 0n) sellSignature = (await jupiterSwap(owner, position.mint, SOL_MINT, raw.toString(), bot)).signature;
      await reclaimRent(owner, await tokenHoldings(owner.publicKey, position.mint)).catch(e => log('warn', `${bot.name}: could not close empty ${position.symbol} account: ${e.message}`));
      const after = await connection.getBalance(owner.publicKey, 'confirmed');
      exitSol = (after - before) / LAMPORTS_PER_SOL;
    } else {
      exitSol = position.tokens * price * (1 - paperCostPct / 100);
      bot.paperBalanceSol += exitSol;
    }
    const pnlSol = exitSol - position.sizeSol;
    const trade = {
      id: randomUUID(), botId: bot.id, mode: position.mode, mint: position.mint, symbol: position.symbol,
      entrySol: position.sizeSol, exitSol, pnlSol, multiple: price / position.entryPrice, reason,
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

  // Back off after a failed sell; after 5 failures in a row (usually a rug with no liquidity left),
  // book the position as a total loss so the bot stops retrying. Any tokens stay in the wallet.
  function sellFailed(bot, position, error, now) {
    position.sellFailures = (position.sellFailures || 0) + 1;
    position.nextSellAt = now + Math.min(60_000, 2_000 * 2 ** position.sellFailures);
    log('error', `${bot.name}: sell of ${position.symbol} failed (attempt ${position.sellFailures}): ${error.message}`);
    if (position.sellFailures < 5) return;
    db.trades.push({
      id: randomUUID(), botId: bot.id, mode: position.mode, mint: position.mint, symbol: position.symbol,
      entrySol: position.sizeSol, exitSol: 0, pnlSol: -position.sizeSol, multiple: 0, reason: 'unsellable',
      openedAt: position.openedAt, closedAt: iso(), buySignature: position.buySignature || null, sellSignature: null
    });
    db.positions = db.positions.filter(p => p.id !== position.id);
    bot.stats.trades += 1; bot.stats.losses += 1; bot.stats.realizedPnlSol -= position.sizeSol;
    log('warn', `${bot.name}: wrote off ${position.symbol} as unsellable (-${position.sizeSol.toFixed(4)} SOL). Tokens left in the wallet.`);
  }

  // Fast loop: price every open position and sell the moment an exit rule triggers.
  async function monitor() {
    if (monitoring) return;
    monitoring = true;
    const now = clock();
    try {
      // Positions are managed even for paused bots so nothing is left unattended.
      const open = db.positions.filter(p => db.bots.some(b => b.id === p.botId));
      if (open.length) {
        const prices = await pairsFor([...new Set(open.map(p => p.mint))]);
        const exits = [];
        for (const position of open) {
          const bot = db.bots.find(b => b.id === position.botId);
          const pair = prices.get(position.mint);
          if (pair) { position.lastPrice = Number(pair.priceNative); position.peakPrice = Math.max(position.peakPrice || position.entryPrice, position.lastPrice); }
          if (position.nextSellAt && now < position.nextSellAt) continue;
          const reason = exitReason(position, bot, position.lastPrice, now);
          if (reason) exits.push(withWallet(bot, () => closePosition(bot, position, reason)).catch(e => sellFailed(bot, position, e, now)));
        }
        await Promise.all(exits);
        await save();
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
          if (passesFilters(pair, bot, now).length) continue;
          if (!(await mintIsSafe(mint).catch(() => false))) continue;
          try { if (await withWallet(bot, () => openPosition(bot, pair))) bought = true; } catch (e) { log('error', `${bot.name}: buy of ${pair.baseToken?.symbol} failed: ${e.message}`); }
        }
      }
      for (const bot of db.bots) if (bot.enabled) bot.status = `Running · ${bot.mode}`;
      if (bought) await save();
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
    tick, monitor, scan, health, liveAllowed, jupiterSwap,
    closePosition: (bot, position, reason) => withWallet(bot, () => closePosition(bot, position, reason))
  };
}
