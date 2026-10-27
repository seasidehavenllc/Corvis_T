import express from 'express';
import { calculateDevFeeLamports } from './policy.js';
import { createEngine, STRATEGY_DEFAULTS, tradeJournal } from './engine.js';
import { deriveBotKeypair as deriveFromKey, scanDerivedWallets } from './wallets.js';
import { runSelfTest } from './selftest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress,
  createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction
} from '@solana/spl-token';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(input) {
  let value = 0n;
  for (const char of input) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new Error('Invalid base58 secret key.');
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;
  return Uint8Array.from([...Array(zeros).fill(0), ...bytes]);
}
function encodeBase58(bytes) {
  let value = 0n;
  for (const b of bytes) value = value * 256n + BigInt(b);
  let out = '';
  while (value > 0n) { out = BASE58[Number(value % 58n)] + out; value /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
function parseSecretKey(value) {
  if (!value) throw new Error('Secret key is not configured.');
  const trimmed = value.trim();
  const bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed)) : decodeBase58(trimmed);
  return Keypair.fromSecretKey(bytes);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const network = process.env.SOLANA_NETWORK || 'devnet';
const rpcUrl = process.env.SOLANA_RPC_URL || (network === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const connection = new Connection(rpcUrl, 'confirmed');
// Token discovery and safety checks always read mainnet, so paper bots see real markets even on devnet.
const marketConnection = network === 'mainnet-beta' ? connection : new Connection(process.env.MARKET_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'corvis.json');
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || '';
const DEV_WALLET_ADDRESS = process.env.DEV_WALLET_ADDRESS || '8ooeEAN637seumjXGMed7KXGv9fQBDoniDgtEBsYpbku';
const DEV_FEE_PERCENT = Number(process.env.DEV_FEE_PERCENT || 10);
const DEV_FEE_ENABLED = process.env.ENABLE_DEV_FEE_TRANSFERS === 'true';
const LIVE_SWEEP_ENABLED = process.env.ENABLE_LIVE_SWEEP === 'true';
// Jupiter routes only exist on mainnet, so live trading is impossible on any other cluster.
const LIVE_TRADING_ENABLED = process.env.ENABLE_LIVE_TRADING === 'true' && network === 'mainnet-beta';
const events = [];
let db = { bots: [], trades: [], positions: [], withdrawals: [], devFees: [], sweeps: [] };

const smallJson = express.json({ limit: '32kb' });
app.use((req, res, next) => req.path === '/api/restore' ? next() : smallJson(req, res, next));
app.use(express.static(path.join(__dirname, 'public')));
function log(level, message) {
  events.unshift({ at: new Date().toISOString(), level, message });
  if (events.length > 100) events.pop();
  console.log(`[${level}] ${message}`);
}
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Set ADMIN_API_TOKEN in deployment environment before using wallet-changing endpoints.' });
  const given = Buffer.from(req.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${ADMIN_TOKEN}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return res.status(401).json({ error: 'Admin token missing or invalid.' });
  next();
}
function encryptionKey() {
  if (!/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) throw new Error('WALLET_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  return Buffer.from(ENCRYPTION_KEY, 'hex');
}
function decryptSecret(record) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]);
}
async function saveDb() {
  await mkdir(DB_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}
async function loadDb() {
  try {
    const loaded = JSON.parse(await readFile(DB_FILE, 'utf8'));
    db = { bots: [], trades: [], positions: [], withdrawals: [], devFees: [], sweeps: [], ...loaded };
    db.bots = db.bots.map(b => ({ ...STRATEGY_DEFAULTS, ...b }));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await saveDb();
  }
}
function publicBot(bot) {
  const { encryptedSecret, ...safe } = bot;
  return safe;
}
// New bot wallets are derived from WALLET_ENCRYPTION_KEY, so they can be rebuilt even if the database is lost.
function deriveBotKeypair(index) { return deriveFromKey(encryptionKey(), index); }
function botKeypair(bot) {
  if (Number.isInteger(bot.walletIndex)) return deriveBotKeypair(bot.walletIndex);
  return Keypair.fromSecretKey(Uint8Array.from(decryptSecret(bot.encryptedSecret)));
}
function nextWalletIndex() {
  const used = db.bots.filter(b => Number.isInteger(b.walletIndex)).map(b => b.walletIndex + 1);
  return Math.max(db.nextWalletIndex || 0, 0, ...used);
}
function newBotRecord(settings, walletIndex) {
  const kp = deriveBotKeypair(walletIndex);
  return {
    id: randomUUID(), venue: 'Solana · Jupiter', walletIndex, walletAddress: kp.publicKey.toBase58(),
    ...STRATEGY_DEFAULTS, ...settings, enabled: false, createdAt: new Date().toISOString(),
    stats: { trades: 0, wins: 0, losses: 0, realizedPnlSol: 0, feesSol: 0 }, status: 'Paused'
  };
}
// Rebuild bots for derived wallets that have on-chain history but are missing from the database
// (for example after Render's free plan restarts with an empty disk). Checks 25 wallets per RPC call and stops at the first empty batch.
let recovery = { done: false, recovered: 0, error: null };
async function recoverWallets() {
  if (!/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) { recovery = { done: true, recovered: 0, error: null }; return; }
  try {
    const knownIndexes = new Set(db.bots.filter(b => Number.isInteger(b.walletIndex)).map(b => b.walletIndex));
    const { found, nextIndex } = await scanDerivedWallets({ connection, keyBytes: encryptionKey(), knownIndexes, heldTokens: heldTokenAccounts });
    db.nextWalletIndex = Math.max(db.nextWalletIndex || 0, nextIndex);
    for (const w of found) {
      if (db.bots.some(b => b.walletIndex === w.index)) continue;
      const bot = newBotRecord({ name: `Recovered wallet #${w.index + 1}` }, w.index);
      bot.status = w.tokens ? `Paused · recovered, holds ${w.tokens} token(s)` : 'Paused · recovered';
      db.bots.push(bot);
      recovery.recovered++;
      log('warn', `Recovered ${bot.name} (${w.lamports / LAMPORTS_PER_SOL} SOL, ${w.tokens} token account(s)). Its trade history was not saved.`);
    }
    // SEED_PAPER_BOT=true starts a paper bot on an empty install, useful for watching the engine on real markets.
    if (process.env.SEED_PAPER_BOT === 'true' && !db.bots.length) {
      const bot = newBotRecord({ name: 'Paper sniper', mode: 'paper' }, nextWalletIndex());
      db.nextWalletIndex = bot.walletIndex + 1;
      Object.assign(bot, { enabled: true, status: 'Running · paper' });
      db.bots.push(bot);
      log('info', 'Started a paper bot (SEED_PAPER_BOT).');
    }
    await saveDb();
    recovery.done = true;
  } catch (e) {
    recovery.error = e.message;
    log('error', `Wallet recovery scan failed, retrying in 60s: ${e.message}`);
    setTimeout(recoverWallets, 60_000);
  }
}
function requirePublicKey(value, label = 'address') {
  try { return new PublicKey(value); } catch { throw new Error(`Invalid Solana ${label}.`); }
}
function getDevWallet() { return requirePublicKey(DEV_WALLET_ADDRESS, 'dev wallet address'); }
// Solana refuses transfers that would leave either wallet holding SOL but less than the rent-exempt
// minimum (about 0.00089 SOL), so those are rejected here with a clear message instead.
const RENT_EXEMPT_LAMPORTS = 890_880;
const TRANSFER_PRIORITY_MICROLAMPORTS = 200_000; // ~0.0000001 SOL extra so transfers land when the network is busy
async function transferSol(from, to, lamports, feeReserve = 10000) {
  const balance = await connection.getBalance(from.publicKey, 'confirmed');
  let amount = Math.min(lamports, balance - feeReserve);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const left = balance - feeReserve - amount;
  if (left > 0 && left < RENT_EXEMPT_LAMPORTS) {
    if (lamports >= Number.MAX_SAFE_INTEGER) amount = balance - feeReserve;
    else throw new Error(`That would leave ${(left / LAMPORTS_PER_SOL).toFixed(6)} SOL behind, below Solana's 0.00089 SOL minimum. Send a little less, or use Withdraw all.`);
  }
  const destinationBalance = await connection.getBalance(to, 'confirmed');
  if (destinationBalance === 0 && amount < RENT_EXEMPT_LAMPORTS) throw new Error('The destination wallet is empty, so Solana needs at least 0.00089 SOL to open it. Send more.');
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: TRANSFER_PRIORITY_MICROLAMPORTS }))
    .add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: amount }));
  const signature = await sendAndConfirmTransaction(connection, tx, [from], { commitment: 'confirmed', maxRetries: 5 });
  return { signature, lamports: amount, amountSol: amount / LAMPORTS_PER_SOL };
}
async function sweepSplTokens(owner, destination) {
  const moved = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const response = await connection.getParsedTokenAccountsByOwner(owner.publicKey, { programId }, 'confirmed');
    for (const item of response.value) {
      const parsed = item.account.data.parsed?.info;
      const amount = parsed?.tokenAmount?.amount;
      const mintText = parsed?.mint;
      if (!mintText || !amount || BigInt(amount) <= 0n) continue;
      const mint = new PublicKey(mintText);
      const sourceAta = item.pubkey;
      const destinationAta = await getAssociatedTokenAddress(mint, destination, false, programId);
      const destinationInfo = await connection.getAccountInfo(destinationAta, 'confirmed');
      // Create destination token account via idempotent ATA instruction when needed.
      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, destinationAta, destination, mint, programId));
      tx.add(createTransferInstruction(sourceAta, destinationAta, owner.publicKey, BigInt(amount), [], programId));
      const sig = await sendAndConfirmTransaction(connection, tx, [owner], { commitment: 'confirmed' });
      moved.push({ mint: mint.toBase58(), rawAmount: amount, signature: sig, destinationAccountExisted: Boolean(destinationInfo) });
    }
  }
  return moved;
}

async function solBalances(addresses) {
  const result = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map(a => new PublicKey(a)), 'confirmed');
    chunk.forEach((a, j) => result.set(a, (infos[j]?.lamports || 0) / LAMPORTS_PER_SOL));
  }
  return result;
}
async function heldTokenAccounts(owner) {
  let count = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const response = await connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed');
    count += response.value.filter(item => BigInt(item.account.data.parsed?.info?.tokenAmount?.amount || '0') > 0n).length;
  }
  return count;
}
function botPerformance(botId) {
  const trades = db.trades.filter(t => t.botId === botId);
  let running = 0;
  const series = trades.map(t => (running += t.pnlSol));
  const wins = trades.filter(t => t.pnlSol > 0).length;
  const pnls = trades.map(t => t.pnlSol);
  return {
    trades: trades.length, wins, losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : null,
    realizedPnlSol: running, avgPnlSol: trades.length ? running / trades.length : null,
    bestSol: pnls.length ? Math.max(...pnls) : null, worstSol: pnls.length ? Math.min(...pnls) : null,
    avgHoldMinutes: trades.length ? trades.reduce((s, t) => s + (Date.parse(t.closedAt) - Date.parse(t.openedAt)), 0) / trades.length / 60000 : null,
    series: series.slice(-60)
  };
}
function validateBotSettings(body, current = {}) {
  const name = String(body?.name ?? current.name ?? '').trim().slice(0, 40);
  const takeProfitMultiplier = Number(body?.takeProfitMultiplier ?? current.takeProfitMultiplier ?? 1.45);
  const stopLossPercent = Number(body?.stopLossPercent ?? current.stopLossPercent ?? 15);
  const maxPositionSol = Number(body?.maxPositionSol ?? current.maxPositionSol ?? 0.05);
  if (!name) return { error: 'Bot name is required.' };
  if (!(takeProfitMultiplier > 1 && takeProfitMultiplier <= 10)) return { error: 'Sell-all profit target must be above 0% and at most 900%.' };
  if (!(stopLossPercent > 0 && stopLossPercent <= 100)) return { error: 'Stop loss must be between 0 and 100%.' };
  if (!(maxPositionSol > 0 && maxPositionSol <= 10)) return { error: 'Max position must be greater than 0 and at most 10 SOL.' };
  const pick = key => Number(body?.[key] ?? current[key] ?? STRATEGY_DEFAULTS[key]);
  const mode = String(body?.mode ?? current.mode ?? 'paper');
  if (!['paper', 'live'].includes(mode)) return { error: 'Mode must be paper or live.' };
  const strategy = {
    minLiquidityUsd: pick('minLiquidityUsd'), maxPairAgeMinutes: pick('maxPairAgeMinutes'), minBuys5m: pick('minBuys5m'),
    maxOpenPositions: pick('maxOpenPositions'), maxHoldMinutes: pick('maxHoldMinutes'), slippageBps: pick('slippageBps'),
    maxDailyLossSol: pick('maxDailyLossSol'), minBuySellRatio: pick('minBuySellRatio'),
    trailingStopPercent: pick('trailingStopPercent'), priorityFeeSol: pick('priorityFeeSol'), maxPriceImpactPct: pick('maxPriceImpactPct'),
    maxRoundTripPct: pick('maxRoundTripPct'), minHolders: pick('minHolders'), maxTopHoldersPct: pick('maxTopHoldersPct'),
    maxDevHoldingPct: pick('maxDevHoldingPct'), maxDevLaunches: pick('maxDevLaunches'), minOrganicScore: pick('minOrganicScore'),
    minPairAgeMinutes: pick('minPairAgeMinutes'), partialTakeProfitMultiplier: pick('partialTakeProfitMultiplier'), partialSellPercent: pick('partialSellPercent')
  };
  for (const [k, label] of [['maxDevHoldingPct', 'Dev holding limit'], ['minOrganicScore', 'Minimum organic score'], ['partialSellPercent', 'Partial sell']]) {
    if (!(strategy[k] >= 0 && strategy[k] <= 100)) return { error: `${label} must be 0 (off) to 100.` };
  }
  if (!(Number.isInteger(strategy.maxDevLaunches) && strategy.maxDevLaunches >= 0)) return { error: 'Dev launches limit must be a whole number, 0 (off) or more.' };
  if (!(strategy.minPairAgeMinutes >= 0 && strategy.minPairAgeMinutes < strategy.maxPairAgeMinutes)) return { error: 'Minimum pair age must be 0 or more and below the maximum age.' };
  if (strategy.partialSellPercent > 0 && !(strategy.partialTakeProfitMultiplier > 1 && strategy.partialTakeProfitMultiplier < takeProfitMultiplier)) return { error: 'The first target must be above 0% and below the sell-all target.' };
  if (!(strategy.maxRoundTripPct >= 0 && strategy.maxRoundTripPct <= 100)) return { error: 'Max round-trip cost must be 0 (off) to 100%.' };
  if (!(Number.isInteger(strategy.minHolders) && strategy.minHolders >= 0)) return { error: 'Minimum holders must be a whole number, 0 or more.' };
  if (!(strategy.maxTopHoldersPct >= 0 && strategy.maxTopHoldersPct <= 100)) return { error: 'Top holders limit must be 0 (off) to 100%.' };
  if (!(strategy.maxPriceImpactPct >= 0 && strategy.maxPriceImpactPct <= 100)) return { error: 'Max price impact must be 0 (off) to 100%.' };
  if (!(strategy.minBuySellRatio >= 0 && strategy.minBuySellRatio <= 20)) return { error: 'Buy/sell ratio must be between 0 and 20.' };
  if (!(strategy.trailingStopPercent >= 0 && strategy.trailingStopPercent < 100)) return { error: 'Trailing stop must be 0 (off) to 99%.' };
  if (!(strategy.priorityFeeSol >= 0 && strategy.priorityFeeSol <= 0.01)) return { error: 'Priority fee must be between 0 and 0.01 SOL.' };
  if (!(strategy.minLiquidityUsd >= 0)) return { error: 'Minimum liquidity must be 0 or more.' };
  if (!(strategy.maxPairAgeMinutes > 0 && strategy.maxPairAgeMinutes <= 10080)) return { error: 'Max pair age must be between 1 minute and 7 days.' };
  if (!(strategy.minBuys5m >= 0)) return { error: 'Minimum buys must be 0 or more.' };
  if (!(Number.isInteger(strategy.maxOpenPositions) && strategy.maxOpenPositions >= 1 && strategy.maxOpenPositions <= 20)) return { error: 'Max open positions must be a whole number from 1 to 20.' };
  if (!(strategy.maxHoldMinutes > 0 && strategy.maxHoldMinutes <= 10080)) return { error: 'Max hold time must be between 1 minute and 7 days.' };
  if (!(Number.isInteger(strategy.slippageBps) && strategy.slippageBps >= 10 && strategy.slippageBps <= 5000)) return { error: 'Slippage must be 10 to 5000 bps.' };
  if (!(strategy.maxDailyLossSol > 0)) return { error: 'Daily loss limit must be greater than 0.' };
  return { name, takeProfitMultiplier, stopLossPercent, maxPositionSol, mode, ...strategy };
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => {
  let address = DEV_WALLET_ADDRESS;
  let valid = false;
  try { address = getDevWallet().toBase58(); valid = true; } catch {}
  res.json({
    network, devWalletAddress: address, devWalletAddressValid: valid,
    devFeePercent: DEV_FEE_PERCENT, devFeeBasis: 'positive_realized_profit_only',
    devFeeTransfersEnabled: DEV_FEE_ENABLED, liveSweepEnabled: LIVE_SWEEP_ENABLED,
    liveTradingEnabled: LIVE_TRADING_ENABLED,
    setup: { adminTokenSet: Boolean(ADMIN_TOKEN), encryptionKeyValid: /^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY), persistentDataDir: Boolean(process.env.DATA_DIR), recovery },
    note: 'Transfer destination is the configured dev wallet, not the treasury wallet.'
  });
});
app.get('/api/status', (_req, res) => res.json({
  app: 'Corvis Trading', liveTradingEnabled: LIVE_TRADING_ENABLED,
  uptimeSeconds: Math.floor(process.uptime()), botCount: db.bots.length, engine: engine.health
}));
app.get('/api/auth/check', requireAdmin, (_req, res) => res.json({ ok: true }));
app.get('/api/bots', (_req, res) => res.json(db.bots.map(publicBot)));
app.get('/api/overview', async (_req, res) => {
  const bots = db.bots.map(publicBot);
  let balances = new Map(); let rpcError = null;
  try { balances = await solBalances(bots.map(b => b.walletAddress)); } catch (e) { rpcError = `Unable to query Solana RPC: ${e.message}`; }
  const withBalances = bots.map(b => ({ ...b, balanceSol: balances.has(b.walletAddress) ? balances.get(b.walletAddress) : null, perf: botPerformance(b.id), openPositions: db.positions.filter(p => p.botId === b.id).length }));
  const totals = withBalances.reduce((t, b) => ({
    balanceSol: t.balanceSol + (b.balanceSol || 0),
    realizedPnlSol: t.realizedPnlSol + (b.stats?.realizedPnlSol || 0),
    trades: t.trades + (b.stats?.trades || 0),
    wins: t.wins + (b.stats?.wins || 0),
    feesSol: t.feesSol + (b.stats?.feesSol || 0)
  }), { balanceSol: 0, realizedPnlSol: 0, trades: 0, wins: 0, feesSol: 0 });
  const positions = db.positions.map(p => ({ ...p, tokenRaw: undefined, multiple: engine.estimateMultiple(p), botName: db.bots.find(b => b.id === p.botId)?.name }));
  const recentTrades = db.trades.slice(-50).reverse().map(t => ({ ...t, botName: db.bots.find(b => b.id === t.botId)?.name }));
  res.json({ network, liveTradingEnabled: LIVE_TRADING_ENABLED, bots: withBalances, totals, positions, rpcError, recentTrades, engine: engine.health });
});
app.post('/api/bots', requireAdmin, async (req, res) => {
  try {
    const settings = validateBotSettings(req.body);
    if (settings.error) return res.status(400).json(settings);
    if (!recovery.done) return res.status(503).json({ error: 'Still checking the blockchain for your existing bot wallets. Try again in a few seconds.' });
    const walletIndex = nextWalletIndex();
    const bot = newBotRecord(settings, walletIndex);
    db.nextWalletIndex = walletIndex + 1;
    db.bots.push(bot); await saveDb(); log('info', `${bot.name} created with its own recoverable Solana wallet.`);
    res.status(201).json(publicBot(bot));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/bots/:id/stats', async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  try {
    const balanceSol = await connection.getBalance(new PublicKey(bot.walletAddress), 'confirmed').then(l => l / LAMPORTS_PER_SOL, () => null);
    const trades = db.trades.filter(t => t.botId === bot.id);
    res.json({ bot: publicBot(bot), balanceSol, stats: bot.stats, perf: botPerformance(bot.id), trades: trades.slice(-100).reverse(), positions: db.positions.filter(p => p.botId === bot.id).map(p => ({ ...p, tokenRaw: undefined, multiple: engine.estimateMultiple(p) })), tradingMode: bot.mode });
  } catch (e) { res.status(502).json({ error: `Unable to query Solana RPC: ${e.message}` }); }
});
app.patch('/api/bots/:id', requireAdmin, async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  const settings = validateBotSettings(req.body, bot);
  if (settings.error) return res.status(400).json(settings);
  const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : bot.enabled;
  if (enabled && settings.mode === 'live' && !LIVE_TRADING_ENABLED) return res.status(409).json({ error: 'Live trading is off on this server. It needs SOLANA_NETWORK=mainnet-beta and ENABLE_LIVE_TRADING=true in Render.' });
  if (enabled && settings.mode === 'live' && !(await connection.getBalance(new PublicKey(bot.walletAddress), 'confirmed').catch(() => 0) > settings.maxPositionSol * LAMPORTS_PER_SOL)) return res.status(409).json({ error: `Fund the bot wallet with more than ${settings.maxPositionSol} SOL before starting it live.` });
  Object.assign(bot, settings, { enabled, status: enabled ? `Running · ${settings.mode}` : 'Paused' });
  await saveDb(); log('info', `${bot.name} ${typeof req.body?.enabled === 'boolean' ? (enabled ? `started (${bot.mode})` : 'paused') : 'settings updated'}.`);
  res.json(publicBot(bot));
});
app.post('/api/bots/:id/positions/:pid/close', requireAdmin, async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  const position = db.positions.find(p => p.id === req.params.pid && p.botId === req.params.id);
  if (!bot || !position) return res.status(404).json({ error: 'Position not found.' });
  try { const trade = await engine.closePosition(bot, position, 'manual'); await saveDb(); res.json({ ok: true, trade }); }
  catch (e) { res.status(502).json({ error: `Sell failed: ${e.message}` }); }
});
// Pause the bot and sell every open position now.
app.post('/api/bots/:id/sell-all', requireAdmin, async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  Object.assign(bot, { enabled: false, status: 'Paused' });
  await saveDb(); log('info', `${bot.name} paused; selling all open positions.`);
  const results = await Promise.allSettled(db.positions.filter(p => p.botId === bot.id).map(p => engine.closePosition(bot, p, 'manual')));
  await saveDb();
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
  res.json({ ok: !failed.length, sold: results.length - failed.length, failed });
});
app.post('/api/bots/:id/withdraw', requireAdmin, async (req, res) => {
  try {
    const bot = db.bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
    if (bot.enabled) return res.status(409).json({ error: 'Pause the bot before withdrawing.' });
    const to = requirePublicKey(String(req.body?.to || ''), 'destination address');
    const all = req.body?.all === true;
    const amountSol = Number(req.body?.amountSol);
    if (!all && !(Number.isFinite(amountSol) && amountSol > 0)) return res.status(400).json({ error: 'Enter a SOL amount or choose withdraw all.' });
    if (to.equals(botKeypair(bot).publicKey)) return res.status(400).json({ error: 'That is the bot\'s own wallet. Enter your own wallet address.' });
    const transfer = await transferSol(botKeypair(bot), to, all ? Number.MAX_SAFE_INTEGER : Math.floor(amountSol * LAMPORTS_PER_SOL), 5_200);
    if (!transfer) return res.status(400).json({ error: 'Bot wallet balance is too low to cover the amount and network fee.' });
    db.withdrawals.push({ at: new Date().toISOString(), from: bot.walletAddress, botId: bot.id, to: to.toBase58(), amountSol: transfer.amountSol, signature: transfer.signature });
    await saveDb(); log('info', `${transfer.amountSol} SOL withdrawn from ${bot.name}.`);
    res.json({ ok: true, ...transfer, explorerUrl: `https://explorer.solana.com/tx/${transfer.signature}?cluster=${network}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/bots/:id/export-key', requireAdmin, (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
  log('warn', `Private key exported for ${bot.name}.`);
  res.json({ walletAddress: bot.walletAddress, secretKeyBase58: encodeBase58(botKeypair(bot).secretKey) });
});
app.post('/api/bots/:id/realized-profit-fee', requireAdmin, async (req, res) => {
  try {
    const bot = db.bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
    if (!DEV_FEE_ENABLED) return res.status(403).json({ error: 'Dev profit-fee transfers are disabled. Test on devnet before enabling.' });
    const settlementId = String(req.body?.settlementId || '').trim().slice(0, 100);
    if (!settlementId) return res.status(400).json({ error: 'settlementId is required so the same profit is never charged twice.' });
    if (db.devFees.some(f => f.botId === bot.id && f.settlementId === settlementId)) return res.status(409).json({ error: 'A fee for this settlementId was already transferred.' });
    const profitSol = Number(req.body?.realizedProfitSol);
    if (!Number.isFinite(profitSol) || profitSol <= 0) return res.status(400).json({ error: 'Only a positive realizedProfitSol can incur the profit fee.' });
    const amountLamports = calculateDevFeeLamports(profitSol, DEV_FEE_PERCENT);
    if (amountLamports <= 0) return res.status(400).json({ error: 'Calculated fee is below one lamport.' });
    const owner = botKeypair(bot);
    const destination = getDevWallet();
    const balance = await connection.getBalance(owner.publicKey, 'confirmed');
    if (balance < amountLamports + 10000) return res.status(400).json({ error: 'Bot wallet does not have enough SOL to cover fee and network reserve.' });
    const transfer = await transferSol(owner, destination, amountLamports, 10000);
    if (!transfer) return res.status(400).json({ error: 'Unable to transfer calculated fee.' });
    const record = { id: randomUUID(), botId: bot.id, settlementId, at: new Date().toISOString(), basis: 'positive_realized_profit_only', realizedProfitSol: profitSol, percent: DEV_FEE_PERCENT, feeSol: transfer.amountSol, destination: destination.toBase58(), signature: transfer.signature };
    db.devFees.push(record);
    bot.stats.feesSol = (bot.stats.feesSol || 0) + transfer.amountSol;
    await saveDb();
    log('info', `Profit fee confirmed for ${bot.name}: ${transfer.amountSol} SOL to configured dev wallet.`);
    res.json({ ok: true, ...record, explorerUrl: `https://explorer.solana.com/tx/${transfer.signature}?cluster=${network}` });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/bots/:id/sweep', requireAdmin, async (req, res) => {
  try {
    const bot = db.bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
    if (bot.enabled) return res.status(409).json({ error: 'Pause the bot before sweeping.' });
    if (db.positions.some(p => p.botId === bot.id)) return res.status(409).json({ error: 'Close the bot\'s open positions first.' });
    if (!LIVE_SWEEP_ENABLED) return res.status(403).json({ error: 'Live sweep is disabled. Verify on devnet before enabling.' });
    const owner = botKeypair(bot);
    const destination = getDevWallet();
    const tokenTransfers = await sweepSplTokens(owner, destination);
    const solTransfer = await transferSol(owner, destination, Number.MAX_SAFE_INTEGER, 10000);
    const record = { id: randomUUID(), botId: bot.id, at: new Date().toISOString(), destination: destination.toBase58(), sol: solTransfer, tokens: tokenTransfers };
    db.sweeps.push(record); await saveDb();
    log('info', `Explicit sweep completed for ${bot.name} to configured dev wallet.`);
    res.json({ ok: true, ...record });
  } catch (e) { res.status(502).json({ error: `Sweep did not complete fully: ${e.message}` }); }
});
app.delete('/api/bots/:id', requireAdmin, async (req, res) => {
  const i = db.bots.findIndex(b => b.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Bot not found.' });
  if (db.bots[i].enabled) return res.status(409).json({ error: 'Pause the bot before deleting it.' });
  if (db.positions.some(p => p.botId === db.bots[i].id)) return res.status(409).json({ error: 'Close the bot\'s open positions before deleting it.' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required: { "confirm": true }.' });
  // Deleting the record destroys the only copy of the wallet key, so refuse while the wallet still holds anything.
  try {
    const owner = new PublicKey(db.bots[i].walletAddress);
    const lamports = await connection.getBalance(owner, 'confirmed');
    const tokens = await heldTokenAccounts(owner);
    if (lamports > 0 || tokens > 0) return res.status(409).json({ error: `Bot wallet still holds ${lamports / LAMPORTS_PER_SOL} SOL and ${tokens} token account(s). Empty it before deleting, or the funds become unrecoverable.` });
  } catch (e) { return res.status(502).json({ error: `Unable to verify the wallet is empty: ${e.message}` }); }
  const [bot] = db.bots.splice(i, 1);
  await saveDb();
  log('info', `${bot.name} deleted. No funds were swept automatically; use the explicit sweep endpoint first.`);
  res.json({ ok: true });
});
app.get('/api/wallet', async (_req, res) => {
  try {
    const treasury = parseSecretKey(process.env.TREASURY_SECRET_KEY || '');
    const balanceSol = await connection.getBalance(treasury.publicKey, 'confirmed') / LAMPORTS_PER_SOL;
    res.json({ address: treasury.publicKey.toBase58(), balanceSol, network, configured: true, withdrawalsEnabled: Boolean(ADMIN_TOKEN) });
  } catch (e) {
    res.json({ address: '', balanceSol: null, configured: false, error: e.message, network });
  }
});
app.post('/api/wallet/withdraw', requireAdmin, async (req, res) => {
  try {
    const to = requirePublicKey(String(req.body?.to || ''), 'destination address');
    const amountSol = Number(req.body?.amountSol);
    if (!Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 1000) return res.status(400).json({ error: 'Enter a valid SOL amount greater than zero.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
    const treasury = parseSecretKey(process.env.TREASURY_SECRET_KEY || '');
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const balance = await connection.getBalance(treasury.publicKey, 'confirmed');
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: treasury.publicKey, recentBlockhash: blockhash })
      .add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports }));
    const feeInfo = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
    if (balance < lamports + (feeInfo.value || 10000)) return res.status(400).json({ error: 'Treasury balance too low to cover amount and network fee.' });
    const signature = await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
    db.withdrawals.push({ at: new Date().toISOString(), to: to.toBase58(), amountSol, signature });
    await saveDb(); log('info', `Treasury withdrawal confirmed: ${signature}`);
    res.json({ ok: true, signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${network}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
let lastSelfTest = null;
async function selfTest() {
  let walletAddress = db.bots[0]?.walletAddress;
  if (!walletAddress) try { walletAddress = deriveBotKeypair(0).publicKey.toBase58(); } catch {}
  lastSelfTest = await runSelfTest({ connection, marketConnection, walletAddress });
  for (const s of lastSelfTest.steps) console.log(`SELFTEST ${s.ok ? 'PASS' : 'FAIL'} ${s.name} (${s.ms} ms): ${s.detail}`);
  log(lastSelfTest.ok ? 'info' : 'warn', `System check ${lastSelfTest.ok ? 'passed' : 'found problems'}: ${lastSelfTest.steps.filter(s => s.ok).length}/${lastSelfTest.steps.length} checks OK.`);
  return lastSelfTest;
}
app.get('/api/selftest', (_req, res) => res.json(lastSelfTest || { steps: [] }));
app.post('/api/selftest', requireAdmin, async (_req, res) => {
  try { res.json(await selfTest()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Real 0.01 SOL → USDC → SOL round trip through the same swap code the bots use.
app.post('/api/bots/:id/test-swap', requireAdmin, async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
  if (!LIVE_TRADING_ENABLED) return res.status(409).json({ error: 'Live trading is off on this server, so a real swap can\'t run.' });
  if (bot.enabled) return res.status(409).json({ error: 'Pause the bot first.' });
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  try {
    const owner = botKeypair(bot);
    const before = await connection.getBalance(owner.publicKey, 'confirmed');
    if (before < 0.02 * LAMPORTS_PER_SOL) return res.status(400).json({ error: 'Fund the bot wallet with at least 0.02 SOL first.' });
    const t0 = Date.now();
    const buy = await engine.jupiterSwap(owner, 'So11111111111111111111111111111111111111112', USDC, 10_000_000, { ...bot, slippageBps: 100 });
    const buyMs = Date.now() - t0;
    const accounts = await connection.getParsedTokenAccountsByOwner(owner.publicKey, { mint: new PublicKey(USDC) }, 'confirmed');
    const raw = accounts.value.reduce((s, a) => s + BigInt(a.account.data.parsed?.info?.tokenAmount?.amount || '0'), 0n);
    const t1 = Date.now();
    const sell = await engine.jupiterSwap(owner, USDC, 'So11111111111111111111111111111111111111112', raw.toString(), { ...bot, slippageBps: 100 });
    const sellMs = Date.now() - t1;
    const after = await connection.getBalance(owner.publicKey, 'confirmed');
    const result = { ok: true, buySignature: buy.signature, sellSignature: sell.signature, buyMs, sellMs, costSol: (before - after) / LAMPORTS_PER_SOL };
    log('info', `${bot.name} live test swap OK: buy ${buyMs} ms, sell ${sellMs} ms, cost ${result.costSol} SOL (fees + USDC account rent, reclaimable).`);
    res.json(result);
  } catch (e) { log('error', `${bot.name} live test swap failed: ${e.message}`); res.status(502).json({ error: e.message }); }
});
app.get('/api/backup', requireAdmin, (_req, res) => {
  res.set('content-disposition', `attachment; filename="corvis-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ format: 'corvis-backup-1', exportedAt: new Date().toISOString(), db });
});
app.post('/api/restore', requireAdmin, express.json({ limit: '20mb' }), async (req, res) => {
  const incoming = req.body?.db;
  if (req.body?.format !== 'corvis-backup-1' || !incoming || !Array.isArray(incoming.bots)) return res.status(400).json({ error: 'That is not a Corvis backup file.' });
  if (db.bots.some(b => b.enabled)) return res.status(409).json({ error: 'Pause all bots before restoring.' });
  const byIndex = new Map(incoming.bots.filter(b => Number.isInteger(b.walletIndex)).map(b => [b.walletIndex, b]));
  // Keep bots recovered since the backup if the backup doesn't know their wallet.
  const extra = db.bots.filter(b => !(Number.isInteger(b.walletIndex) && byIndex.has(b.walletIndex)) && !incoming.bots.some(x => x.id === b.id));
  db = { bots: [], trades: [], positions: [], withdrawals: [], devFees: [], sweeps: [], ...incoming };
  db.bots = [...db.bots, ...extra].map(b => ({ ...STRATEGY_DEFAULTS, ...b, enabled: false, status: 'Paused' }));
  db.nextWalletIndex = Math.max(incoming.nextWalletIndex || 0, nextWalletIndex());
  await saveDb(); log('info', `Backup restored: ${db.bots.length} bots, ${db.trades.length} trades.`);
  res.json({ ok: true, bots: db.bots.length, trades: db.trades.length });
});
app.get('/api/journal', (req, res) => {
  const trades = req.query.bot ? db.trades.filter(t => t.botId === req.query.bot) : db.trades;
  res.json({ trades: trades.filter(t => t.features).length, signals: tradeJournal(trades) });
});
app.get('/api/withdrawals', (_req, res) => res.json(db.withdrawals.slice(-50).reverse()));
app.get('/api/dev-fees', (_req, res) => res.json(db.devFees.slice(-50).reverse()));
app.get('/api/events', (_req, res) => res.json(events));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON.' : (err.message || 'Server error.') }));
const engine = createEngine({
  db: new Proxy({}, { get: (_t, k) => db[k], set: (_t, k, v) => { db[k] = v; return true; } }),
  save: saveDb, log, connection, marketConnection, getKeypair: botKeypair, liveAllowed: LIVE_TRADING_ENABLED,
  monitorMs: Number(process.env.ENGINE_MONITOR_MS || 1000),
  scanMs: Number(process.env.ENGINE_SCAN_MS || (process.env.JUPITER_API_KEY ? 5000 : 6000))
});
await loadDb();
engine.start();
recoverWallets();
if (process.env.SELFTEST_ON_BOOT === 'true') setTimeout(() => selfTest().catch(e => console.log(`SELFTEST crashed: ${e.message}`)), 3000);
if (!/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) log('warn', 'WALLET_ENCRYPTION_KEY is missing or invalid; bot wallets cannot be created.');
if (!ADMIN_TOKEN) log('warn', 'ADMIN_API_TOKEN is not set; all wallet-changing actions are locked.');
if (!process.env.DATA_DIR) log('warn', 'No persistent disk: trade history resets when the server restarts. Bot wallets are recovered automatically; download a backup to keep history.');
app.listen(port, '0.0.0.0', () => {
  log('info', `Corvis backend started on ${network}; live trading ${LIVE_TRADING_ENABLED ? 'ENABLED' : 'off (paper only)'}.`);
  console.log(`Corvis Trading listening on ${port}`);
});
