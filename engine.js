import { PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEXSCREENER = 'https://api.dexscreener.com';
const JUPITER = process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1';
const SEEN_TTL_MS = 30 * 60 * 1000;

export const STRATEGY_DEFAULTS = {
  mode: 'paper',
  minLiquidityUsd: 5000,
  maxPairAgeMinutes: 30,
  minBuys5m: 10,
  maxOpenPositions: 3,
  maxHoldMinutes: 60,
  slippageBps: 300,
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
  if ((pair.liquidity?.usd || 0) < bot.minLiquidityUsd) reasons.push('liquidity');
  if (!pair.pairCreatedAt || now - pair.pairCreatedAt > bot.maxPairAgeMinutes * 60_000) reasons.push('age');
  if ((pair.txns?.m5?.buys || 0) < bot.minBuys5m) reasons.push('buys');
  return reasons;
}

// Decide whether an open position should be closed at the current SOL price.
export function exitReason(position, bot, price, now = Date.now()) {
  const multiple = price / position.entryPrice;
  if (multiple >= bot.takeProfitMultiplier) return 'take_profit';
  if (multiple <= 1 - bot.stopLossPercent / 100) return 'stop_loss';
  if (now - Date.parse(position.openedAt) >= bot.maxHoldMinutes * 60_000) return 'max_hold';
  return null;
}

export function todayPnl(trades, botId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return trades.filter(t => t.botId === botId && t.closedAt?.startsWith(day)).reduce((s, t) => s + t.pnlSol, 0);
}

export function createEngine({ db, save, log, connection, marketConnection = connection, getKeypair, liveAllowed, fetchImpl = fetch, tickMs = 15_000, paperCostPct = 1 }) {
  const seen = new Map();
  let timer = null;
  let running = false;
  const health = { lastTickAt: null, lastError: null, candidates: 0, ticks: 0 };

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
  async function discover(now) {
    for (const [mint, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(mint);
    const lists = await Promise.allSettled([
      getJson(`${DEXSCREENER}/token-profiles/latest/v1`),
      getJson(`${DEXSCREENER}/token-boosts/latest/v1`)
    ]);
    const fresh = [];
    for (const list of lists) {
      if (list.status !== 'fulfilled' || !Array.isArray(list.value)) continue;
      for (const item of list.value) {
        if (item?.chainId !== 'solana' || !item.tokenAddress || seen.has(item.tokenAddress) || fresh.includes(item.tokenAddress)) continue;
        fresh.push(item.tokenAddress);
      }
    }
    fresh.forEach(m => seen.set(m, now));
    return fresh.length ? pairsFor(fresh.slice(0, 60)) : new Map();
  }
  // Reject tokens whose creator can still mint more supply or freeze holders' accounts.
  async function mintIsSafe(mint) {
    const info = await marketConnection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
    const parsed = info.value?.data?.parsed?.info;
    return Boolean(parsed) && parsed.mintAuthority == null && parsed.freezeAuthority == null;
  }

  async function jupiterSwap(owner, inputMint, outputMint, amount, slippageBps) {
    const quote = await getJson(`${JUPITER}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
    if (!quote?.outAmount) throw new Error('No Jupiter route for this token.');
    const { swapTransaction } = await getJson(`${JUPITER}/swap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' })
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    tx.sign([owner]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const latest = await connection.getLatestBlockhash('confirmed');
    const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
    if (result.value.err) throw new Error(`Swap failed on-chain: ${JSON.stringify(result.value.err)}`);
    return { signature, quote };
  }
  async function tokenRawBalance(owner, mint) {
    const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, 'confirmed');
    return res.value.reduce((s, a) => s + BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0'), 0n);
  }

  async function openPosition(bot, pair) {
    const price = Number(pair.priceNative);
    const position = {
      id: randomUUID(), botId: bot.id, mode: bot.mode, mint: pair.baseToken.address,
      symbol: pair.baseToken.symbol || '?', pairUrl: pair.url || null, entryPrice: price,
      lastPrice: price, sizeSol: bot.maxPositionSol, openedAt: new Date().toISOString()
    };
    if (bot.mode === 'live') {
      if (!liveAllowed) return null;
      const owner = getKeypair(bot);
      const before = await connection.getBalance(owner.publicKey, 'confirmed');
      const lamports = Math.floor(bot.maxPositionSol * LAMPORTS_PER_SOL);
      if (before < lamports + 0.01 * LAMPORTS_PER_SOL) { log('warn', `${bot.name}: wallet balance too low for a ${bot.maxPositionSol} SOL buy.`); return null; }
      const { signature } = await jupiterSwap(owner, SOL_MINT, position.mint, lamports, bot.slippageBps);
      const after = await connection.getBalance(owner.publicKey, 'confirmed');
      position.sizeSol = (before - after) / LAMPORTS_PER_SOL;
      position.tokenRaw = (await tokenRawBalance(owner.publicKey, position.mint)).toString();
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
      const raw = await tokenRawBalance(owner.publicKey, position.mint);
      const before = await connection.getBalance(owner.publicKey, 'confirmed');
      if (raw > 0n) sellSignature = (await jupiterSwap(owner, position.mint, SOL_MINT, raw.toString(), bot.slippageBps)).signature;
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
      openedAt: position.openedAt, closedAt: new Date().toISOString(),
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

  async function tick() {
    if (running) return;
    running = true;
    const now = Date.now();
    try {
      const bots = db.bots.filter(b => b.enabled);
      let dirty = false;
      // 1. Manage open positions.
      // Positions are managed even for paused bots so nothing is left unattended.
      const open = db.positions.filter(p => db.bots.some(b => b.id === p.botId));
      if (open.length) {
        const prices = await pairsFor([...new Set(open.map(p => p.mint))]);
        for (const position of open) {
          const bot = db.bots.find(b => b.id === position.botId);
          const pair = prices.get(position.mint);
          if (pair) position.lastPrice = Number(pair.priceNative);
          const reason = exitReason(position, bot, position.lastPrice, now);
          if (!reason) continue;
          try { await closePosition(bot, position, reason); } catch (e) { log('error', `${bot.name}: sell of ${position.symbol} failed: ${e.message}`); }
          dirty = true;
        }
      }
      // 2. Daily loss guard.
      for (const bot of bots) {
        if (todayPnl(db.trades, bot.id, now) <= -bot.maxDailyLossSol) {
          bot.enabled = false; bot.status = 'Stopped · daily loss limit hit'; dirty = true;
          log('warn', `${bot.name} stopped: daily loss limit of ${bot.maxDailyLossSol} SOL reached.`);
        }
      }
      // 3. Look for new entries.
      const hungry = bots.filter(b => b.enabled && db.positions.filter(p => p.botId === b.id).length < b.maxOpenPositions);
      if (hungry.length) {
        const candidates = await discover(now);
        health.candidates = candidates.size;
        const safety = new Map();
        for (const bot of hungry) {
          for (const [mint, pair] of candidates) {
            if (db.positions.filter(p => p.botId === bot.id).length >= bot.maxOpenPositions) break;
            if (db.positions.some(p => p.botId === bot.id && p.mint === mint)) continue;
            if (db.trades.some(t => t.botId === bot.id && t.mint === mint)) continue;
            if (passesFilters(pair, bot, now).length) continue;
            if (!safety.has(mint)) safety.set(mint, await mintIsSafe(mint).catch(() => false));
            if (!safety.get(mint)) continue;
            try { if (await openPosition(bot, pair)) dirty = true; } catch (e) { log('error', `${bot.name}: buy of ${pair.baseToken?.symbol} failed: ${e.message}`); }
          }
        }
      }
      for (const bot of db.bots) {
        if (bot.enabled) bot.status = `Running · ${bot.mode}`;
      }
      if (dirty || bots.length || open.length) await save();
      health.lastError = null;
    } catch (e) {
      health.lastError = e.message;
      log('error', `Engine tick failed: ${e.message}`);
    } finally {
      health.lastTickAt = new Date().toISOString();
      health.ticks += 1;
      running = false;
    }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, tickMs); tick(); } },
    stop() { clearInterval(timer); timer = null; },
    tick, closePosition, health, liveAllowed
  };
}
