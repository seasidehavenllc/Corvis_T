// Checks every external dependency the bots need, against the real network, without spending SOL.
import { PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SOL_MINT, DEXSCREENER, GECKOTERMINAL, JUPITER, JUPITER_PRICE, JUPITER_TOKENS } from './engine.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function runSelfTest({ fetchImpl = fetch, connection, marketConnection, walletAddress }) {
  const steps = [];
  const ctx = {};
  async function step(name, fn) {
    const t0 = Date.now();
    try { const detail = await fn(); steps.push({ name, ok: true, ms: Date.now() - t0, detail }); }
    catch (e) { steps.push({ name, ok: false, ms: Date.now() - t0, detail: e.message }); }
  }
  async function getJson(url, init) {
    const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  }

  await step('New tokens feed (Jupiter)', async () => {
    const list = await getJson(`${JUPITER_TOKENS}/recent`);
    if (!Array.isArray(list) || !list.length) throw new Error('No recent tokens returned');
    const fresh = list.filter(t => t.id && Number(t.usdPrice) > 0);
    fresh.sort((a, b) => (Number(b.liquidity) || 0) - (Number(a.liquidity) || 0));
    const t = fresh[0];
    ctx.mints = fresh.map(x => x.id);
    ctx.token = { mint: t.id, symbol: t.symbol };
    const age = t.firstPool?.createdAt ? Math.round((Date.now() - Date.parse(t.firstPool.createdAt)) / 60000) : '?';
    return `${list.length} recent tokens; e.g. ${t.symbol}: liquidity $${Math.round(t.liquidity || 0).toLocaleString()}, ${t.stats5m?.numBuys ?? '?'} buys / ${t.stats5m?.numSells ?? '?'} sells in 5m, pool ${age} min old`;
  });
  await step('New pools feed (GeckoTerminal, optional)', async () => {
    try {
      const pools = (await getJson(`${GECKOTERMINAL}/networks/solana/new_pools?page=1`)).data || [];
      return `${pools.filter(p => p?.relationships?.quote_token?.data?.id === `solana_${SOL_MINT}`).length}/${pools.length} new pools paired with SOL`;
    } catch (e) { if (/ 429/.test(e.message)) return 'Rate-limited from this server right now. The bots skip it and use the other feeds.'; throw e; }
  });
  await step('Live prices (Jupiter price API)', async () => {
    const ids = [SOL_MINT, ...(ctx.mints || []).slice(0, 20)];
    const data = await getJson(`${JUPITER_PRICE}?ids=${ids.join(',')}`);
    const solUsd = Number(data?.[SOL_MINT]?.usdPrice);
    if (!(solUsd > 0)) throw new Error('No SOL price returned');
    return `SOL $${solUsd.toFixed(2)}; ${ids.slice(1).filter(m => Number(data?.[m]?.usdPrice) > 0).length}/${ids.length - 1} new tokens priced`;
  });
  await step('DexScreener (optional extra feed)', async () => {
    try { const list = await getJson(`${DEXSCREENER}/token-profiles/latest/v1`); return `${list.filter(i => i.chainId === 'solana').length} Solana profiles`; }
    catch (e) { if (/ 429/.test(e.message)) return 'Rate-limited from this server (common on shared hosting). The bots skip it and use GeckoTerminal + Jupiter.'; throw e; }
  });
  await step('Mint safety check (mainnet RPC)', async () => {
    const mint = ctx.token?.mint || USDC;
    const info = (await marketConnection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')).value?.data?.parsed?.info;
    if (!info) throw new Error(`Could not read mint ${mint}`);
    return `${ctx.token?.symbol || 'USDC'}: mint authority ${info.mintAuthority ? 'ACTIVE (would be skipped)' : 'revoked'}, freeze authority ${info.freezeAuthority ? 'ACTIVE (would be skipped)' : 'revoked'}`;
  });
  await step('Swap quote SOL → USDC (Jupiter)', async () => {
    const q = await getJson(`${JUPITER}/quote?inputMint=${SOL_MINT}&outputMint=${USDC}&amount=10000000&slippageBps=50`);
    if (!q.outAmount) throw new Error(JSON.stringify(q).slice(0, 160));
    ctx.quote = q;
    return `0.01 SOL → ${(Number(q.outAmount) / 1e6).toFixed(4)} USDC via ${q.routePlan?.length || '?'} hop(s)`;
  });
  await step('Swap quote SOL → new token (Jupiter)', async () => {
    if (!ctx.token) throw new Error('No new token to quote');
    const q = await getJson(`${JUPITER}/quote?inputMint=${SOL_MINT}&outputMint=${ctx.token.mint}&amount=10000000&slippageBps=500`);
    if (!q.outAmount) throw new Error(`No route for ${ctx.token.symbol}`);
    return `${ctx.token.symbol} is routable, price impact ${(Number(q.priceImpactPct || 0) * 100).toFixed(2)}%`;
  });
  await step('Build + simulate swap transaction (Jupiter → mainnet RPC)', async () => {
    if (!ctx.quote) throw new Error('No quote to build from');
    const owner = walletAddress || '11111111111111111111111111111111';
    const { swapTransaction, lastValidBlockHeight } = await getJson(`${JUPITER}/swap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: ctx.quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 500000, priorityLevel: 'veryHigh' } } })
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    const sim = await marketConnection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    const balance = walletAddress ? await marketConnection.getBalance(new PublicKey(walletAddress), 'confirmed') : 0;
    const err = sim.value.err ? JSON.stringify(sim.value.err) : null;
    const unfunded = balance < 0.012 * LAMPORTS_PER_SOL;
    if (err && !unfunded) throw new Error(`Simulation failed: ${err}. ${(sim.value.logs || []).slice(-3).join(' | ')}`);
    return `Transaction built (${tx.serialize().length} bytes, valid until block ${lastValidBlockHeight}). ` +
      (err ? `Simulation stopped at "${err}" because the wallet has ${balance / LAMPORTS_PER_SOL} SOL on mainnet. Expected until it's funded.` : `Simulation succeeded using ${sim.value.unitsConsumed} compute units.`);
  });
  await step('Trading RPC (configured network)', async () => {
    const t0 = Date.now();
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    return `Latest blockhash ${blockhash.slice(0, 8)}… in ${Date.now() - t0} ms`;
  });
  return { at: new Date().toISOString(), ok: steps.every(s => s.ok), steps };
}
