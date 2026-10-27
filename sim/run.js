// Run the engine against the simulated market: `npm run simulate [hours] [seed]`.
import { Keypair } from '@solana/web3.js';
import { createEngine, STRATEGY_DEFAULTS } from '../engine.js';
import { createMarket } from './market.js';

export async function simulate({ hours = 3, seed = 42, quiet = false, dexScreenerDown = false } = {}) {
  const market = createMarket({ seed, dexScreenerDown });
  const keys = new Map();
  const mkBot = (name, mode, extra = {}) => {
    const kp = Keypair.generate();
    keys.set(kp.publicKey.toBase58(), kp);
    return { ...STRATEGY_DEFAULTS, id: name, name, mode, enabled: true, walletAddress: kp.publicKey.toBase58(),
      takeProfitMultiplier: 1.6, stopLossPercent: 20, maxPositionSol: 0.05, ...extra,
      stats: { trades: 0, wins: 0, losses: 0, realizedPnlSol: 0, feesSol: 0 } };
  };
  const db = {
    bots: [mkBot('Paper sniper', 'paper'), mkBot('Live sniper', 'live'), mkBot('Live tight', 'live', { takeProfitMultiplier: 1.3, stopLossPercent: 10, trailingStopPercent: 8, maxHoldMinutes: 10 })],
    trades: [], positions: []
  };
  for (const b of db.bots) if (b.mode === 'live') market.fund(b.walletAddress, 1);
  const startSol = Object.fromEntries(db.bots.map(b => [b.id, b.mode === 'live' ? market.walletSol(b.walletAddress) : b.paperBalanceSol]));
  const events = [];
  const engine = createEngine({
    db, save: async () => {}, log: (level, msg) => events.push({ level, msg }),
    connection: market.connection, getKeypair: b => keys.get(b.walletAddress), liveAllowed: true,
    fetchImpl: market.fetchImpl, clock: market.clock, sleep: async ms => market.advance(ms)
  });

  const steps = Math.floor(hours * 3600 / 2);
  for (let i = 0; i < steps; i++) {
    market.advance(2000);
    await engine.monitor();
    if (i % 3 === 0) await engine.scan();
  }
  // Stop buying and let open positions run out so P&L is fully realized.
  db.bots.forEach(b => { b.enabled = false; });
  for (let i = 0; i < 1200 && db.positions.length; i++) { market.advance(2000); await engine.monitor(); }

  const report = db.bots.map(b => {
    const trades = db.trades.filter(t => t.botId === b.id);
    const pnl = trades.reduce((s, t) => s + t.pnlSol, 0);
    const endSol = b.mode === 'live' ? market.walletSol(b.walletAddress) : b.paperBalanceSol;
    const reasons = {};
    trades.forEach(t => { reasons[t.reason] = (reasons[t.reason] || 0) + 1; });
    return {
      bot: b.name, mode: b.mode, trades: trades.length, wins: trades.filter(t => t.pnlSol > 0).length,
      pnlSol: +pnl.toFixed(4), walletChangeSol: +(endSol - startSol[b.id]).toFixed(4),
      openTokenAccounts: b.mode === 'live' ? market.tokenAccounts(b.walletAddress) : 0, exits: reasons,
      boughtUnsafe: trades.filter(t => market.state.tokens.get(t.mint)?.mintAuthority).length
    };
  });
  const errors = events.filter(e => e.level === 'error').map(e => e.msg);
  const summary = { launched: market.state.tokens.size, swaps: market.state.stats.swaps, rentReclaimed: market.state.stats.closes, openPositions: db.positions.length, errors: errors.length };
  if (!quiet) {
    console.table(report.map(r => ({ ...r, exits: JSON.stringify(r.exits) })));
    console.log(summary);
    if (errors.length) console.log('First errors:', [...new Set(errors)].slice(0, 5));
  }
  return { report, summary, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await simulate({ hours: Number(process.argv[2] || 3), seed: Number(process.argv[3] || 42) });
}
