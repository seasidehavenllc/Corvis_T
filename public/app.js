let adminToken = '';
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (adminToken) headers.authorization = `Bearer ${adminToken}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function refresh() {
  try {
    const [status, config, bots, events] = await Promise.all([api('/api/status'), api('/api/config'), api('/api/bots'), api('/api/events')]);
    document.querySelector('#mode').textContent = status.liveTradingEnabled ? 'LIVE' : 'PAPER ONLY';
    document.querySelector('#devWallet').textContent = config.devWalletAddress;
    document.querySelector('#policy').innerHTML = `<p>Fee transfers: <b>${config.devFeeTransfersEnabled ? 'enabled by environment' : 'disabled'}</b> · Sweeps: <b>${config.liveSweepEnabled ? 'enabled by environment' : 'disabled'}</b></p><p class="muted">Network: ${esc(config.network)} · Address valid: ${config.devWalletAddressValid ? 'yes' : 'no'}</p><p class="warning">${esc(config.note)}</p>`;
    document.querySelector('#bots').innerHTML = bots.length ? bots.map(b => `<div class="bot"><b>${esc(b.name)}</b> <span class="pill">${esc(b.status)}</span><p class="address">${esc(b.walletAddress)}</p><p class="muted">TP ${esc(b.takeProfitMultiplier)}× · SL ${esc(b.stopLossPercent)}% · Max ${esc(b.maxPositionSol)} SOL</p><button class="secondary" data-copy="${esc(b.walletAddress)}">Copy wallet</button><button class="secondary" data-sweep="${esc(b.id)}">Sweep to dev wallet</button><button class="danger" data-delete="${esc(b.id)}">Delete bot</button></div>`).join('') : '<p class="muted">No bots yet.</p>';
    document.querySelector('#events').innerHTML = events.length ? events.slice(0,12).map(e => `<p>${esc(e.at)} · ${esc(e.message)}</p>`).join('') : 'No events yet.';
  } catch (e) { document.querySelector('#bots').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
document.querySelector('#saveToken').addEventListener('click', () => { adminToken = document.querySelector('#token').value.trim(); refresh(); });
document.querySelector('#createBot').addEventListener('click', async () => {
  try {
    const bot = await api('/api/bots', { method:'POST', body:JSON.stringify({name:document.querySelector('#botName').value,takeProfitMultiplier:Number(document.querySelector('#tp').value),stopLossPercent:Number(document.querySelector('#sl').value),maxPositionSol:Number(document.querySelector('#maxPos').value)}) });
    alert(`Bot created: ${bot.walletAddress}`); await refresh();
  } catch(e) { alert(e.message); }
});
document.querySelector('#bots').addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); } catch { alert(copy.dataset.copy); } return; }
  const sweep = e.target.closest('[data-sweep]');
  if (sweep) {
    if (!confirm('Transfer this paused bot wallet’s remaining SOL and supported SPL tokens to the configured dev wallet? Transfers are irreversible.')) return;
    try { const result = await api(`/api/bots/${encodeURIComponent(sweep.dataset.sweep)}/sweep`, {method:'POST',body:JSON.stringify({confirm:true})}); alert(`Sweep confirmed. SOL: ${result.sol?.amountSol ?? 0}; token accounts moved: ${result.tokens?.length ?? 0}`); await refresh(); } catch(err) { alert(err.message); }
  }
  const del = e.target.closest('[data-delete]');
  if (del) {
    if (!confirm('Delete this paused bot profile? Funds are NOT swept automatically.')) return;
    try { await api(`/api/bots/${encodeURIComponent(del.dataset.delete)}`, {method:'DELETE',body:JSON.stringify({confirm:true})}); await refresh(); } catch(err) { alert(err.message); }
  }
});
refresh();
