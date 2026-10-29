// ============================================================
// MemeScreen — the MemeScreen trading wallet (Phase 2).
// A per-user Solana wallet held by the execution service (memescreen/exec). The app never sees the key:
// it sends orders with the user's Back4App session token, and the service signs, sends, confirms and
// watches stop-loss / take-profit 24/7. Same read-side interface as wallet.js (Phantom) so the live
// header, ticket, positions and chart lines work with either.
// ============================================================
import CONFIG from './config.js';
import { session } from './backend.js';
const $ = id => document.getElementById(id);

let H = {};                       // hooks from app.js: toast, fetchPairs, grade, fmt, fmtP, fmtK, gBadge, onChange, solUsd
let pub = null, sol = 0, solUsd = 0, spendable = 0, tokens = [], positions = [], lastAt = 0, busy = false, err = '', timer = null, healthInfo = null;

export function init(h){ H = h; }
export function url(){ let u = ''; try { u = localStorage.getItem('ms_exec_url') || ''; } catch {} return (u || CONFIG.execUrl || '').replace(/\/$/, ''); }
export function setUrl(u){ try { if (u) localStorage.setItem('ms_exec_url', u.trim().replace(/\/$/, '')); else localStorage.removeItem('ms_exec_url'); } catch {} }
export const configured = () => !!url();
export const signedIn = () => !!session.get()?.token;

async function api(path, { method = 'GET', body } = {}){
  const u = url(); if (!u) throw new Error('No execution service URL. Settings → Trading wallet.');
  const s = session.get(); if (!s?.token) throw new Error('Sign in to MemeScreen first');
  let r; try { r = await fetch(u + path, { method, cache: 'no-store', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error('Execution service unreachable (' + u + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('Service error ' + r.status));
  return j;
}

// ---- read side (same names as wallet.js) ----
export const connected = () => !!pub;
export const address = () => pub;
export const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
export const solBalance = () => sol;
export const solPrice = () => solUsd || H.solUsd?.() || 0;
export const spendableSol = () => spendable;
export const list = () => tokens;
export const positionsList = () => positions;
export const error = () => err;
export const reading = () => busy;
export const lastUpdate = () => lastAt;
export function total(){ return sol * solPrice() + tokens.reduce((s, t) => s + (t.value || 0), 0); }
export function positionFor(mint){ return positions.find(p => p.mint === mint) || null; }

export async function health(){ const u = url(); if (!u) return null; try { const r = await fetch(u + '/healthz'); healthInfo = await r.json(); } catch { healthInfo = null; } return healthInfo; }
export const lastHealth = () => healthInfo;

// create (or load) the wallet for the signed-in user
export async function create(){
  err = ''; H.onChange?.();
  try { const w = await api('/v1/wallet', { method: 'POST' }); pub = w.pubkey; await refresh(); schedule(); return pub; }
  catch (e) { err = e.message; H.onChange?.(); throw e; }
}
// forget the wallet on this device only (the server keeps it; create() brings it back)
export function forget(){ pub = null; tokens = []; positions = []; sol = 0; clearTimeout(timer); H.onChange?.(); }

function schedule(){ clearTimeout(timer); timer = setTimeout(() => refresh(), 20000); }
let again = false;
export async function refresh(){
  if (!pub) return; if (busy) { again = true; return; } busy = true; err = '';
  try {
    const [w, ps] = await Promise.all([api('/v1/wallet'), api('/v1/positions')]);
    sol = w.sol || 0; solUsd = w.solUsd || solUsd; spendable = w.spendable || 0;
    const mints = (w.tokens || []).map(t => t.mint);
    let pairs = []; if (mints.length) { try { pairs = await H.fetchPairs(mints); } catch {} }
    const pm = {}; for (const t of pairs) pm[t.addr] = t;
    tokens = (w.tokens || []).map(t => { const tk = pm[t.mint]; const price = tk ? tk.price : (t.price || 0); return { mint: t.mint, dec: t.decimals, sym: tk ? tk.sym : (t.symbol || t.mint.slice(0, 4) + '…'), name: tk ? tk.name : 'Token', amount: t.amount, price, value: t.amount * price, liq: tk?.liq || 0, mcap: tk?.mcap || 0, g: tk ? H.grade(tk).g : null, token: tk || null }; }).sort((a, b) => b.value - a.value);
    positions = ps || [];
    lastAt = Date.now();
  } catch (e) { err = e.message; }
  busy = false; H.onChange?.(); if (pub) schedule();
  if (again) { again = false; return refresh(); }   // a refresh was asked for while this one ran (an order just confirmed): run it now
}

// ---- orders ----
// buy: { mint, solIn, tp, sl, trailPct }   sell: { mint, pct }   (tp/sl/trail are % of entry)
export async function order(o, onStatus){
  onStatus?.('Sending the order to the execution service…');
  const r = await api('/v1/order', { method: 'POST', body: o });
  onStatus?.('Confirmed ' + r.sig.slice(0, 8) + '…');
  refresh(); setTimeout(refresh, 15000);
  return r;
}
export async function setExits({ mint, tp, sl, trailPct }){ const r = await api('/v1/exits', { method: 'POST', body: { mint, tp, sl, trailPct } }); refresh(); return r; }
export async function withdraw({ to, sol: amt, password }){ const r = await api('/v1/withdraw', { method: 'POST', body: { to, sol: amt, password } }); refresh(); setTimeout(refresh, 15000); return r; }
export async function orders(){ return api('/v1/orders'); }
export const explorer = sig => 'https://solscan.io/tx/' + sig;

// ---- UI pieces ----
export function brokerCard(){
  if (!configured()) return { state: 'soon', label: 'Set the service URL in Settings' };
  if (!signedIn()) return { state: 'soon', label: 'Sign in first' };
  if (pub) return { state: 'connected', label: 'Ready · ' + short(pub) + ' · ◎' + sol.toFixed(3) };
  return { state: 'ready', label: 'Create / open' };
}

export function fundingHtml(){
  const a = pub || '';
  return `<p class="hint">Send SOL to your MemeScreen wallet from Phantom (or any wallet). Scan the code with Phantom's scanner, or copy the address and paste it into Send. ◎0.05 is plenty to try it; keep ◎0.012 free for fees.</p>
    <div id="twQr" style="display:inline-block;background:#fff;padding:6px;border-radius:10px;margin:8px 0"></div>
    <div class="num" style="word-break:break-all;font-size:12px;margin:8px 0">${a}</div>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="mini primary" id="twCopy">Copy address</button><button class="mini" id="twOpenPay">Open in wallet app</button><button class="mini" id="twRefresh">Refresh balance</button></div>
    <p class="hint" style="margin-top:10px">Balance: <b>◎${sol.toFixed(4)}</b>${solPrice() ? ' (' + H.fmt(sol * solPrice()) + ')' : ''} · updates every 20 s</p>`;
}
export function wireFunding(box){
  const a = pub; const uri = 'solana:' + a + '?label=MemeScreen%20wallet';
  const qr = box.querySelector('#twQr'); const draw = () => { try { const q = window.qrcode(0, 'M'); q.addData(uri); q.make(); qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2 }); } catch { qr.textContent = a; } };
  if (window.qrcode) draw(); else { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'; sc.onload = draw; sc.onerror = () => { qr.textContent = a; }; document.head.appendChild(sc); }
  box.querySelector('#twCopy').onclick = () => { navigator.clipboard?.writeText(a).then(() => H.toast('Address copied')).catch(() => H.toast(a)); };
  box.querySelector('#twOpenPay').onclick = () => { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ source: 'memescreen', type: 'ms-open-url', url: uri })); else location.href = uri; };
  box.querySelector('#twRefresh').onclick = async () => { await refresh(); H.toast('Balance ◎' + sol.toFixed(4)); const p = box.querySelector('p.hint:last-child'); if (p) p.innerHTML = `Balance: <b>◎${sol.toFixed(4)}</b>${solPrice() ? ' (' + H.fmt(sol * solPrice()) + ')' : ''} · updates every 20 s`; };
}

export function withdrawHtml(defaultTo){
  return `<p class="hint">Send SOL from your MemeScreen wallet back to Phantom. Your password is checked again for every withdrawal; the daily limit is ◎1.</p>
    <label class="field">To address<input id="twTo" class="num" value="${defaultTo || ''}" placeholder="Phantom address" autocomplete="off" spellcheck="false"></label>
    <label class="field">Amount (◎) · available ◎${Math.max(0, sol - 0.00001).toFixed(4)}<input id="twAmt" class="num" type="number" step="0.001" min="0" inputmode="decimal" value="${Math.max(0, Math.floor((sol - 0.001) * 1000) / 1000).toFixed(3)}"></label>
    <label class="field">MemeScreen password<input id="twPw" type="password" autocomplete="current-password"></label>
    <div id="twWdStatus" class="hint" style="min-height:18px"></div>
    <button class="primary" id="twWdGo" style="width:100%">Withdraw</button>`;
}
export function wireWithdraw(box, onDone){
  box.querySelector('#twWdGo').onclick = async () => {
    const st = box.querySelector('#twWdStatus'); const b = box.querySelector('#twWdGo');
    const to = box.querySelector('#twTo').value.trim(), amt = +box.querySelector('#twAmt').value, pw = box.querySelector('#twPw').value;
    if (!to || !(amt > 0) || !pw) { st.textContent = 'Fill in the address, the amount and your password.'; return; }
    b.disabled = true; st.textContent = 'Sending…';
    try { const r = await withdraw({ to, sol: amt, password: pw }); st.innerHTML = `Sent ◎${amt} · <a href="${explorer(r.sig)}" target="_blank" rel="noopener">View on Solscan</a>`; H.toast('Withdrawal confirmed'); onDone?.(r); }
    catch (e) { st.innerHTML = '<span class="warn">' + (e.message || e) + '</span>'; }
    b.disabled = false;
  };
}
