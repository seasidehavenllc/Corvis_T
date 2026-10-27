// A synthetic Solana memecoin market for exercising the engine end to end without the network.
// It fakes DexScreener, GeckoTerminal, Jupiter and the Solana RPC, including real signed
// transactions, so live mode runs the same code path it uses on mainnet.
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SOL_MINT } from '../engine.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const bs58 = { encode(bytes) { let v = 0n; for (const b of bytes) v = v * 256n + BigInt(b); let o = ''; while (v > 0n) { o = B58[Number(v % 58n)] + o; v /= 58n; } for (const b of bytes) { if (b) break; o = '1' + o; } return o; } };
const RENT = 2_039_280; // lamports for a token account
const TX_FEE = 5_000;
const DECIMALS = 6;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function createMarket({ seed = 42, start = Date.parse('2026-10-27T00:00:00Z'), launchEveryMs = 90_000, dexScreenerDown = false } = {}) {
  const rand = rng(seed);
  const state = { now: start, tokens: new Map(), wallets: new Map(), pending: new Map(), sent: new Map(), nextLaunch: start, stats: { swaps: 0, closes: 0, quotes: 0 } };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

  function launch() {
    const mint = Keypair.generate().publicKey.toBase58();
    const r = rand();
    // pump: rallies then fades; rug: liquidity pulled; dud: drifts down; moon: big run.
    const kind = r < 0.3 ? 'pump' : r < 0.5 ? 'rug' : r < 0.9 ? 'dud' : 'moon';
    state.tokens.set(mint, {
      mint, kind, symbol: `SIM${state.tokens.size + 1}`, createdAt: state.now,
      price: 1e-6 * (0.5 + rand()), liquidityUsd: 2_000 + rand() * 60_000,
      mintAuthority: rand() < 0.2 ? Keypair.generate().publicKey.toBase58() : null,
      rugAt: state.now + (3 + rand() * 20) * 60_000, peakAt: state.now + (2 + rand() * 10) * 60_000,
      history: [], buys5m: 0, sells5m: 0, dead: false
    });
  }
  function stepPrices(dtMs) {
    while (state.now >= state.nextLaunch) { launch(); state.nextLaunch += launchEveryMs * (0.5 + rand()); }
    const dtMin = dtMs / 60_000;
    for (const t of state.tokens.values()) {
      if (t.dead) continue;
      let drift = 0;
      const vol = 0.08;
      if (t.kind === 'pump') drift = state.now < t.peakAt ? 0.06 : -0.05;
      if (t.kind === 'moon') drift = state.now < t.peakAt + 10 * 60_000 ? 0.07 : -0.03;
      if (t.kind === 'dud') drift = -0.02;
      if (t.kind === 'rug' && state.now < t.rugAt) drift = 0.04;
      const before = t.price;
      t.price *= Math.exp(drift * dtMin + vol * Math.sqrt(dtMin) * gauss());
      if (t.kind === 'rug' && state.now >= t.rugAt) { t.price *= 0.03; t.liquidityUsd = 50; t.dead = true; }
      const up = t.price >= before;
      t.history.push({ at: state.now, up });
      t.history = t.history.filter(h => state.now - h.at < 5 * 60_000);
      const n = t.history.length;
      const upN = t.history.filter(h => h.up).length;
      t.buys5m = Math.round(upN * 3 + n * 0.5);
      t.sells5m = Math.round((n - upN) * 3 + n * 0.5);
    }
  }
  function pair(t) {
    return {
      chainId: 'solana', dexId: 'raydium', url: `https://sim/${t.symbol}`, pairAddress: `pair_${t.mint}`,
      baseToken: { address: t.mint, symbol: t.symbol }, quoteToken: { address: SOL_MINT, symbol: 'SOL' },
      priceNative: String(t.price), liquidity: { usd: t.liquidityUsd }, txns: { m5: { buys: t.buys5m, sells: t.sells5m } },
      pairCreatedAt: t.createdAt
    };
  }
  const ok = body => ({ ok: true, status: 200, json: async () => body });

  // Quotes include a constant-product price impact so bigger trades get worse fills.
  function quoteOut(t, inputMint, amount) {
    const liqSol = Math.max(t.liquidityUsd / 200 / 2, 0.01);
    if (inputMint === SOL_MINT) {
      const sol = Number(amount) / LAMPORTS_PER_SOL;
      const impact = sol / (liqSol + sol);
      return BigInt(Math.floor(sol / t.price * (1 - impact) * 0.9975 * 10 ** DECIMALS));
    }
    const tokens = Number(amount) / 10 ** DECIMALS;
    const solOut = tokens * t.price;
    const impact = solOut / (liqSol + solOut);
    return BigInt(Math.floor(solOut * (1 - impact) * 0.9975 * LAMPORTS_PER_SOL));
  }

  async function fetchImpl(url, init) {
    const u = new URL(url);
    if (u.host === 'api.geckoterminal.com') {
      const recent = [...state.tokens.values()].filter(t => state.now - t.createdAt < 10 * 60_000);
      const page = Number(u.searchParams.get('page') || 1);
      const slice = recent.sort((a, b) => b.createdAt - a.createdAt).slice((page - 1) * 20, page * 20);
      return ok({ data: slice.map(t => ({
        attributes: { address: `pool_${t.mint}`, name: `${t.symbol} / SOL`, base_token_price_native_currency: String(t.price), reserve_in_usd: String(t.liquidityUsd), pool_created_at: new Date(t.createdAt).toISOString(), transactions: { m5: { buys: t.buys5m, sells: t.sells5m } } },
        relationships: { base_token: { data: { id: `solana_${t.mint}` } }, quote_token: { data: { id: `solana_${SOL_MINT}` } }, dex: { data: { id: 'raydium' } } }
      })) });
    }
    if (u.pathname.startsWith('/price/v3')) {
      const SOL_USD = 150;
      const out = { [SOL_MINT]: { usdPrice: SOL_USD } };
      for (const id of u.searchParams.get('ids').split(',')) { const t = state.tokens.get(id); if (t) out[id] = { usdPrice: t.price * SOL_USD }; }
      return ok(out);
    }
    if (dexScreenerDown && u.host === 'api.dexscreener.com') return { ok: false, status: 429, json: async () => ({}) };
    if (u.pathname.startsWith('/token-profiles') || u.pathname.startsWith('/token-boosts')) return ok([]);
    if (u.pathname.startsWith('/tokens/v1/solana/')) {
      const mints = u.pathname.split('/').pop().split(',');
      return ok(mints.map(m => state.tokens.get(m)).filter(Boolean).map(pair));
    }
    if (u.pathname.endsWith('/quote')) {
      state.stats.quotes++;
      const inputMint = u.searchParams.get('inputMint');
      const outputMint = u.searchParams.get('outputMint');
      const t = state.tokens.get(inputMint === SOL_MINT ? outputMint : inputMint);
      if (!t || t.liquidityUsd < 100) return ok({ error: 'No routes found' });
      const amount = u.searchParams.get('amount');
      return ok({ inputMint, outputMint, inAmount: amount, outAmount: quoteOut(t, inputMint, amount).toString(), slippageBps: Number(u.searchParams.get('slippageBps')) });
    }
    if (u.pathname.endsWith('/swap')) {
      const { quoteResponse, userPublicKey } = JSON.parse(init.body);
      const blockhash = Keypair.generate().publicKey.toBase58();
      const payer = new PublicKey(userPublicKey);
      const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 })] }).compileToV0Message();
      state.pending.set(blockhash, { kind: 'swap', quote: quoteResponse, owner: userPublicKey });
      return ok({ swapTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'), lastValidBlockHeight: 1000 });
    }
    throw new Error(`Simulator has no route for ${url}`);
  }

  function wallet(address) {
    if (!state.wallets.has(address)) state.wallets.set(address, { lamports: 0, tokens: new Map() });
    return state.wallets.get(address);
  }
  function execute(op) {
    const w = wallet(op.owner);
    if (op.kind === 'close') {
      for (const [mint, acct] of w.tokens) if (acct.raw === 0n) { w.tokens.delete(mint); w.lamports += RENT; state.stats.closes++; }
      w.lamports -= TX_FEE;
      return null;
    }
    const q = op.quote;
    const buying = q.inputMint === SOL_MINT;
    const t = state.tokens.get(buying ? q.outputMint : q.inputMint);
    // Re-price at execution: the market may have moved since the quote.
    const out = quoteOut(t, q.inputMint, q.inAmount);
    const minOut = BigInt(q.outAmount) * BigInt(10_000 - q.slippageBps) / 10_000n;
    if (out < minOut) return { InstructionError: [0, { Custom: 6001 }] }; // slippage exceeded
    w.lamports -= TX_FEE + 50_000; // base fee + priority fee
    state.stats.swaps++;
    if (buying) {
      if (w.lamports < Number(q.inAmount) + RENT) return { InsufficientFundsForRent: { account_index: 0 } };
      w.lamports -= Number(q.inAmount);
      if (!w.tokens.has(t.mint)) { w.tokens.set(t.mint, { raw: 0n }); w.lamports -= RENT; }
      w.tokens.get(t.mint).raw += out;
    } else {
      const acct = w.tokens.get(t.mint);
      if (!acct || acct.raw < BigInt(q.inAmount)) return { InstructionError: [0, 'InsufficientFunds'] };
      acct.raw -= BigInt(q.inAmount);
      w.lamports += Number(out);
    }
    return null;
  }

  const connection = {
    async getBalance(pk) { return wallet(pk.toBase58()).lamports; },
    async getParsedAccountInfo(pk) {
      const t = state.tokens.get(pk.toBase58());
      return { value: t ? { data: { parsed: { info: { mintAuthority: t.mintAuthority, freezeAuthority: null, decimals: DECIMALS } } } } : null };
    },
    async getParsedTokenAccountsByOwner(pk, { mint }) {
      const acct = wallet(pk.toBase58()).tokens.get(mint.toBase58());
      if (!acct) return { value: [] };
      return { value: [{ pubkey: Keypair.generate().publicKey, account: { owner: TOKEN_PROGRAM_ID, data: { parsed: { info: { tokenAmount: { amount: acct.raw.toString(), uiAmount: Number(acct.raw) / 10 ** DECIMALS } } } } } }] };
    },
    async getLatestBlockhash() {
      const blockhash = Keypair.generate().publicKey.toBase58();
      state.pending.set(blockhash, { kind: 'close' });
      return { blockhash, lastValidBlockHeight: 1000 };
    },
    async sendRawTransaction(raw) {
      const tx = VersionedTransaction.deserialize(raw);
      const sig = bs58.encode(tx.signatures[0]);
      if (state.sent.has(sig)) return sig; // rebroadcast
      if (tx.signatures[0].every(b => b === 0)) throw new Error('Transaction is not signed');
      const op = state.pending.get(tx.message.recentBlockhash);
      if (!op) throw new Error('Blockhash not found');
      state.pending.delete(tx.message.recentBlockhash);
      const owner = tx.message.staticAccountKeys[0].toBase58();
      state.sent.set(sig, { err: execute({ ...op, owner }) });
      return sig;
    },
    async getSignatureStatuses([sig]) {
      const s = state.sent.get(sig);
      return { value: [s ? { err: s.err, confirmationStatus: 'confirmed' } : null] };
    },
    async getBlockHeight() { return 1; }
  };

  return {
    state, fetchImpl, connection, stepPrices,
    clock: () => state.now,
    advance(ms) { state.now += ms; stepPrices(ms); },
    fund(address, sol) { wallet(address).lamports += Math.round(sol * LAMPORTS_PER_SOL); },
    walletSol(address) { return wallet(address).lamports / LAMPORTS_PER_SOL; },
    tokenAccounts(address) { return wallet(address).tokens.size; }
  };
}
