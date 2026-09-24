// ============================================================
// MemeScreen — Phantom wallet, read-only.
// Connects to Phantom (browser extension on desktop, Phantom's in-app browser on a phone),
// reads the wallet's real SOL and token holdings from the Solana RPC, prices them with
// DexScreener and grades them with the same rug-risk grade as the paper terminal.
// Nothing here signs a transaction. Orders in MemeScreen stay paper.
// ============================================================
const $ = id => document.getElementById(id);
const RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com', 'https://rpc.ankr.com/solana'];
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

let H = {};                      // hooks from app.js: grade, mapPair, fetchPairs, toast, select, fmt, fmtP, fmtK, savePrefs, brokerLabel
let pub = null;                  // connected public key (base58 string)
let holdings = [];               // [{ mint, sym, name, amount, price, value, liq, mcap, g, token }]
let sol = 0, solUsd = 0, lastAt = 0, timer = null, busy = false, err = '';

export const provider = () => (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null);
export const isMobile = () => /iPhone|iPad|Android/i.test(navigator.userAgent);
export const inPhantomBrowser = () => !!provider() && isMobile();
export const connected = () => !!pub;
export const address = () => pub;
export const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
// on a phone with no injected provider the site has to be opened inside Phantom's own browser
export const phantomOpenUrl = () => 'https://phantom.app/ul/browse/' + encodeURIComponent(location.href.split('#')[0]) + '?ref=' + encodeURIComponent(location.origin);

async function rpc(method, params){
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('No Solana RPC reachable');
}

export async function connect({ silent = false } = {}){
  const p = provider();
  if (!p) { if (isMobile()) H.openExternal?.(phantomOpenUrl()); else window.open('https://phantom.app/download', '_blank', 'noopener'); throw new Error(isMobile() ? 'Opening Phantom…' : 'Phantom is not installed in this browser'); }
  const r = await p.connect(silent ? { onlyIfTrusted: true } : undefined);
  pub = (r?.publicKey || p.publicKey)?.toString(); if (!pub) throw new Error('Phantom did not return an address');
  p.on?.('accountChanged', k => { pub = k ? k.toString() : null; if (pub) refresh(); else disconnect(false); });
  p.on?.('disconnect', () => disconnect(false));
  H.savePrefs?.(); schedule(); await refresh();
  return pub;
}
export async function disconnect(tellPhantom = true){
  if (tellPhantom) { try { await provider()?.disconnect(); } catch {} }
  pub = null; holdings = []; sol = 0; err = ''; clearTimeout(timer); timer = null; H.savePrefs?.(); render();
}
function schedule(){ clearTimeout(timer); timer = setTimeout(() => { refresh(); }, 60000); }

// prefs: the address is remembered on the account so the wallet card shows up on every device; Phantom itself still has to approve each browser once
export function prefs(){ return pub ? { pub } : null; }
export async function applyPrefs(w){ if (w?.pub && !pub) { pub = w.pub; try { await connect({ silent: true }); } catch { /* not approved in this browser yet: show the card from the address alone */ schedule(); refresh(); } } }

export async function refresh(){
  if (!pub || busy) return; busy = true; err = '';
  try {
    const [bal, a1, a2] = await Promise.all([
      rpc('getBalance', [pub]),
      rpc('getTokenAccountsByOwner', [pub, { programId: TOKEN }, { encoding:'jsonParsed' }]),
      rpc('getTokenAccountsByOwner', [pub, { programId: TOKEN22 }, { encoding:'jsonParsed' }]).catch(() => ({ value: [] })),
    ]);
    sol = (bal?.value ?? bal ?? 0) / 1e9;
    const accts = [...(a1?.value || []), ...(a2?.value || [])].map(x => x.account?.data?.parsed?.info).filter(Boolean)
      .map(i => ({ mint: i.mint, amount: +(i.tokenAmount?.uiAmount || 0) })).filter(x => x.amount > 0);
    // merge duplicate mints (several token accounts for one mint)
    const byMint = {}; for (const a of accts) byMint[a.mint] = (byMint[a.mint] || 0) + a.amount;
    const mints = Object.keys(byMint);
    const priced = [];
    for (let i = 0; i < mints.length; i += 30) { try { priced.push(...await H.fetchPairs(mints.slice(i, i + 30))); } catch {} }
    const pm = {}; for (const t of priced) pm[t.addr] = t;
    solUsd = H.solUsd?.() || solUsd;
    holdings = mints.map(m => { const t = pm[m]; const price = t ? t.price : 0; return { mint: m, sym: t ? t.sym : m.slice(0, 4) + '…', name: t ? t.name : 'Unknown token', amount: byMint[m], price, value: byMint[m] * price, liq: t?.liq || 0, mcap: t?.mcap || 0, g: t ? H.grade(t).g : null, token: t || null }; })
      .sort((a, b) => b.value - a.value);
    lastAt = Date.now();
  } catch (e) { err = e.message || 'Could not read the wallet'; }
  busy = false; render(); if (pub) schedule();
}

export function total(){ return sol * solUsd + holdings.reduce((s, h) => s + h.value, 0); }

// ---------- UI ----------
export function render(){
  const btn = $('brokerBtn'); if (btn) btn.textContent = pub ? 'Phantom ' + short(pub) : 'Broker';
  const el = $('walletCard'); if (!el) return;
  if (!pub) { el.style.display = 'none'; return; }
  el.style.display = '';
  const fmt = H.fmt, fmtP = H.fmtP, fmtK = H.fmtK;
  const rows = holdings.map((h, i) => `<tr class="wrow" data-i="${i}" ${h.token ? 'tabindex="0" role="button"' : ''}>
      <td><b>${esc(h.sym)}</b><div class="hint">${esc(h.name)}</div></td>
      <td class="num">${h.amount.toLocaleString(undefined, { maximumFractionDigits: h.amount < 1 ? 6 : 2 })}</td>
      <td class="num">${h.price ? fmtP(h.price) : '—'}</td>
      <td class="num">${h.price ? fmt(h.value) : '—'}</td>
      <td class="num">${h.liq ? fmtK(h.liq) : '—'}</td>
      <td>${h.g ? H.gBadge(h.g) : '<span class="hint">no pair</span>'}</td>
      <td>${h.token ? '<button class="mini" data-chart="' + i + '">Chart</button>' : ''}</td></tr>`).join('');
  el.innerHTML = `<div class="whead"><div><h2>Phantom wallet <span class="wtag">real · read-only</span></h2>
      <div class="hint">${esc(pub)} · ${lastAt ? 'updated ' + new Date(lastAt).toLocaleTimeString() : 'reading…'}${err ? ' · <span class="warn">' + esc(err) + '</span>' : ''}</div></div>
      <div class="wbtns"><button class="mini" id="wRefresh" ${busy ? 'disabled' : ''}>${busy ? 'Reading…' : 'Refresh'}</button><button class="mini" id="wDisc">Disconnect</button></div></div>
    <div class="kpis">
      <div>SOL<b>◎${sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</b>${solUsd ? fmt(sol * solUsd) : ''}</div>
      <div>Tokens<b>${holdings.length}</b></div>
      <div>Wallet value<b>${fmt(total())}</b>at DexScreener prices</div></div>
    ${holdings.length ? `<div class="tblwrap"><table><thead><tr><th>Token</th><th class="num">Amount</th><th class="num">Price</th><th class="num">Value</th><th class="num">Liquidity</th><th>Grade</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="hint">No tokens in this wallet. SOL only.</div>'}
    <div class="hint" style="margin-top:8px">Read-only. MemeScreen never asks Phantom to sign anything; every order in the app is still paper. Values come from DexScreener and can differ from Phantom\'s own.</div>`;
  $('wRefresh').onclick = () => refresh();
  $('wDisc').onclick = () => disconnect(true);
  el.querySelectorAll('[data-chart]').forEach(b => b.onclick = e => { e.stopPropagation(); H.select(holdings[+b.dataset.chart].token); });
  el.querySelectorAll('tr.wrow[tabindex]').forEach(r => { const go = () => H.select(holdings[+r.dataset.i].token); r.onclick = go; r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; });
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

// ---------- broker window: Phantom card states ----------
export function brokerCard(){
  if (pub) return { state:'connected', label:'Connected · ' + short(pub) };
  if (provider()) return { state:'ready', label:'Connect' };
  if (isMobile()) return { state:'open', label:'Open in Phantom' };
  return { state:'install', label:'Install Phantom' };
}
export async function brokerClick(){
  const c = brokerCard();
  if (c.state === 'connected') return 'Phantom is connected. Holdings are on the Portfolio page. Orders stay paper.';
  if (c.state === 'open') { H.openExternal?.(phantomOpenUrl()); return 'Opening this page inside the Phantom app. Tap Connect there.'; }
  if (c.state === 'install') { window.open('https://phantom.app/download', '_blank', 'noopener'); return 'Install the Phantom extension, then come back and press Connect.'; }
  const a = await connect(); H.toast?.('Phantom connected · ' + short(a)); return 'Connected ' + short(a) + '. Your real holdings are on the Portfolio page, read-only.';
}

export function init(hooks){ H = hooks; render(); }
