// ============================================================
// MemeScreen — live price feed for the selected token, straight from the chain.
// DexScreener's price field refreshes slowly (often 10–60 s behind) and PumpPortal's trade stream is now
// metered, so the chart was only moving when DexScreener did. This module watches the token's pool on
// Solana itself through the public RPC: every swap changes the pool's reserves, and reserves give the price.
//   pump.fun bonding curve  → the curve account's virtual reserves
//   PumpSwap pool           → the pool's two token accounts (owned by the pool)
//   Raydium AMM v4          → the pool's base and quote vaults (from the pool layout)
//   anything else           → DexScreener polling (unchanged)
// Push first (accountSubscribe over the RPC WebSocket), polling every 1.5 s as the fallback. No key needed.
// ============================================================
import CONFIG from './config.js';
// Order matters: the Solana Labs endpoint answers browsers with 403, publicnode allows plain (non-indexed) reads and
// WebSocket subscriptions from a browser. A Helius key in config.js goes first when present.
const HTTP = [CONFIG.rpcUrl, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const WSS  = [CONFIG.wsUrl, 'wss://solana-rpc.publicnode.com', 'wss://api.mainnet-beta.solana.com'].filter(Boolean);
const POLL_MS = CONFIG.rpcUrl ? 1000 : 1500;
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let cur = null, lastAddr = null;   // cur: { token, mode, accounts:[], price(fn) }
let ws = null, wsOK = false, subs = {}, pollT = null, lastPush = 0, solUsd = () => 0, onPrice = () => {};
export let status = '';    // shown under the chart
export const active = () => !!cur;
export const current = () => lastAddr;   // address start() was last called for (even if the pool turned out unsupported)
export const fresh = (ms = 10000) => cur && Date.now() - lastPush < ms;

export function init({ sol, price }){ solUsd = sol; onPrice = price; }

async function rpc(method, params){
  let last;
  for (const url of HTTP) { try { const r = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { last = e; } }
  throw last;
}
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const u64 = (b, o) => Number(new DataView(b.buffer, b.byteOffset).getBigUint64(o, true));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function toB58(bytes){ const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let s = ''; for (const b of bytes) { if (b) break; s += '1'; } for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]]; return s; }

// ---------- working out where the price lives for this token ----------
// The pool account's owner program says which DEX it is; the vault addresses sit at fixed offsets in the account.
// Offsets were checked against live pools on 2026-10-15. All reads are plain getAccountInfo / getMultipleAccounts,
// which public RPCs allow from a browser (getTokenAccountsByOwner is "indexed" and they refuse it).
const PROG = {
  pumpfun:  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  cpmm:     'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  ammv4:    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
};
const key = (b, o) => toB58(b.slice(o, o + 32));
const quotePx = {};   // USD price of a non-SOL quote token (ZEC, USDT…), from DexScreener, refreshed every minute
async function quoteUsd(mint){
  if (mint === SOL) return solUsd(); if (mint === USDC) return 1;
  const c = quotePx[mint]; if (c && Date.now() - c.at < 60000) return c.px;
  try { const r = await (await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mint)).json(); const best = r.filter(q => +q.priceUsd).sort((x, y) => (y.liquidity?.usd||0) - (x.liquidity?.usd||0))[0]; quotePx[mint] = { at: Date.now(), px: +best?.priceUsd || 0 }; } catch { quotePx[mint] = { at: Date.now(), px: c?.px || 0 }; }
  return quotePx[mint].px;
}
async function resolve(t){
  const quote = t.quote || SOL; await quoteUsd(quote); const qUsd = () => quote === SOL ? solUsd() : quote === USDC ? 1 : (quotePx[quote]?.px || 0);
  if (quote !== SOL && quote !== USDC) { const tq = setInterval(() => { if (cur?.token === t) quoteUsd(quote); else clearInterval(tq); }, 60000); }
  const a = await rpc('getAccountInfo', [t.pair, { encoding:'base64' }]); const data = a?.value?.data?.[0]; if (!data) throw new Error('pool account not found');
  const b = b64(data), owner = a.value.owner;
  // 1) pump.fun bonding curve: virtual reserves live in the curve account itself
  if (owner === PROG.pumpfun) {
    return { mode:'bonding curve', accounts:[t.pair], enc:'base64', price: vals => { const c = b64(vals[t.pair]); if (c.length < 24) return 0; const vt = u64(c, 8) / 1e6, vs = u64(c, 16) / 1e9; return vt ? (vs / vt) * solUsd() : 0; } };
  }
  let bv, qv, mode;
  if (owner === PROG.pumpswap && b.length >= 203) { const m0 = key(b, 43); bv = key(b, 139); qv = key(b, 171); if (m0 !== t.addr) [bv, qv] = [qv, bv]; mode = 'PumpSwap vaults'; }
  else if (owner === PROG.cpmm && b.length >= 232) { const m0 = key(b, 168); bv = key(b, 72); qv = key(b, 104); if (m0 !== t.addr) [bv, qv] = [qv, bv]; mode = 'Raydium CPMM vaults'; }
  else if (owner === PROG.ammv4 && b.length === 752) { const m0 = key(b, 400); bv = key(b, 336); qv = key(b, 368); if (m0 !== t.addr) [bv, qv] = [qv, bv]; mode = 'Raydium v4 vaults'; }
  if (!(bv && qv)) throw new Error('pool type not supported');
  const g = v => +(v?.parsed?.info?.tokenAmount?.uiAmount || 0);
  return { mode, accounts:[bv, qv], enc:'jsonParsed', price: vals => { const base = g(vals[bv]), q = g(vals[qv]); return base ? (q / base) * qUsd() : 0; } };
}

// ---------- start / stop ----------
export async function start(t){
  stop(); lastAddr = t?.addr || null;
  if (!t || !t.pair || String(t.pair).startsWith('sim')) { status = ''; return; }
  const my = { token: t, vals: {} }; cur = my; status = 'resolving pool…';
  try { Object.assign(my, await resolve(t)); } catch (e) { if (cur === my) { cur = null; status = 'DexScreener quotes (pool type not supported)'; } return; }
  if (cur !== my) return;
  status = 'on-chain · ' + my.mode + ' · polling';
  await poll(my); pollT = setInterval(() => poll(my), POLL_MS);
  subscribe(my);
}
export function stop(){ cur = null; clearInterval(pollT); pollT = null; for (const id of Object.keys(subs)) { try { ws?.send(JSON.stringify({ jsonrpc:'2.0', id:9, method:'accountUnsubscribe', params:[+id] })); } catch {} } subs = {}; status = ''; }

async function poll(my){
  if (cur !== my) return;
  try {
    const r = await rpc('getMultipleAccounts', [my.accounts, { encoding: my.enc }]);
    (r?.value || []).forEach((v, i) => { if (v) my.vals[my.accounts[i]] = my.enc === 'base64' ? v.data[0] : v.data; });
    emit(my);
  } catch {}
}
function emit(my){ if (cur !== my) return; const px = my.price(my.vals); if (px > 0 && isFinite(px)) { lastPush = Date.now(); onPrice(my.token, px); } }

// push: one WebSocket, one accountSubscribe per account; notifications carry the full account data
function subscribe(my){
  let i = 0;
  const open = () => {
    if (cur !== my) return; const url = WSS[i++ % WSS.length];
    try { ws = new WebSocket(url); } catch { return; }
    ws.onopen = () => { if (cur !== my) return ws.close(); wsOK = true; my.accounts.forEach((acc, n) => ws.send(JSON.stringify({ jsonrpc:'2.0', id: n + 1, method:'accountSubscribe', params:[acc, { encoding: my.enc, commitment:'processed' }] }))); };
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && typeof m.result === 'number') { subs[m.result] = my.accounts[m.id - 1]; status = 'on-chain · ' + my.mode + ' · live'; return; }
      if (m.method === 'accountNotification') { const acc = subs[m.params.subscription]; const v = m.params.result?.value; if (!acc || !v) return; my.vals[acc] = my.enc === 'base64' ? v.data[0] : v.data; emit(my); if (pollT) { clearInterval(pollT); pollT = setInterval(() => poll(my), 15000); } } };
    ws.onclose = () => { wsOK = false; subs = {}; if (cur === my) { status = 'on-chain · ' + my.mode + ' · polling'; if (pollT) { clearInterval(pollT); pollT = setInterval(() => poll(my), POLL_MS); } if (i < WSS.length * 2) setTimeout(open, 3000); } };
    ws.onerror = () => {};
  };
  open();
}
