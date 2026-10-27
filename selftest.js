// Checks every external dependency the bots need, against the real network, without spending SOL.
import { PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SOL_MINT, DEXSCREENER, GECKOTERMINAL, JUPITER } from './engine.js';

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

  await step('New pools feed (GeckoTerminal)', async () => {
    const pools = (await getJson(`${GECKOTERMINAL}/networks/solana/new_pools?page=1`)).data || [];
    const sol = pools.filter(p => p?.relationships?.quote_token?.data?.id === `solana_${SOL_MINT}`);
    ctx.mints = sol.map(p => p.relationships.base_token.data.id.slice(7));
    if (!ctx.mints.length) throw new Error(`${pools.length} pools returned, none quoted in SOL`);
    return `${pools.length} new pools, ${sol.length} paired with SOL`;
  });
  await step('Token profiles feed (DexScreener)', async () => {
    const list = await getJson(`${DEXSCREENER}/token-profiles/latest/v1`);
    return `${list.filter(i => i.chainId === 'solana').length} Solana profiles`;
  });
  await step('Pair prices (DexScreener)', async () => {
    const mints = (ctx.mints || []).slice(0, 30);
    if (!mints.length) throw new Error('No mints to price (new pools feed failed)');
    const pairs = await getJson(`${DEXSCREENER}/tokens/v1/solana/${mints.join(',')}`);
    const priced = pairs.filter(p => p.quoteToken?.address === SOL_MINT && Number(p.priceNative) > 0);
    if (!priced.length) throw new Error(`${pairs.length} pairs returned, none priced in SOL`);
    priced.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    ctx.pair = priced[0];
    return `${priced.length}/${mints.length} priced; e.g. ${ctx.pair.baseToken.symbol} at ${Number(ctx.pair.priceNative).toPrecision(3)} SOL, liquidity $${Math.round(ctx.pair.liquidity?.usd || 0).toLocaleString()}`;
  });
  await step('Mint safety check (mainnet RPC)', async () => {
    const mint = ctx.pair?.baseToken?.address || USDC;
    const info = (await marketConnection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')).value?.data?.parsed?.info;
    if (!info) throw new Error(`Could not read mint ${mint}`);
    return `${ctx.pair?.baseToken?.symbol || 'USDC'}: mint authority ${info.mintAuthority ? 'ACTIVE (would be skipped)' : 'revoked'}, freeze authority ${info.freezeAuthority ? 'ACTIVE (would be skipped)' : 'revoked'}`;
  });
  await step('Swap quote SOL → USDC (Jupiter)', async () => {
    const q = await getJson(`${JUPITER}/quote?inputMint=${SOL_MINT}&outputMint=${USDC}&amount=10000000&slippageBps=50`);
    if (!q.outAmount) throw new Error(JSON.stringify(q).slice(0, 160));
    ctx.quote = q;
    return `0.01 SOL → ${(Number(q.outAmount) / 1e6).toFixed(4)} USDC via ${q.routePlan?.length || '?'} hop(s)`;
  });
  await step('Swap quote SOL → new token (Jupiter)', async () => {
    if (!ctx.pair) throw new Error('No new token to quote');
    const q = await getJson(`${JUPITER}/quote?inputMint=${SOL_MINT}&outputMint=${ctx.pair.baseToken.address}&amount=10000000&slippageBps=500`);
    if (!q.outAmount) throw new Error(`No route for ${ctx.pair.baseToken.symbol}`);
    return `${ctx.pair.baseToken.symbol} is routable, price impact ${(Number(q.priceImpactPct || 0) * 100).toFixed(2)}%`;
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
