import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcUrl, 'confirmed');
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'corvis.json');
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || '';
const LIVE_SWEEP = process.env.ENABLE_LIVE_SWEEP === 'true';
const events = [];
let db = { bots: [], trades: [], withdrawals: [] };

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
function log(level, message) { events.unshift({ at: new Date().toISOString(), level, message }); if (events.length > 100) events.pop(); }
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Set ADMIN_API_TOKEN in the deployment environment before using wallet-changing endpoints.' });
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${ADMIN_TOKEN}`) return res.status(401).json({ error: 'Admin token missing or invalid.' });
  next();
}
function encryptionKey() {
  if (!/^[a-f0-9]{64}$/i.test(ENCRYPTION_KEY)) throw new Error('WALLET_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes).');
  return Buffer.from(ENCRYPTION_KEY, 'hex');
}
function encryptSecret(secret) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
}
function decryptSecret(record) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]);
}
async function saveDb() { await mkdir(DB_DIR, { recursive: true }); await writeFile(DB_FILE, JSON.stringify(db, null, 2), { mode: 0o600 }); }
async function loadDb() { try { db = JSON.parse(await readFile(DB_FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; await saveDb(); } }
function publicBot(b) { const { encryptedSecret, ...safe } = b; return { ...safe, encryptedSecret: undefined }; }
function treasuryKeypair() {
  const value = process.env.TREASURY_SECRET_KEY;
  if (!value) throw new Error('TREASURY_SECRET_KEY is not configured.');
  let bytes;
  try { bytes = value.trim().startsWith('[') ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value.trim()); }
  catch { throw new Error('TREASURY_SECRET_KEY must be a base58 Solana secret key or JSON byte array.'); }
  return Keypair.fromSecretKey(bytes);
}
async function balanceSol(address) { return (await connection.getBalance(new PublicKey(address), 'confirmed')) / LAMPORTS_PER_SOL; }
function requirePublicKey(value, label = 'address') { try { return new PublicKey(value); } catch { throw new Error(`Invalid Solana ${label}.`); } }

app.get('/api/status', (_req, res) => res.json({ app: 'Corvis Trading', mode: 'paper', liveTradingEnabled: false, walletFeatures: true, uptimeSeconds: Math.floor(process.uptime()), botCount: db.bots.length, note: 'Wallet and balance features are available when configured; automated live sniping remains disabled until a vetted strategy and execution adapter are enabled.' }));
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
    const bot = { id: randomUUID(), name, venue: String(req.body?.venue || 'Jupiter (adapter pending)').slice(0, 80), walletAddress: kp.publicKey.toBase58(), encryptedSecret: encryptSecret(kp.secretKey), enabled: false, takeProfitMultiplier, stopLossPercent, maxPositionSol, createdAt: new Date().toISOString(), stats: { trades: 0, wins: 0, losses: 0, realizedPnlSol: 0, feesSol: 0 }, status: 'Paused · paper mode' };
    db.bots.push(bot); await saveDb(); log('info', `${name} created with a dedicated Solana wallet.`); res.status(201).json(publicBot(bot));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/bots/:id/stats', async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id); if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  try { const balance = await balanceSol(bot.walletAddress); const trades = db.trades.filter(t => t.botId === bot.id); res.json({ bot: publicBot(bot), balanceSol: balance, stats: bot.stats, trades: trades.slice(-100).reverse(), tradingMode: 'paper', note: 'Realized P&L includes only records created by this app; token valuation and automated trade execution are not implemented.' }); }
  catch (e) { res.status(502).json({ error: `Unable to query Solana RPC: ${e.message}` }); }
});
app.patch('/api/bots/:id', requireAdmin, async (req, res) => {
  const bot = db.bots.find(b => b.id === req.params.id); if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (typeof req.body?.enabled === 'boolean') { bot.enabled = req.body.enabled; bot.status = bot.enabled ? 'Monitoring · paper mode only' : 'Paused · paper mode'; log('info', `${bot.name} ${bot.enabled ? 'started' : 'paused'} in paper mode.`); await saveDb(); }
  res.json(publicBot(bot));
});
app.delete('/api/bots/:id', requireAdmin, async (req, res) => {
  const i = db.bots.findIndex(b => b.id === req.params.id); if (i < 0) return res.status(404).json({ error: 'Bot not found.' });
  const bot = db.bots[i]; if (bot.enabled) return res.status(409).json({ error: 'Pause the bot before deleting it.' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required: {"confirm":true}.' });
  if (req.body?.sweepFunds === true) {
    if (!LIVE_SWEEP) return res.status(403).json({ error: 'Live wallet sweeping is disabled. Set ENABLE_LIVE_SWEEP=true only after testing on devnet.' });
    try { const treasury = treasuryKeypair(); const secret = decryptSecret(bot.encryptedSecret); const owner = Keypair.fromSecretKey(Uint8Array.from(secret)); const lamports = await connection.getBalance(owner.publicKey, 'confirmed'); const feeReserve = 10000; if (lamports <= feeReserve) return res.status(400).json({ error: 'No transferable SOL after fee reserve.' }); const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: treasury.publicKey, lamports: lamports - feeReserve })); const sig = await sendAndConfirmTransaction(connection, tx, [owner], { commitment: 'confirmed' }); log('info', `SOL sweep for ${bot.name} confirmed: ${sig}`); }
    catch (e) { return res.status(502).json({ error: `Sweep failed; bot not deleted: ${e.message}` }); }
  }
  db.bots.splice(i, 1); await saveDb(); log('info', `${bot.name} profile deleted. Any remaining assets stay in its wallet unless a confirmed SOL sweep was requested.`); res.json({ ok: true });
});
app.get('/api/wallet', async (_req, res) => {
  try { const treasury = treasuryKeypair(); const balanceSol = await balanceSolSafe(treasury.publicKey.toBase58()); res.json({ address: treasury.publicKey.toBase58(), balanceSol, network: process.env.SOLANA_NETWORK || 'mainnet-beta', configured: true, withdrawalsEnabled: Boolean(ADMIN_TOKEN) }); }
  catch (e) { res.json({ address: '', balanceSol: null, configured: false, error: e.message, network: process.env.SOLANA_NETWORK || 'mainnet-beta' }); }
});
async function balanceSolSafe(address) { return await balanceSol(address); }
app.post('/api/wallet/withdraw', requireAdmin, async (req, res) => {
  try {
    const to = requirePublicKey(String(req.body?.to || ''), 'destination address');
    const amountSol = Number(req.body?.amountSol);
    if (!Number.isFinite(amountSol) || amountSol <= 0 || amountSol > 1000) return res.status(400).json({ error: 'Enter a valid SOL amount greater than zero.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation required.' });
    const treasury = treasuryKeypair(); const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL); const balance = await connection.getBalance(treasury.publicKey, 'confirmed');
    const fee = await connection.getFeeForMessage(new Transaction({ feePayer: treasury.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports })).compileMessage(), 'confirmed');
    if (balance < lamports + (fee.value || 10000)) return res.status(400).json({ error: 'Treasury balance is too low to cover amount and network fee.' });
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports })); const signature = await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
    db.withdrawals.push({ at: new Date().toISOString(), to: to.toBase58(), amountSol, signature }); await saveDb(); log('info', `Treasury withdrawal confirmed: ${signature}`); res.json({ ok: true, signature, explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${process.env.SOLANA_NETWORK === 'devnet' ? 'devnet' : 'mainnet-beta'}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/withdrawals', (_req, res) => res.json(db.withdrawals.slice(-50).reverse()));
app.get('/api/events', (_req, res) => res.json(events));
app.get('/health', (_req, res) => res.json({ ok: true }));
await loadDb();
app.listen(port, '0.0.0.0', () => { log('info', 'Corvis backend started; automated live trading is disabled.'); console.log(`Corvis Trading listening on ${port}`); });
