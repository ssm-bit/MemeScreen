// ============================================================
// MemeScreen — Screener. A Bloomberg-style table of every tracked Solana memecoin with saved screens and alerts.
//   columns: ticker, age, market cap, liquidity, 5m vol, 1h vol, buy/sell ratio, holders, top-10 %, insider %,
//            bundled %, mint authority, dev history, whale activity, social momentum, grade
//   data:    DexScreener (prices, volume, txns, boosts, socials) + RugCheck (holders, insiders, authorities, creator)
//            + the PumpPortal trade stream (whale prints).  RugCheck fields show "—" until that token's report arrives.
// ============================================================
let H = null;                                   // { tokens(), select(token), toast(), fireAlert(kind, t, msg), getScreens(), saveScreens(list), signedIn() }
const $ = id => document.getElementById(id);
const fmtK = n => n == null || !isFinite(n) ? '—' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + n.toFixed(0);
const fmtN = n => n == null || !isFinite(n) ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const ageMin = t => (Date.now() - (t.created || Date.now())) / 60000;
const ageTxt = m => m < 60 ? Math.round(m) + 'm' : m < 1440 ? (m / 60).toFixed(1) + 'h' : (m / 1440).toFixed(1) + 'd';
const pc = v => v == null ? '—' : v.toFixed(v < 10 ? 1 : 0) + '%';
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ---------- RugCheck enrichment (holders, top-10, insiders, authorities, creator) ----------
const rc = {};                                   // addr -> { at, holders, top10, insider, bundled, mint, freeze, creator, creatorTokens, risks }
let rcQueue = [], rcBusy = false, rcDown = 0;
try { Object.assign(rc, JSON.parse(localStorage.getItem('ms_rc') || '{}')); } catch {}
function rcSave(){ try { const keep = {}; for (const k in rc) if (Date.now() - rc[k].at < 6 * 3600e3) keep[k] = rc[k]; localStorage.setItem('ms_rc', JSON.stringify(keep)); } catch {} }
function rcWant(addr){ if (String(addr).startsWith('sim')) { rc[addr] ||= { at: Date.now(), unavailable: true }; return; } if (!addr || (rc[addr] && Date.now() - rc[addr].at < 1800e3) || rcQueue.includes(addr)) return; rcQueue.push(addr); rcPump(); }
async function rcPump(){
  if (rcBusy || !rcQueue.length || Date.now() < rcDown) return; rcBusy = true; const addr = rcQueue.shift();
  try {
    const r = await fetch('https://api.rugcheck.xyz/v1/tokens/' + addr + '/report', { headers: { accept: 'application/json' } });
    if (r.status === 429) { rcDown = Date.now() + 30000; rcQueue.unshift(addr); }
    else if (r.ok) {
      const j = await r.json(); const th = j.topHolders || [];
      const top10 = th.slice(0, 10).reduce((s, h) => s + (+h.pct || 0), 0);
      const insider = th.filter(h => h.insider).reduce((s, h) => s + (+h.pct || 0), 0);
      const bundleRisk = (j.risks || []).find(x => /bundle/i.test(x.name || '') || /bundle/i.test(x.description || ''));
      const bundled = bundleRisk ? (parseFloat(String(bundleRisk.value || '').replace(/[^0-9.]/g, '')) || null) : (j.graphInsidersDetected ? insider : 0);
      rc[addr] = { at: Date.now(), holders: j.totalHolders ?? null, top10: th.length ? top10 : null, insider: th.length ? insider : null, bundled, mint: j.mintAuthority ? 'active' : 'revoked', freeze: j.freezeAuthority ? 'active' : 'revoked', creator: j.creator || null, creatorTokens: Array.isArray(j.creatorTokens) ? j.creatorTokens.length : null, rugged: !!j.rugged, score: j.score_normalised ?? j.score ?? null, risks: (j.risks || []).map(x => x.name).slice(0, 4) };
      rcSave();
    } else rc[addr] = { at: Date.now(), unavailable: true };
  } catch { rc[addr] = { at: Date.now() - 1500e3, unavailable: true }; rcDown = Date.now() + 60000; }   // CORS or network: back off, retry later
  rcBusy = false; setTimeout(rcPump, 1200); if ($('v-screen')?.classList.contains('on')) render();
}

// ---------- derived columns ----------
export function row(t){
  const r = rc[t.addr] || {}; const b5 = t.buys5 || 0, s5 = t.sells5 || 0, b1 = t.buys || 0, s1 = t.sells || 0;
  const ratio = s1 ? b1 / s1 : (b1 ? 9.99 : null);
  const whales = (t.whales || []).filter(w => Date.now() - w.at < 600e3);
  const social = Math.min(100, Math.round((t.boosts || 0) * 8 + (t.socials || 0) * 15 + Math.min(40, (t.vol1 || 0) / Math.max(t.liq || 1, 1) * 40) + Math.max(0, Math.min(20, (t.ch1 || 0) / 2))));
  return { t, age: ageMin(t), mcap: t.mcap, liq: t.liq, vol5: t.vol5, vol1: t.vol1, ratio, holders: r.holders ?? null, top10: r.top10 ?? null, insider: r.insider ?? null, bundled: r.bundled ?? null, mint: r.mint || null, freeze: r.freeze || null, creator: r.creator || null, creatorTokens: r.creatorTokens ?? null, rugged: r.rugged, whales: whales.length, whaleUsd: whales.reduce((s, w) => s + w.usd, 0), social, grade: t.grade?.g || '—', rcPending: !r.at };
}

// ---------- screens (filters) ----------
export const FIELDS = [
  ['mcap', 'Market cap $', 'money'], ['liq', 'Liquidity $', 'money'], ['age', 'Age (minutes)', 'num'], ['vol5', '5m volume $', 'money'], ['vol1', '1h volume $', 'money'],
  ['ratio', 'Buy/sell ratio', 'num'], ['holders', 'Holders', 'num'], ['top10', 'Top-10 ownership %', 'num'], ['insider', 'Insider %', 'num'], ['bundled', 'Bundled supply %', 'num'], ['whales', 'Whale trades (10m)', 'num'], ['social', 'Social momentum 0-100', 'num'], ['creatorTokens', 'Creator previous tokens', 'num'],
];
export const PRESETS = [
  { id: 'p-fresh', name: 'Fresh & clean', f: { mcap: [250000, 5000000], liq: [100000, null], age: [null, 1440], vol1: [500000, null], top10: [null, 20], bundled: [null, 10], mint: 'revoked', creatorTokens: [null, 0] } },
  { id: 'p-momentum', name: 'Momentum', f: { vol5: [50000, null], ratio: [1.5, null], social: [40, null], liq: [25000, null] } },
  { id: 'p-safe', name: 'Safer large caps', f: { mcap: [1000000, null], liq: [250000, null], age: [1440, null], top10: [null, 25], mint: 'revoked' } },
];
function matches(r, f){
  for (const k in f) { const c = f[k]; if (c == null) continue;
    if (k === 'mint' || k === 'freeze') { if (c && c !== 'any' && r[k] !== c) return false; continue; }
    const [lo, hi] = c; const v = r[k]; if (lo == null && hi == null) continue;
    if (v == null) return false;                                        // unknown never passes a numeric condition
    if (lo != null && v < lo) return false; if (hi != null && v > hi) return false; }
  return true;
}
let active = { name: 'All tokens', f: {} }, sortKey = 'vol1', sortDir = -1, editing = false;
let screens = [];                                                       // saved: { id, name, f, alerts }
const alerted = {};                                                     // screen id -> Set(addr) already announced
function saved(){ return screens; }

// ---------- alerts: "tell me when a coin meets these conditions" ----------
export function evaluateAlerts(){
  const rows = H.tokens().map(row);
  for (const s of screens) { if (!s.alerts) continue; alerted[s.id] ||= new Set();
    for (const r of rows) { if (!matches(r, s.f)) continue; if (alerted[s.id].has(r.t.addr)) continue; alerted[s.id].add(r.t.addr);
      if (alerted[s.id].size > 3 || Date.now() - startedAt > 90000) H.fireAlert('screen', r.t, `${r.t.sym} matches your screen "${s.name}" · ${fmtK(r.mcap)} mcap · ${fmtK(r.liq)} liq`); } }
}
const startedAt = Date.now();

// ---------- rendering ----------
const COLS = [
  ['sym', 'Ticker', r => `<b>${esc(r.t.sym)}</b><span class="scr-name">${esc((r.t.name || '').slice(0, 18))}</span>`, 'left'],
  ['grade', 'Grade', r => `<span class="g" style="background:var(--${r.grade})">${r.grade}</span>`],
  ['age', 'Age', r => ageTxt(r.age)], ['mcap', 'Mkt cap', r => fmtK(r.mcap)], ['liq', 'Liquidity', r => fmtK(r.liq)],
  ['vol5', '5m vol', r => fmtK(r.vol5)], ['vol1', '1h vol', r => fmtK(r.vol1)],
  ['ratio', 'Buy/sell', r => r.ratio == null ? '—' : `<span class="${r.ratio >= 1 ? 'up' : 'dn'}">${r.ratio.toFixed(2)}</span>`],
  ['holders', 'Holders', r => fmtN(r.holders)], ['top10', 'Top-10', r => r.top10 == null ? '—' : `<span class="${r.top10 > 30 ? 'dn' : ''}">${pc(r.top10)}</span>`],
  ['insider', 'Insider', r => r.insider == null ? '—' : `<span class="${r.insider > 10 ? 'dn' : ''}">${pc(r.insider)}</span>`],
  ['bundled', 'Bundled', r => r.bundled == null ? '—' : pc(r.bundled)],
  ['mint', 'Mint', r => r.mint ? `<span class="${r.mint === 'revoked' ? 'up' : 'dn'}">${r.mint}</span>` : '—'],
  ['creatorTokens', 'Dev history', r => r.creator ? `<span title="${esc(r.creator)}">${r.creatorTokens == null ? '' : r.creatorTokens + ' prior'}${r.rugged ? ' <span class="dn">rugged</span>' : ''}${r.creatorTokens == null && !r.rugged ? 'known' : ''}</span>` : '—'],
  ['whales', 'Whales', r => r.whales ? `<span class="up">${r.whales} · ${fmtK(r.whaleUsd)}</span>` : '0'],
  ['social', 'Social', r => `<span class="scr-bar"><i style="width:${r.social}%"></i></span>${r.social}`],
];
export function render(){
  const host = $('screenTable'); if (!host) return;
  H.tokens().forEach(t => rcWant(t.addr)); const all = H.tokens().map(row);
  const rows = all.filter(r => matches(r, active.f)).sort((a, b) => { const x = a[sortKey], y = b[sortKey]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
  const pending = all.filter(r => r.rcPending).length;
  $('screenMeta').innerHTML = `<b>${rows.length}</b> of ${all.length} tokens match <b>${esc(active.name)}</b>${pending ? ` · holder data loading for ${pending}` : ''}`;
  host.innerHTML = `<table class="scr"><thead><tr>${COLS.map(([k, l, , al]) => `<th class="${al || ''} ${sortKey === k ? 'on' : ''}" data-sort="${k}" role="button" tabindex="0" aria-sort="${sortKey === k ? (sortDir < 0 ? 'descending' : 'ascending') : 'none'}">${l}${sortKey === k ? (sortDir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr data-a="${esc(r.t.addr)}" tabindex="0">${COLS.map(([k, , f, al]) => `<td class="${al || 'num'}">${f(r)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${COLS.length}" class="empty">Nothing matches. Loosen a condition.</td></tr>`}</tbody></table>`;
  host.querySelectorAll('th[data-sort]').forEach(th => { const go = () => { const k = th.dataset.sort; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; } render(); }; th.onclick = go; th.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; });
  host.querySelectorAll('tr[data-a]').forEach(tr => { const go = () => { const t = H.tokens().find(x => x.addr === tr.dataset.a); if (t) H.select(t); }; tr.onclick = go; tr.onkeydown = e => { if (e.key === 'Enter') go(); }; });
  renderChips();
}
function renderChips(){
  const el = $('screenChips'); if (!el) return;
  const chip = (s, kind) => `<button type="button" class="chip ${active.name === s.name ? 'on' : ''}" data-${kind}="${esc(s.id)}">${esc(s.name)}${s.alerts ? ' 🔔' : ''}</button>`;
  el.innerHTML = `<button type="button" class="chip ${active.name === 'All tokens' ? 'on' : ''}" data-all="1">All tokens</button>` + PRESETS.map(s => chip(s, 'preset')).join('') + screens.map(s => chip(s, 'saved')).join('') + `<button type="button" class="chip new" id="screenNew">+ New screen</button>`;
  el.querySelector('[data-all]').onclick = () => { active = { name: 'All tokens', f: {} }; render(); };
  el.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { active = PRESETS.find(s => s.id === b.dataset.preset); render(); });
  el.querySelectorAll('[data-saved]').forEach(b => b.onclick = () => { active = screens.find(s => s.id === b.dataset.saved); render(); });
  $('screenNew').onclick = () => openEditor(null);
  const ed = $('screenEdit'); if (ed) ed.onclick = () => openEditor(active.id ? active : { ...active, id: null, name: active.name === 'All tokens' ? '' : active.name + ' copy' });
}
function openEditor(s){
  const m = $('screenModal'); if (!m) return; const f = s?.f || {}; const own = s && screens.find(x => x.id === s.id);
  $('scrName').value = s?.name || ''; $('scrAlerts').checked = !!s?.alerts;
  $('scrFields').innerHTML = FIELDS.map(([k, label]) => `<div class="scr-f"><label>${label}</label><input type="number" inputmode="decimal" data-k="${k}" data-side="0" placeholder="min" value="${f[k]?.[0] ?? ''}"><input type="number" inputmode="decimal" data-k="${k}" data-side="1" placeholder="max" value="${f[k]?.[1] ?? ''}"></div>`).join('')
    + `<div class="scr-f"><label>Mint authority</label><select id="scrMint"><option value="any">Any</option><option value="revoked" ${f.mint === 'revoked' ? 'selected' : ''}>Revoked</option><option value="active" ${f.mint === 'active' ? 'selected' : ''}>Active</option></select><span class="hint">revoked = no one can print more</span></div>`;
  $('scrDelete').style.display = own ? '' : 'none';
  const read = () => { const out = {}; $('scrFields').querySelectorAll('input[data-k]').forEach(i => { const k = i.dataset.k, v = i.value === '' ? null : +i.value; out[k] ||= [null, null]; out[k][+i.dataset.side] = v; }); for (const k in out) if (out[k][0] == null && out[k][1] == null) delete out[k]; const mint = $('scrMint').value; if (mint !== 'any') out.mint = mint; return out; };
  const preview = () => { const n = H.tokens().map(row).filter(r => matches(r, read())).length; $('scrPreview').textContent = n + ' token' + (n === 1 ? '' : 's') + ' match right now'; };
  $('scrFields').oninput = preview; preview();
  $('scrApply').onclick = () => { active = { name: $('scrName').value.trim() || 'Custom', f: read() }; m.style.display = 'none'; render(); };
  $('scrSave').onclick = async () => { const name = $('scrName').value.trim(); if (!name) { $('scrName').focus(); return H.toast('Name the screen'); } const rec = { id: own ? own.id : 's' + Date.now().toString(36), name, f: read(), alerts: $('scrAlerts').checked }; if (own) Object.assign(own, rec); else screens.push(rec); active = rec; m.style.display = 'none'; H.saveScreens(screens); render(); H.toast((rec.alerts ? 'Saved with alerts on' : 'Saved') + ' · ' + name); };
  $('scrDelete').onclick = () => { if (!own || !confirm('Delete "' + own.name + '"?')) return; screens = screens.filter(x => x !== own); active = { name: 'All tokens', f: {} }; m.style.display = 'none'; H.saveScreens(screens); render(); };
  m.style.display = 'flex'; setTimeout(() => $('scrName').focus(), 50);
}
export function setScreens(list){ screens = Array.isArray(list) ? list : []; }
export function getScreens(){ return screens; }
export function init(hooks){ H = hooks; const m = $('screenModal'); if (m) { m.onclick = e => { if (e.target === m) m.style.display = 'none'; }; $('scrClose').onclick = () => { m.style.display = 'none'; }; } document.addEventListener('keydown', e => { if (e.key === 'Escape' && m && m.style.display !== 'none') m.style.display = 'none'; }); }
