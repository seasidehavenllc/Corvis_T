let adminToken = '';
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
    const [overview, config, events, wallet] = await Promise.all([api('/api/overview'), api('/api/config'), api('/api/events'), api('/api/wallet').catch(() => null)]);
    state = { overview, config, events, wallet };
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

  renderBots(); renderPositions(); renderTrades(); renderSide();
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
        <div class="stack" style="align-items:flex-end;gap:4px"><span class="pill ${statusCls}">${esc(b.status)}</span><span class="pill">${esc(b.mode)}</span></div>
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
        <span class="chip">TP ${esc(b.takeProfitMultiplier)}×</span><span class="chip">SL ${esc(b.stopLossPercent)}%</span>
        <span class="chip">${esc(b.maxPositionSol)} SOL/trade</span><span class="chip">liq ≥ $${Number(b.minLiquidityUsd).toLocaleString()}</span>
        <span class="chip">age ≤ ${esc(b.maxPairAgeMinutes)}m</span><span class="chip">hold ≤ ${esc(b.maxHoldMinutes)}m</span>
      </div>
      <div class="bot-actions">
        ${b.enabled ? `<button class="btn btn-stop btn-sm" data-act="pause" data-id="${esc(b.id)}">Pause</button>` : `<button class="btn btn-start btn-sm" data-act="start" data-id="${esc(b.id)}">Start</button>`}
        <button class="btn btn-sm" data-act="details" data-id="${esc(b.id)}">Stats &amp; wallet</button>
        <button class="btn btn-sm" data-act="edit" data-id="${esc(b.id)}">Edit</button>
        <button class="btn btn-danger btn-sm" data-act="delete" data-id="${esc(b.id)}">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function positionRows(positions, withBot = true) {
  if (!positions.length) return '<p class="muted">No open positions.</p>';
  return `<table><thead><tr>${withBot ? '<th>Bot</th>' : ''}<th>Token</th><th>Size SOL</th><th>Entry</th><th>Now</th><th>Move</th><th>Held</th><th></th></tr></thead><tbody>${positions.map(p => {
    const m = p.lastPrice / p.entryPrice;
    return `<tr>${withBot ? `<td>${esc(p.botName || '')}</td>` : ''}<td>${p.pairUrl ? `<a href="${esc(p.pairUrl)}" target="_blank" rel="noopener">${esc(p.symbol)}</a>` : esc(p.symbol)} <span class="pill">${esc(p.mode)}</span></td><td>${sol(p.sizeSol)}</td><td class="mono">${Number(p.entryPrice).toPrecision(4)}</td><td class="mono">${Number(p.lastPrice).toPrecision(4)}</td><td>${signed((m - 1) * 100, 1)}%</td><td>${ago(p.openedAt)}</td><td><button class="btn btn-sm" data-close="${esc(p.id)}" data-bot="${esc(p.botId)}">Sell now</button></td></tr>`;
  }).join('')}</tbody></table>`;
}
function tradeRows(trades, withBot = true) {
  if (!trades.length) return '<p class="muted">No trades yet.</p>';
  return `<table><thead><tr><th>Closed</th>${withBot ? '<th>Bot</th>' : ''}<th>Token</th><th>In SOL</th><th>Out SOL</th><th>P&amp;L</th><th>Exit</th><th></th></tr></thead><tbody>${trades.map(t => `<tr><td>${ago(t.closedAt)} ago</td>${withBot ? `<td>${esc(t.botName || '')}</td>` : ''}<td>${esc(t.symbol)} <span class="pill">${esc(t.mode)}</span></td><td>${sol(t.entrySol)}</td><td>${sol(t.exitSol)}</td><td>${signed(t.pnlSol)}</td><td>${esc(String(t.reason).replace('_', ' '))}</td><td>${explorer(t.sellSignature)}</td></tr>`).join('')}</tbody></table>`;
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
const fields = { fName: 'name', fMode: 'mode', fTp: 'takeProfitMultiplier', fSl: 'stopLossPercent', fHold: 'maxHoldMinutes', fMax: 'maxPositionSol', fOpen: 'maxOpenPositions', fLoss: 'maxDailyLossSol', fLiq: 'minLiquidityUsd', fAge: 'maxPairAgeMinutes', fBuys: 'minBuys5m', fSlip: 'slippageBps' };
const defaults = { name: '', mode: 'paper', takeProfitMultiplier: 1.45, stopLossPercent: 15, maxHoldMinutes: 60, maxPositionSol: 0.05, maxOpenPositions: 3, maxDailyLossSol: 0.2, minLiquidityUsd: 5000, maxPairAgeMinutes: 30, minBuys5m: 10, slippageBps: 300 };
function requireUnlock() { if (adminToken) return true; $('#unlockDialog').showModal(); return false; }
function openBotForm(bot) {
  if (!requireUnlock()) return;
  editingBotId = bot?.id || null;
  $('#botDialogTitle').textContent = bot ? `Edit ${bot.name}` : 'New bot';
  $('#botSubmit').textContent = bot ? 'Save changes' : 'Create bot';
  for (const [id, key] of Object.entries(fields)) $(`#${id}`).value = (bot || defaults)[key] ?? defaults[key];
  $('#botDialog').showModal();
}
$('#newBot').addEventListener('click', () => openBotForm(null));
$('#botForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const body = {};
  for (const [id, key] of Object.entries(fields)) body[key] = id === 'fName' || id === 'fMode' ? $(`#${id}`).value : Number($(`#${id}`).value);
  try {
    if (editingBotId) await api(`/api/bots/${encodeURIComponent(editingBotId)}`, { method: 'PATCH', body: JSON.stringify(body) });
    else { const bot = await post('/api/bots', body); toast(`Created ${bot.name}. Wallet ${short(bot.walletAddress)}`); }
    $('#botDialog').close(); refresh();
  } catch (err) { toast(err.message, true); }
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
    if (act.dataset.act === 'edit') return openBotForm(bot);
    if (!requireUnlock()) return;
    if (act.dataset.act === 'start') {
      if (bot.mode === 'live' && !confirm(`Start ${bot.name} LIVE? It will spend real SOL from its wallet, up to ${bot.maxPositionSol} SOL per trade.`)) return;
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: true }) }); toast(`${bot.name} started`);
    }
    if (act.dataset.act === 'pause') { await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }); toast(`${bot.name} paused. Open positions are still managed.`); }
    if (act.dataset.act === 'delete') {
      if (!confirm(`Delete ${bot.name}? This is only allowed once its wallet is empty.`)) return;
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) }); toast(`${bot.name} deleted`);
    }
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ---------- details dialog ----------
async function openDetails(id) {
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
      <h4 style="margin-top:14px">Move funds out</h4>
      <form id="botWithdraw" class="stack">
        <label>Send SOL to (your wallet address) <input id="bwTo" required autocomplete="off" placeholder="Your Phantom / Solflare address"></label>
        <div class="row3"><label>Amount SOL <input id="bwAmount" type="number" min="0.000001" step="0.000001"></label><label class="check" style="align-self:end"><input id="bwAll" type="checkbox"> Withdraw everything</label></div>
        <label class="check"><input id="bwConfirm" type="checkbox"> I checked the address. Transfers are irreversible.</label>
        <div class="actions" style="justify-content:flex-start"><button class="btn btn-primary" type="submit">Withdraw SOL</button><button class="btn" type="button" id="exportKey">Export private key</button></div>
      </form>
      <div id="secretOut"></div>`;
  } catch (err) { $('#dBody').innerHTML = `<div class="alert bad">${esc(err.message)}</div>`; }
}
$('#dClose').addEventListener('click', () => { detailBotId = null; $('#detailDialog').close(); });
$('#detailDialog').addEventListener('close', () => { detailBotId = null; $('#secretOut') && ($('#secretOut').innerHTML = ''); });
$('#detailDialog').addEventListener('submit', async e => {
  if (e.target.id !== 'botWithdraw') return;
  e.preventDefault();
  if (!requireUnlock()) return;
  if (!$('#bwConfirm').checked) return toast('Tick the confirmation box first.', true);
  try {
    const r = await post(`/api/bots/${encodeURIComponent(detailBotId)}/withdraw`, { to: $('#bwTo').value.trim(), amountSol: Number($('#bwAmount').value), all: $('#bwAll').checked, confirm: true });
    toast(`Sent ${r.amountSol} SOL`); refresh(); openDetails(detailBotId);
  } catch (err) { toast(err.message, true); }
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
$('#unlock').addEventListener('click', () => $('#unlockDialog').showModal());
$('#unlockForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return;
  const previous = adminToken;
  adminToken = $('#token').value.trim();
  try { await api('/api/auth/check'); toast('Unlocked'); }
  catch (err) { adminToken = previous; toast(err.message, true); }
  render();
});

refresh();
setInterval(refresh, 10_000);
