// The admin token is remembered on this device so a reload doesn't ask for it again. Lock forgets it.
const TOKEN_KEY = 'corvis.adminToken';
const remember = token => { try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch {} };
let adminToken = (() => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } })();
let state = { overview: null, config: null, wallet: null, events: [] };
let editingBotId = null;
let detailBotId = null;
const $ = sel => document.querySelector(sel);

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  // A remembered token that the server no longer accepts (it was changed) is dropped.
  if (response.status === 401 && adminToken) { adminToken = ''; remember(''); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function sol(v, digits = 4) { return v == null || Number.isNaN(v) ? '–' : `${Number(v).toFixed(digits)}`; }
function signed(v, digits = 4) { if (v == null) return '–'; const cls = v > 0 ? 'up' : v < 0 ? 'down' : ''; return `<span class="${cls}">${v > 0 ? '+' : ''}${Number(v).toFixed(digits)}</span>`; }
function pct(v) { return v == null ? '–' : `${Math.round(v * 100)}%`; }
function short(a) { return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : ''; }
function ago(iso) { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; }
function explorer(sig) { return sig ? `<a href="https://explorer.solana.com/tx/${esc(sig)}?cluster=${esc(state.config?.network || 'devnet')}" target="_blank" rel="noopener">tx</a>` : ''; }
function toast(message, isError = false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast${isError ? ' error' : ''}`;
  // An open modal dialog covers everything outside it, so show the toast inside the dialog.
  (document.querySelector('dialog[open]') || document.body).appendChild(el);
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 4500);
}
function spark(series, height = 40) {
  if (!series || series.length < 2) return `<svg class="spark" style="height:${height}px"></svg>`;
  const pts = [0, ...series]; const min = Math.min(...pts), max = Math.max(...pts); const span = max - min || 1;
  const d = pts.map((v, i) => `${(i / (pts.length - 1) * 100).toFixed(2)},${(height - 2 - (v - min) / span * (height - 4)).toFixed(2)}`).join(' ');
  const zero = height - 2 - (0 - min) / span * (height - 4);
  const color = pts[pts.length - 1] >= 0 ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" style="height:${height}px" viewBox="0 0 100 ${height}" preserveAspectRatio="none"><line x1="0" x2="100" y1="${zero}" y2="${zero}" stroke="var(--border)" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/><polyline fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" points="${d}"/></svg>`;
}

async function refresh() {
  try {
    const [overview, config, events, wallet, journal] = await Promise.all([api('/api/overview'), api('/api/config'), api('/api/events'), api('/api/wallet').catch(() => null), api('/api/journal').catch(() => null)]);
    state = { overview, config, events, wallet, journal };
    render();
  } catch (e) { $('#alerts').innerHTML = `<div class="alert bad">Can't reach the server: ${esc(e.message)}</div>`; }
}

function render() {
  const { overview: o, config: c } = state;
  $('#network').textContent = c.network;
  $('#network').className = `pill ${c.network === 'mainnet-beta' ? 'pill-up' : ''}`;
  $('#mode').textContent = c.liveTradingEnabled ? 'LIVE TRADING ON' : 'PAPER ONLY';
  $('#mode').className = `pill ${c.liveTradingEnabled ? 'pill-live' : 'pill-warn'}`;
  $('#unlock').textContent = adminToken ? '🔓 Unlocked' : '🔒 Unlock';

  const alerts = [];
  if (!c.setup?.persistentDataDir) alerts.push(['', 'Free-plan mode: trade history resets when Render sleeps or redeploys. Bot wallets are always recovered from your encryption key. Use Download backup to keep history.']);
  if (c.setup?.recovery?.recovered) alerts.push(['', `Recovered ${c.setup.recovery.recovered} bot wallet(s) after a restart. Restore a backup to bring back their history.`]);
  if (!c.setup?.encryptionKeyValid) alerts.push(['bad', 'WALLET_ENCRYPTION_KEY is missing or invalid, so bot wallets cannot be created.']);
  if (!c.setup?.adminTokenSet) alerts.push(['', 'ADMIN_API_TOKEN is not set, so every control is locked.']);
  if (o.rpcError) alerts.push(['', o.rpcError]);
  if (o.engine?.lastError) alerts.push(['', `Engine: ${o.engine.lastError}`]);
  $('#alerts').innerHTML = alerts.map(([cls, m]) => `<div class="alert ${cls}">${esc(m)}</div>`).join('');

  const t = o.totals;
  $('#kBots').textContent = `${o.bots.filter(b => b.enabled).length} / ${o.bots.length}`;
  $('#kBalance').textContent = sol(t.balanceSol, 3);
  $('#kPnl').innerHTML = signed(t.realizedPnlSol, 4);
  $('#kWin').textContent = t.trades ? pct(t.wins / t.trades) : '–';
  $('#kTrades').textContent = `${t.trades} trades`;
  $('#kOpen').textContent = o.positions.length;
  $('#kEngine').textContent = o.engine?.lastTickAt ? `engine scanned ${ago(o.engine.lastTickAt)} ago · ${o.engine.candidates} candidates` : 'engine starting…';

  renderBots(); renderPositions(); renderTrades(); renderSide(); renderJournal(); renderSmartWallets();
}

function renderBots() {
  const bots = state.overview.bots;
  if (!bots.length) { $('#bots').innerHTML = '<div class="empty">No bots yet. Click <b>+ New bot</b> to create one. It starts in paper mode.</div>'; return; }
  $('#bots').innerHTML = bots.map(b => {
    const p = b.perf || {};
    const statusCls = b.enabled ? (b.mode === 'live' ? 'pill-live' : 'pill-up') : b.status?.startsWith('Stopped') ? 'pill-down' : '';
    return `<div class="bot">
      <div class="bot-head">
        <div><div class="bot-name">${esc(b.name)}</div><div class="addr mono">${esc(short(b.walletAddress))} <button class="btn btn-ghost btn-sm" data-copy="${esc(b.walletAddress)}" title="Copy wallet address">Copy</button></div></div>
        <div class="stack" style="align-items:flex-end;gap:4px"><span class="pill ${statusCls}">${esc(b.status)}</span>
          <div class="mode-switch" role="group" aria-label="Trading mode">
            <button type="button" class="${b.mode === 'paper' ? 'on' : ''}" data-act="mode" data-mode="paper" data-id="${esc(b.id)}" aria-pressed="${b.mode === 'paper'}">Paper</button>
            <button type="button" class="${b.mode === 'live' ? 'on live' : ''}" data-act="mode" data-mode="live" data-id="${esc(b.id)}" aria-pressed="${b.mode === 'live'}" ${state.config.liveTradingEnabled ? '' : 'disabled title="Live trading is off on this server"'}>Live</button>
          </div></div>
      </div>
      <div>
        <div class="muted small">${b.mode === 'paper' ? 'Paper balance' : 'Wallet balance'}</div>
        <div class="bot-balance">${sol(b.mode === 'paper' ? b.paperBalanceSol : b.balanceSol)} <span class="muted small">SOL</span></div>
        ${b.mode === 'paper' ? `<div class="muted small">On-chain wallet: ${sol(b.balanceSol)} SOL</div>` : ''}
      </div>
      ${spark(p.series)}
      <div class="stats">
        <div class="stat"><b>${p.trades ?? 0}</b><span>Trades</span></div>
        <div class="stat"><b>${pct(p.winRate)}</b><span>Win rate</span></div>
        <div class="stat"><b>${signed(p.realizedPnlSol, 3)}</b><span>P&amp;L SOL</span></div>
        <div class="stat"><b>${b.openPositions}/${b.maxOpenPositions}</b><span>Open</span></div>
      </div>
      <div class="chips">
        ${b.partialSellPercent > 0 ? `<span class="chip">bank ${esc(b.partialSellPercent)}% at ${gain(b.partialTakeProfitMultiplier)}</span>` : ''}<span class="chip">sell all at ${gain(b.takeProfitMultiplier)}</span><span class="chip">${b.stopLossFollowsPrice ? 'trailing ' : ''}SL ${esc(b.stopLossPercent)}%</span>
        <span class="chip">${esc(b.maxPositionSol)} SOL/trade</span><span class="chip">liq ≥ $${Number(b.minLiquidityUsd).toLocaleString()}</span>
        <span class="chip">age ≤ ${esc(b.maxPairAgeMinutes)}m</span><span class="chip">hold ≤ ${esc(b.maxHoldMinutes)}m</span>
        ${b.followWallets?.length || b.autoFollow ? `<span class="chip">copying ${b.followWallets?.length ? `${b.followWallets.length} wallet${b.followWallets.length > 1 ? 's' : ''}` : ''}${b.followWallets?.length && b.autoFollow ? ' + ' : ''}${b.autoFollow ? 'auto-found wallets' : ''}${b.followOnly ? ' only' : ''}</span>` : ''}
        ${b.trailingStopPercent ? `<span class="chip">trail ${esc(b.trailingStopPercent)}%</span>` : ''}
        ${b.insiderSellPct > 0 || b.maxSingleHolderPct > 0 ? `<span class="chip">rug guard${b.maxSingleHolderPct > 0 ? ` · 1 wallet ≤ ${esc(b.maxSingleHolderPct)}%` : ''}${b.insiderSellPct > 0 ? ` · sell if insiders dump ${esc(b.insiderSellPct)}%` : ''}</span>` : '<span class="chip">rug guard off</span>'}
      </div>
      <div class="bot-actions">
        ${b.enabled ? `<button class="btn btn-stop btn-sm" data-act="pause" data-id="${esc(b.id)}">Pause</button>` : `<button class="btn btn-start btn-sm" data-act="start" data-id="${esc(b.id)}">Start</button>`}
        ${b.openPositions ? `<button class="btn btn-stop btn-sm" data-act="sellall" data-id="${esc(b.id)}">Pause &amp; sell all</button>` : ''}
        <button class="btn btn-sm" data-act="details" data-id="${esc(b.id)}">Stats &amp; wallet</button>
        <button class="btn btn-sm" data-act="withdraw" data-id="${esc(b.id)}">Withdraw</button>
        <button class="btn btn-sm" data-act="cleanup" data-id="${esc(b.id)}" title="Sell or burn leftover coins in this bot's wallet and get the account deposits back">Recover SOL</button>
        <button class="btn btn-sm" data-act="edit" data-id="${esc(b.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" data-act="delete" data-id="${esc(b.id)}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

// Rug check result, shown as its own column so it can be read at a glance.
function rugPosition(p) {
  if (p.rugWarning) return `<span class="pill pill-down" title="${esc(p.rugWarning)}">RUG · selling</span>`;
  if (p.multiple != null && p.multiple <= 0.5) return '<span class="pill pill-down" title="Down half or more since the buy: treat as a rug">RUG</span>';
  if (p.holderWatch) {
    const top = Math.max(0, ...p.holderWatch.wallets.map(w => w.amount)) / p.holderWatch.supply * 100;
    return `<span class="pill pill-up" title="Watching ${p.holderWatch.wallets.length} big wallets every 1.5 s. Biggest holds ${top.toFixed(1)}%. None has dumped.">CLEAN</span>`;
  }
  return p.holderWatchTried ? '<span class="pill" title="Couldn\'t read this coin\'s holders">not checked</span>' : '<span class="pill pill-warn">checking…</span>';
}
function rugTrade(t) {
  if (t.reason === 'rug_warning') return '<span class="pill pill-down" title="Insiders started dumping; the bot sold early">RUG · sold early</span>';
  if (t.reason === 'unsellable') return '<span class="pill pill-down" title="Nobody could buy it back">RUG</span>';
  if (t.entrySol > 0 && t.pnlSol / t.entrySol <= -0.5) return '<span class="pill pill-down" title="Lost half or more: the rug checks didn\'t catch it in time">RUG · missed</span>';
  const f = t.features || {};
  if (f.topWalletPct != null) return `<span class="pill pill-up" title="Biggest wallet held ${f.topWalletPct.toFixed(1)}% at entry${f.creatorPct != null ? `, creator ${f.creatorPct.toFixed(1)}%` : ''}; no insider dump while held">CLEAN</span>`;
  return '<span class="pill">not checked</span>';
}

function positionRows(positions, withBot = true) {
  if (!positions.length) return '<p class="muted">No open positions.</p>';
  return `<table><thead><tr>${withBot ? '<th>Bot</th>' : ''}<th>Token</th><th>Rug check</th><th>Spent SOL</th><th title="What selling now would return, after fees">Worth SOL</th><th>P&amp;L</th><th>Held</th><th></th></tr></thead><tbody>${positions.map(p => {
    const m = p.multiple ?? 1;
    return `<tr>${withBot ? `<td>${esc(p.botName || '')}</td>` : ''}<td>${p.pairUrl ? `<a href="${esc(p.pairUrl)}" target="_blank" rel="noopener">${esc(p.symbol)}</a>` : esc(p.symbol)} <span class="pill">${esc(p.mode)}</span>${p.leader ? ` <span class="pill" title="Copied from ${esc(p.leader)}">copy</span>` : ''}${p.partialDone ? ' <span class="pill pill-up">part banked</span>' : ''}${p.sellError ? ` <span class="pill pill-down" title="${esc(p.sellError)}">no buyers · retrying</span>` : p.sellFailures ? ' <span class="pill pill-down">sell retrying</span>' : ''}</td><td>${rugPosition(p)}</td><td>${sol(p.sizeSol)}</td>${p.sellError ? '<td class="muted">unknown</td><td class="down">can\'t sell</td>' : `<td>${sol(p.sizeSol * m)}</td><td>${signed((m - 1) * 100, 1)}%</td>`}<td>${ago(p.openedAt)}</td><td><button class="btn btn-sm" data-close="${esc(p.id)}" data-bot="${esc(p.botId)}">Sell now</button></td></tr>`;
  }).join('')}</tbody></table>`;
}
function tradeRows(trades, withBot = true) {
  if (!trades.length) return '<p class="muted">No trades yet.</p>';
  return `<table><thead><tr><th>Closed</th>${withBot ? '<th>Bot</th>' : ''}<th>Token</th><th>Rug check</th><th>In SOL</th><th>Out SOL</th><th>P&amp;L</th><th>Exit</th><th></th></tr></thead><tbody>${trades.map(t => `<tr><td>${ago(t.closedAt)} ago</td>${withBot ? `<td>${esc(t.botName || '')}</td>` : ''}<td>${esc(t.symbol)} <span class="pill">${esc(t.mode)}</span>${t.features?.copied ? ' <span class="pill">copy</span>' : ''}</td><td>${rugTrade(t)}</td><td>${sol(t.entrySol)}</td><td>${sol(t.exitSol)}</td><td>${signed(t.pnlSol)}</td><td>${esc(REASONS[t.reason] || String(t.reason).replace('_', ' '))}${t.partialSol ? ' <span class="muted small">(part banked)</span>' : ''}</td><td>${explorer(t.sellSignature)}</td></tr>`).join('')}</tbody></table>`;
}
// Which entry signals have actually paid off, from this server's own closed trades.
// Wallets the bot found and graded itself; bots with auto-find on copy these.
function renderSmartWallets() {
  const ws = state.overview?.smartWallets || [];
  const on = (state.overview?.bots || []).some(b => b.autoFollow);
  $('#smartWallets').innerHTML = ws.length ? `<table><thead><tr><th>Wallet</th><th>Win rate</th><th>P&amp;L SOL</th></tr></thead><tbody>${ws.map(w => `<tr><td class="mono" title="${esc(w.address)}">${esc(short(w.address))}</td><td>${pct(w.winRate)} <span class="muted">of ${w.closed}</span></td><td>${signed(w.pnlSol, 2)}</td></tr>`).join('')}</tbody></table>`
    : `<p class="muted small">${on ? 'Searching: when a coin runs 3x, the bot grades the wallets that sold it for a profit and lists the good ones here.' : 'Turn on "Auto-find wallets" in a bot to let it find traders to copy.'}</p>`;
}
function renderJournal() {
  const j = state.journal;
  if (!j || j.trades < 5) { $('#journal').innerHTML = `<p class="muted small">Shows which signals win once there are 5+ closed trades (${j?.trades || 0} so far).</p>`; return; }
  $('#journal').innerHTML = `<p class="muted small">${j.trades} trades. Green ranges are making money; tighten filters toward them.</p>` + j.signals.filter(sig => sig.ranges.some(r => r.trades)).map(sig => `
    <div class="jrow"><div class="small"><b>${esc(sig.label)}</b></div><div class="jcells">${sig.ranges.map(r => `<div class="jcell ${r.trades ? (r.pnlSol > 0 ? 'jup' : 'jdown') : ''}" title="${r.trades} trades, P&amp;L ${r.pnlSol.toFixed(4)} SOL"><span>${esc(r.label)}</span><b>${r.trades ? pct(r.winRate) : '–'}</b><span class="muted">${r.trades}×</span></div>`).join('')}</div></div>`).join('');
}
function renderPositions() { $('#positions').innerHTML = positionRows(state.overview.positions); }
function renderTrades() { $('#trades').innerHTML = tradeRows(state.overview.recentTrades.slice(0, 25)); }

function renderSide() {
  const { wallet: w, config: c, events } = state;
  if (w?.configured) {
    $('#treasury').innerHTML = `<dl class="kv"><dt>Address</dt><dd class="mono">${esc(w.address)}</dd><dt>Balance</dt><dd>${sol(w.balanceSol)} SOL</dd></dl>`;
    $('#withdrawForm').classList.toggle('hidden', !adminToken);
  } else {
    $('#treasury').innerHTML = '<p class="muted small">No treasury key configured (optional).</p>';
    $('#withdrawForm').classList.add('hidden');
  }
  $('#policy').innerHTML = `<dl class="kv"><dt>Dev wallet</dt><dd class="mono">${esc(short(c.devWalletAddress))}</dd><dt>Profit fee</dt><dd>${esc(c.devFeePercent)}% of profit · ${c.devFeeTransfersEnabled ? '<span class="up">on</span>' : 'off'}</dd><dt>Sweeps</dt><dd>${c.liveSweepEnabled ? '<span class="up">on</span>' : 'off'}</dd></dl>`;
  $('#events').innerHTML = events.length ? events.slice(0, 40).map(e => `<p class="${esc(e.level)}"><time>${ago(e.at)} ago</time>${esc(e.message)}</p>`).join('') : 'No events yet.';
}

// ---------- bot form ----------
const fields = { fName: 'name', fMode: 'mode', fTp: 'takeProfitMultiplier', fSl: 'stopLossPercent', fHold: 'maxHoldMinutes', fMax: 'maxPositionSol', fOpen: 'maxOpenPositions', fLoss: 'maxDailyLossSol', fLiq: 'minLiquidityUsd', fAge: 'maxPairAgeMinutes', fBuys: 'minBuys5m', fSlip: 'slippageBps', fTrail: 'trailingStopPercent', fRatio: 'minBuySellRatio', fPrio: 'priorityFeeSol', fImpact: 'maxPriceImpactPct', fRound: 'maxRoundTripPct', fHolders: 'minHolders', fTop: 'maxTopHoldersPct', fPartTp: 'partialTakeProfitMultiplier', fPartPct: 'partialSellPercent', fDev: 'maxDevHoldingPct', fDevMints: 'maxDevLaunches', fOrganic: 'minOrganicScore', fMinAge: 'minPairAgeMinutes', fWhale: 'maxSingleHolderPct', fInsider: 'insiderSellPct', fLiqHolder: 'maxLiquidityPerHolderUsd' };
// Profit targets are entered as a % gain (50 = +50%) and stored as a multiple (1.5×).
const GAIN_FIELDS = new Set(['fTp', 'fPartTp']);
const gain = m => `+${+((m - 1) * 100).toFixed(1)}%`;
const REASONS = { take_profit: 'take profit', stop_loss: 'stop loss', trailing_stop: 'trailing stop', max_hold: 'time limit', protect_profit: 'kept profit', unsellable: 'unsellable', manual: 'sold by you', rug_warning: 'rug warning', leader_sold: 'copied wallet sold' };
const defaults = { name: '', mode: 'paper', takeProfitMultiplier: 1.5, stopLossPercent: 12, stopLossFollowsPrice: true, maxHoldMinutes: 30, maxPositionSol: 0.05, maxOpenPositions: 3, maxDailyLossSol: 0.2, minLiquidityUsd: 15000, maxPairAgeMinutes: 60, minBuys5m: 10, slippageBps: 500, trailingStopPercent: 12, minBuySellRatio: 1.5, priorityFeeSol: 0.0003, maxPriceImpactPct: 8, maxRoundTripPct: 4, minHolders: 100, maxTopHoldersPct: 30, partialTakeProfitMultiplier: 1.15, partialSellPercent: 50, maxDevHoldingPct: 5, maxDevLaunches: 10, minOrganicScore: 0, minPairAgeMinutes: 5, maxSingleHolderPct: 10, insiderSellPct: 2, maxLiquidityPerHolderUsd: 150 };
function requireUnlock() { if (adminToken) return true; $('#unlockDialog').showModal(); return false; }
function openBotForm(bot) {
  if (!requireUnlock()) return;
  editingBotId = bot?.id || null;
  $('#botDialogTitle').textContent = bot ? `Edit ${bot.name}` : 'New bot';
  $('#botSubmit').textContent = bot ? 'Save changes' : 'Create bot';
  for (const [id, key] of Object.entries(fields)) {
    const v = (bot || defaults)[key] ?? defaults[key];
    $(`#${id}`).value = GAIN_FIELDS.has(id) ? +((v - 1) * 100).toFixed(2) : v;
  }
  $('#fSlFollow').checked = (bot || defaults).stopLossFollowsPrice ?? defaults.stopLossFollowsPrice;
  $('#fFollow').value = (bot?.followWallets || []).join('\n');
  $('#fFollowOnly').checked = Boolean(bot?.followOnly);
  $('#fAutoFollow').checked = Boolean(bot?.autoFollow);
  $('#followReport').innerHTML = '';
  feeHint();
  botError('');
  $('#botDialog').showModal();
}
// Network + priority fees on the buy and the sell, as a share of the position size.
function feeHint() {
  const size = Number($('#fMax').value), fee = Number($('#fPrio').value) + 0.000005;
  const pctCost = size > 0 ? fee * 2 / size * 100 : 0;
  $('#feeHint').innerHTML = size > 0 ? `Fees take about <b class="${pctCost > 3 ? 'down' : ''}">${pctCost.toFixed(1)}%</b> of each trade (buy + sell).${pctCost > 3 ? ' That is a lot: use a bigger position or a lower priority fee.' : ''}` : '';
}
// Grade each pasted wallet from its last 100 transactions before trusting it with copy trades.
function walletVerdict(r) {
  if (r.read != null && r.read < r.of * 0.8) return ['', `only read ${r.read} of ${r.of} trades (Solana connection busy): try again`];
  if (r.sentAway >= 3 && r.closed < 8) return ['down', 'sends coins to other wallets instead of selling: skip'];
  if (r.swapsPerHour > 30) return ['down', 'trades like a bot: skip'];
  if (r.closed < 8) return ['', 'too few finished trades to judge'];
  if (r.pnlSol > 0 && r.winRate >= 0.4) return ['up', 'looks good'];
  return ['down', 'losing: skip'];
}
$('#checkFollow').addEventListener('click', async () => {
  const wallets = $('#fFollow').value.split(/[\s,]+/).filter(Boolean);
  if (!wallets.length) { $('#followReport').innerHTML = '<p class="muted">Paste wallet addresses first.</p>'; return; }
  $('#followReport').innerHTML = '<p class="muted">Reading their last 100 transactions… (about 10 s per wallet)</p>';
  const rows = [];
  for (const w of wallets) {
    try {
      const r = await api(`/api/wallets/${encodeURIComponent(w)}/record`);
      const [cls, verdict] = walletVerdict(r);
      rows.push(`<tr><td class="mono" title="${esc(w)}">${esc(short(w))}</td><td>${r.closed}${r.unsold ? ` <span class="muted">(${r.unsold} never sold)</span>` : ''}</td><td>${r.winRate == null ? '–' : pct(r.winRate)}</td><td>${signed(r.pnlSol, 2)}</td><td>${r.swapsPerHour.toFixed(1)}</td><td class="${cls}">${esc(verdict)}</td></tr>`);
    } catch (e) { rows.push(`<tr><td class="mono">${esc(short(w))}</td><td colspan="5" class="down">${esc(e.message)}</td></tr>`); }
    $('#followReport').innerHTML = `<table><thead><tr><th>Wallet</th><th>Finished trades</th><th>Win rate</th><th>P&amp;L SOL</th><th>Trades/hr</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
});
$('#fMax').addEventListener('input', feeHint);
$('#fPrio').addEventListener('input', feeHint);
$('#newBot').addEventListener('click', () => openBotForm(null));
$('#botClose').addEventListener('click', () => $('#botDialog').close());
// Errors are shown inside the dialog: a toast would sit behind the open dialog where it can't be seen.
function botError(msg, field) {
  $('#botError').textContent = msg || '';
  $('#botError').classList.toggle('hidden', !msg);
  if (field) { field.focus(); field.scrollIntoView({ block: 'center' }); }
}
function checkBotForm() {
  for (const el of $('#botForm').querySelectorAll('input')) {
    const label = el.closest('label')?.firstChild?.textContent.trim() || el.id;
    if (el.required && el.value.trim() === '') return botError(`${label}: enter a value.`, el), false;
    if (el.type !== 'number') continue;
    const v = Number(el.value);
    if (!Number.isFinite(v)) return botError(`${label}: enter a number.`, el), false;
    if (el.min !== '' && v < Number(el.min)) return botError(`${label}: must be at least ${el.min}.`, el), false;
    if (el.max !== '' && v > Number(el.max)) return botError(`${label}: must be at most ${el.max}.`, el), false;
  }
  return true;
}
$('#botForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  botError('');
  if (!checkBotForm()) return;
  const body = { stopLossFollowsPrice: $('#fSlFollow').checked, followWallets: $('#fFollow').value.split(/[\s,]+/).filter(Boolean), followOnly: $('#fFollowOnly').checked, autoFollow: $('#fAutoFollow').checked };
  for (const [id, key] of Object.entries(fields)) {
    const v = $(`#${id}`).value;
    body[key] = id === 'fName' || id === 'fMode' ? v : GAIN_FIELDS.has(id) ? 1 + Number(v) / 100 : Number(v);
  }
  try {
    if (editingBotId) await api(`/api/bots/${encodeURIComponent(editingBotId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    else { const bot = await post('/api/bots', body); toast(`Created ${bot.name}. Wallet ${short(bot.walletAddress)}`); }
    $('#botDialog').close(); refresh();
  } catch (err) { botError(err.message); }
});

// ---------- bot actions ----------
const botById = id => state.overview.bots.find(b => b.id === id);
document.addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Address copied'); } catch { prompt('Copy address', copy.dataset.copy); } return; }
  const close = e.target.closest('[data-close]');
  if (close) {
    if (!requireUnlock() || !confirm('Sell this position now at market?')) return;
    try { await post(`/api/bots/${encodeURIComponent(close.dataset.bot)}/positions/${encodeURIComponent(close.dataset.close)}/close`, {}); toast('Position closed'); await refresh(); if (detailBotId) openDetails(detailBotId); } catch (err) { toast(err.message, true); }
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const bot = botById(act.dataset.id);
  if (!bot) return;
  try {
    if (act.dataset.act === 'details') return openDetails(bot.id);
    if (act.dataset.act === 'withdraw') return openDetails(bot.id, { withdraw: true });
    if (act.dataset.act === 'edit') return openBotForm(bot);
    if (!requireUnlock()) return;
    if (act.dataset.act === 'mode') {
      const mode = act.dataset.mode;
      if (mode === bot.mode) return;
      if (mode === 'live' && !confirm(`Switch ${bot.name} to LIVE? ${bot.enabled ? 'It is running, so its next buys' : 'Once started, its buys'} spend real SOL from its wallet, up to ${bot.maxPositionSol} SOL per trade.`)) return;
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: JSON.stringify({ mode }) });
      toast(`${bot.name} is now ${mode === 'live' ? 'LIVE' : 'paper'}${bot.openPositions ? '. Open positions finish in the mode they were opened in.' : '.'}`);
    }
    if (act.dataset.act === 'start') {
      if (bot.mode === 'live' && !confirm(`Start ${bot.name} LIVE? It will spend real SOL from its wallet, up to ${bot.maxPositionSol} SOL per trade.`)) return;
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) }); toast(`${bot.name} started`);
    }
    if (act.dataset.act === 'pause') { await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }); toast(`${bot.name} paused: no new buys. Its open positions still sell on their exit rules; use Pause & sell all to exit now.`); }
    if (act.dataset.act === 'cleanup') {
      if (!confirm(`Recover SOL from ${bot.name}'s wallet?\n\nCoins that still have buyers are sold. Coins nobody can buy are burned (they're worthless) and their ~0.002 SOL deposits come back. Open positions are not touched.`)) return;
      act.disabled = true;
      toast('Cleaning up the wallet… this can take a minute.');
      try {
        const r = await post(`/api/bots/${encodeURIComponent(bot.id)}/cleanup`, {});
        toast(`${bot.name}: sold ${r.sold.length}, burned ${r.burned.length} dead coin(s), closed ${r.closed} account(s). ${r.recoveredSol >= 0 ? '+' : ''}${r.recoveredSol.toFixed(4)} SOL back in the wallet.`);
      } finally { act.disabled = false; }
      return refresh();
    }
    if (act.dataset.act === 'sellall') {
      if (!confirm(`Pause ${bot.name} and sell all ${bot.openPositions} open position(s) at market now?`)) return;
      act.disabled = true;
      const r = await post(`/api/bots/${encodeURIComponent(bot.id)}/sell-all`, {});
      toast(r.failed.length ? `${bot.name} paused. Sold ${r.sold}; ${r.failed.length} could not sell yet and will keep retrying.` : `${bot.name} paused and sold ${r.sold} position(s).`, r.failed.length > 0);
    }
    if (act.dataset.act === 'delete') {
      if (!confirm(`Delete ${bot.name}? This is only allowed once its wallet is empty.`)) return;
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); toast(`${bot.name} deleted`);
    }
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---------- details dialog ----------
async function openDetails(id, { withdraw = false } = {}) {
  detailBotId = id;
  const dlg = $('#detailDialog');
  if (!dlg.open) { $('#dBody').innerHTML = '<p class="muted">Loading…</p>'; dlg.showModal(); }
  try {
    const d = await api(`/api/bots/${encodeURIComponent(id)}/stats`);
    const b = d.bot, p = d.perf;
    $('#dTitle').textContent = b.name;
    $('#dBody').innerHTML = `
      <dl class="kv"><dt>Wallet</dt><dd class="mono">${esc(b.walletAddress)} <button class="btn btn-ghost btn-sm" data-copy="${esc(b.walletAddress)}">Copy</button></dd>
      <dt>On-chain balance</dt><dd>${sol(d.balanceSol)} SOL</dd>${b.mode === 'paper' ? `<dt>Paper balance</dt><dd>${sol(b.paperBalanceSol)} SOL</dd>` : ''}
      <dt>Mode</dt><dd>${esc(b.mode)} · ${esc(b.status)}</dd><dt>Created</dt><dd>${esc(new Date(b.createdAt).toLocaleString())}</dd></dl>
      <div class="detail-grid">
        <div class="stat"><b>${p.trades}</b><span>Trades</span></div>
        <div class="stat"><b>${p.wins} / ${p.losses}</b><span>Wins / losses</span></div>
        <div class="stat"><b>${pct(p.winRate)}</b><span>Win rate</span></div>
        <div class="stat"><b>${signed(p.realizedPnlSol)}</b><span>Realized P&amp;L SOL</span></div>
        <div class="stat"><b>${signed(p.avgPnlSol)}</b><span>Avg per trade</span></div>
        <div class="stat"><b>${signed(p.bestSol)}</b><span>Best trade</span></div>
        <div class="stat"><b>${signed(p.worstSol)}</b><span>Worst trade</span></div>
        <div class="stat"><b>${p.avgHoldMinutes == null ? '–' : `${p.avgHoldMinutes.toFixed(1)}m`}</b><span>Avg hold</span></div>
      </div>
      <h4>Cumulative P&amp;L</h4>${spark(p.series, 90)}
      <h4 style="margin-top:14px">Open positions</h4><div class="table-card">${positionRows(d.positions.map(x => ({ ...x })), false)}</div>
      <h4 style="margin-top:14px">Trade history</h4><div class="table-card">${tradeRows(d.trades, false)}</div>
      <h4 style="margin-top:14px">Withdraw (move funds out)</h4>
      <p class="muted small">Pause the bot and sell its open coins first. This sends SOL only.</p>
      <form id="botWithdraw" class="stack" novalidate>
        <label>Send SOL to (your wallet address) <input id="bwTo" required autocomplete="off" placeholder="Your Phantom / Solflare address"></label>
        <div class="row3"><label>Amount SOL <input id="bwAmount" type="number" min="0" step="any" inputmode="decimal"></label><label class="check" style="align-self:end"><input id="bwAll" type="checkbox"> Withdraw everything</label></div>
        <label class="check"><input id="bwConfirm" type="checkbox"> I checked the address. Transfers are irreversible.</label>
        <div class="actions" style="justify-content:flex-start"><button class="btn btn-primary" type="submit">Withdraw SOL</button><button class="btn" type="button" id="exportKey">Export private key</button>${state.config?.liveTradingEnabled ? '<button class="btn" type="button" id="testSwap">Test live swap (0.01 SOL)</button>' : ''}</div>
      </form>
      <div id="secretOut"></div>`;
    if (withdraw) { $('#botWithdraw').scrollIntoView({ block: 'start' }); $('#bwTo').focus(); }
  } catch (err) { $('#dBody').innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; }
}
$('#dClose').addEventListener('click', () => { detailBotId = null; $('#detailDialog').close(); });
$('#detailDialog').addEventListener('close', () => { detailBotId = null; $('#secretOut') && ($('#secretOut').innerHTML = ''); });
$('#detailDialog').addEventListener('submit', async e => {
  if (e.target.id !== 'botWithdraw') return;
  e.preventDefault();
  if (!requireUnlock()) return;
  if (!$('#bwTo').value.trim()) return toast('Enter the wallet address to send to.', true);
  if (!$('#bwAll').checked && !(Number($('#bwAmount').value) > 0)) return toast('Enter an amount, or tick "Withdraw everything".', true);
  if (!$('#bwConfirm').checked) return toast('Tick the confirmation box first.', true);
  try {
    const r = await post(`/api/bots/${encodeURIComponent(detailBotId)}/withdraw`, { to: $('#bwTo').value.trim(), amountSol: Number($('#bwAmount').value), all: $('#bwAll').checked, confirm: true });
    toast(`Sent ${r.amountSol} SOL`); refresh(); openDetails(detailBotId);
  } catch (err) { toast(err.message, true); }
});
$('#detailDialog').addEventListener('click', async e => {
  if (e.target.id !== 'testSwap') return;
  if (!requireUnlock() || !confirm('Swap 0.01 SOL to USDC and back for real, using this bot\'s wallet? It costs a few thousandths of a SOL in fees.')) return;
  e.target.disabled = true; e.target.textContent = 'Swapping…';
  try { const r = await post(`/api/bots/${encodeURIComponent(detailBotId)}/test-swap`, { confirm: true }); toast(`Live swap OK: buy ${r.buyMs} ms, sell ${r.sellMs} ms, cost ${r.costSol.toFixed(5)} SOL`); openDetails(detailBotId); }
  catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Test live swap (0.01 SOL)'; }
});
$('#detailDialog').addEventListener('click', async e => {
  if (e.target.id !== 'exportKey') return;
  if (!requireUnlock()) return;
  if (!confirm('Show this bot wallet\'s private key? Anyone who sees it can take the funds. Only do this on a private screen.')) return;
  try {
    const r = await post(`/api/bots/${encodeURIComponent(detailBotId)}/export-key`, { confirm: true });
    $('#secretOut').innerHTML = `<p class="small muted">Import into Phantom or Solflare as a private key. Store it offline; don't paste it anywhere else.</p><div class="secret mono">${esc(r.secretKeyBase58)}</div>`;
  } catch (err) { toast(err.message, true); }
});

// ---------- system check ----------
function renderSelfTest(r) {
  if (!r?.steps?.length) return;
  $('#selftest').innerHTML = `<p class="small ${r.ok ? 'up' : 'down'}">${r.ok ? 'All checks passed' : 'Some checks failed'} · ${ago(r.at)} ago</p>` +
    r.steps.map(s => `<p class="small" style="margin:6px 0"><b class="${s.ok ? 'up' : 'down'}">${s.ok ? '✓' : '✗'}</b> ${esc(s.name)} <span class="muted">${s.ms} ms</span><br><span class="muted">${esc(s.detail)}</span></p>`).join('');
}
$('#selftestBtn').addEventListener('click', async e => {
  if (!requireUnlock()) return;
  e.target.disabled = true; e.target.textContent = 'Checking…';
  try { renderSelfTest(await post('/api/selftest', {})); } catch (err) { toast(err.message, true); }
  e.target.disabled = false; e.target.textContent = 'Run system check';
});
api('/api/selftest').then(renderSelfTest).catch(() => {});

// ---------- backup & restore ----------
$('#backupBtn').addEventListener('click', async () => {
  if (!requireUnlock()) return;
  try {
    const data = await api('/api/backup');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `corvis-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast('Backup downloaded');
  } catch (err) { toast(err.message, true); }
});
$('#restoreBtn').addEventListener('click', () => { if (requireUnlock()) $('#restoreFile').click(); });
$('#restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !confirm('Restore this backup? Bots will be paused and current history replaced by the backup.')) return;
  try { const r = await post('/api/restore', JSON.parse(await file.text())); toast(`Restored ${r.bots} bots and ${r.trades} trades`); refresh(); }
  catch (err) { toast(err.message, true); }
});

// ---------- treasury & unlock ----------
$('#withdrawForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!$('#wConfirm').checked) return toast('Tick the confirmation box first.', true);
  try { const r = await post('/api/wallet/withdraw', { to: $('#wTo').value.trim(), amountSol: Number($('#wAmount').value), confirm: true }); toast(`Withdrawal sent: ${short(r.signature)}`); refresh(); }
  catch (err) { toast(err.message, true); }
});
$('#unlock').addEventListener('click', () => {
  if (!adminToken) return $('#unlockDialog').showModal();
  if (!confirm('Lock the dashboard on this device? You will need the admin token to unlock it again.')) return;
  adminToken = ''; remember(''); toast('Locked'); render();
});
$('#unlockForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  const previous = adminToken;
  adminToken = $('#token').value.trim();
  try { await api('/api/auth/check'); remember(adminToken); toast('Unlocked on this device'); }
  catch (err) { adminToken = previous; toast(err.message, true); }
  render();
});

refresh();
setInterval(refresh, 10_000);
