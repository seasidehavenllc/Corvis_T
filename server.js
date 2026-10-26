import express from 'express';
import { calculateDevFeeLamports } from './policy.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress,
  createTransferInstruction, getAccount, getMint
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
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'corvis.json');
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || '';
const DEV_WALLET_ADDRESS = process.env.DEV_WALLET_ADDRESS || '8ooeEAN637seumjXGMed7KXGv9fQBDoniDgtEBsYpbku';
const DEV_FEE_PERCENT = Number(process.env.DEV_FEE_PERCENT || 10);
const DEV_FEE_ENABLED = process.env.ENABLE_DEV_FEE_TRANSFERS === 'true';
const LIVE_SWEEP_ENABLED = process.env.ENABLE_LIVE_SWEEP === 'true';
const events = [];
let db = { bots: [], trades: [], withdrawals: [], devFees: [], sweeps: [] };

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
function log(level, message) {
  events.unshift({ at: new Date().toISOString(), level, message });
  if (events.length > 100) events.pop();
}
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Set ADMIN_API_TOKEN in deployment environment before using wallet-changing endpoints.' });
  if ((req.get('authorization') || '') !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Admin token missing or invalid.' });
  next();
}
function encryptionKey() {
  if (!/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) throw new Error('WALLET_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  return Buffer.from(ENCRYPTION_KEY, 'hex');
}
function encryptSecret(secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
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
    db = { bots: [], trades: [], withdrawals: [], devFees: [], sweeps: [], ...loaded };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await saveDb();
  }
}
function publicBot(bot) {
  const { encryptedSecret, ...safe } = bot;
  return safe;
}
function botKeypair(bot) {
  return Keypair.fromSecretKey(Uint8Array.from(decryptSecret(bot.encryptedSecret)));
}
function requirePublicKey(value, label = 'address') {
  try { return new PublicKey(value); } catch { throw new Error(`Invalid Solana ${label}.`); }
}
function getDevWallet() { return requirePublicKey(DEV_WALLET_ADDRESS, 'dev wallet address'); }
async function transferSol(from, to, lamports, feeReserve = 10000) {
  const balance = await connection.getBalance(from.publicKey, 'confirmed');
  const amount = Math.min(lamports, balance - feeReserve);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: amount }));
  const signature = await sendAndConfirmTransaction(connection, tx, [from], { commitment: 'confirmed' });
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
      const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, destinationAta, destination, mint, programId));
      tx.add(createTransferInstruction(sourceAta, destinationAta, owner.publicKey, BigInt(amount), [], programId));
      const sig = await sendAndConfirmTransaction(connection, tx, [owner], { commitment: 'confirmed' });
      moved.push({ mint: mint.toBase58(), rawAmount: amount, signature: sig, destinationAccountExisted: Boolean(destinationInfo) });
    }
  }
  return moved;
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
    liveTradingEnabled: false,
    note: 'Transfer destination is the configured dev wallet, not the treasury wallet. Automated swaps are not implemented.'
  });
});
app.get('/api/status', (_req, res) => res.json({
  app: 'Corvis Trading', mode: 'paper', liveTradingEnabled: false,
  walletFeatures: true, uptimeSeconds: Math.floor(process.uptime()), botCount: db.bots.length,
  note: 'Live swaps/token sniping remain disabled until a vetted execution adapter and risk controls are implemented.'
}));
app.get('/api/bots', (_req, res) => res.json(db.bots.map(publicBot)));
app.post('/api/bots', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 40);
    const takeProfitMultiplier = Number(req.body?.takeProfitMultiplier ?? 1.45);
    const stopLossPercent = Number(req.body?.stopLossPercent ?? 15);
    const maxPositionSol = Number(req.body?.maxPositionSol ?? 0.05);
    if (!name) return res.status(400).json({ error: 'Bot name is required.' });
    if (!(takeProfitMultiplier > 1 && takeProfitMultiplier <= 10)) return res.status(400).json({ error: 'Take profit multiplier must be greater than 1 and at most 10.' });
    if (!(stopLossPercent > 0 && stopLossPercent <= 100)) return res.status(400).json({ error: 'Stop loss must be between 0 and 100%.' });
    if (!(maxPositionSol > 0 && maxPositionSol <= 10)) return res.status(400).json({ error: 'Max position must be greater than 0 and at most 10 SOL.' });
    const kp = Keypair.generate();
    const bot = {
      id: randomUUID(), name, venue: 'Solana wallet (swap adapter not installed)',
      walletAddress: kp.publicKey.toBase58(), encryptedSecret: encryptSecret(kp.secretKey),
      enabled: false, takeProfitMultiplier, stopLossPercent, maxPositionSol,
      createdAt: new Date().toISOString(),
      stats: { trades: 0, wins: 0, losses: 0, realizedPnlSol: 0, feesSol: 0 },
      status: 'Paused · paper mode'
    };
    db.bots.push(bot); await saveDb(); log('info', `${name} created with dedicated encrypted Solana wallet.`);
    res.status(201).json(publicBot(bot));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/bots/:id/stats', async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  try {
    const balanceSol = await connection.getBalance(new PublicKey(bot.walletAddress), 'confirmed') / LAMPORTS_PER_SOL;
    const trades = db.trades.filter(t => t.botId === bot.id);
    res.json({ bot: publicBot(bot), balanceSol, stats: bot.stats, trades: trades.slice(-100).reverse(), tradingMode: 'paper', note: 'No automated trade execution adapter is installed.' });
  } catch (e) { res.status(502).json({ error: `Unable to query Solana RPC: ${e.message}` }); }
});
app.patch('/api/bots/:id', requireAdmin, async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (req.body?.enabled === true) return res.status(409).json({ error: 'Live/paper bot execution is not implemented; bot cannot be started.' });
  if (typeof req.body?.enabled === 'boolean') {
    bot.enabled = false; bot.status = 'Paused · paper mode';
    await saveDb();
  }
  res.json(publicBot(bot));
});
app.post('/api/bots/:id/realized-profit-fee', requireAdmin, async (req, res) => {
  try {
    const bot = db.bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'Bot not found.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
    if (!DEV_FEE_ENABLED) return res.status(403).json({ error: 'Dev profit-fee transfers are disabled. Test on devnet before enabling.' });
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
    const record = { id: randomUUID(), botId: bot.id, at: new Date().toISOString(), basis: 'positive_realized_profit_only', realizedProfitSol: profitSol, percent: DEV_FEE_PERCENT, feeSol: transfer.amountSol, destination: destination.toBase58(), signature: transfer.signature };
    db.devFees.push(record); await saveDb();
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
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required: { "confirm": true }.' });
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
app.get('/api/withdrawals', (_req, res) => res.json(db.withdrawals.slice(-50).reverse()));
app.get('/api/dev-fees', (_req, res) => res.json(db.devFees.slice(-50).reverse()));
app.get('/api/events', (_req, res) => res.json(events));
await loadDb();
app.listen(port, '0.0.0.0', () => {
  log('info', `Corvis backend started on ${network}; automated live trading remains disabled.`);
  console.log(`Corvis Trading listening on ${port}`);
});
