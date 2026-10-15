// ============================================================
// MemeScreen — live orders through Jupiter, signed by Phantom.
// Quote → swap transaction → Phantom signs. By default the signed transaction is NOT broadcast
// ("test mode"): the whole flow runs for real, Phantom shows and signs the real transaction, nothing moves.
// Ticking "Send for real" broadcasts it. Nothing here touches the paper accounts.
// ============================================================
import CONFIG from './config.js';
const SOL = 'So11111111111111111111111111111111111111112';
const LITE = 'https://lite-api.jup.ag/swap/v1', PRO = 'https://api.jup.ag/swap/v1';
const WEB3 = 'https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js';

export const SOL_MINT = SOL;
export const testMode = () => !window.__msSendForReal;        // flipped by the ticket checkbox

async function jup(path, opts = {}){
  const key = CONFIG.jupiterKey || '';
  const hosts = key ? [[PRO, { 'x-api-key': key }], [LITE, {}]] : [[LITE, {}]];
  let last;
  for (const [h, hd] of hosts) {
    try {
      const r = await fetch(h + path, { ...opts, headers: { 'content-type': 'application/json', ...hd, ...(opts.headers || {}) } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || ('Jupiter ' + r.status));
      return j;
    } catch (e) { last = e; }
  }
  throw last || new Error('Jupiter unreachable');
}

// amount is in base units of inputMint (lamports for SOL)
export async function quote({ inputMint, outputMint, amount, slippageBps = 150 }){
  const q = await jup(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amount)}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
  if (!q.outAmount) throw new Error(q.error || 'No route for this size');
  return q;   // { inAmount, outAmount, priceImpactPct, routePlan[], slippageBps, ... }
}
export async function buildSwap(quoteResponse, userPublicKey){
  const j = await jup('/swap', { method: 'POST', body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2000000, priorityLevel: 'high' } } }) });
  if (!j.swapTransaction) throw new Error(j.error || 'Jupiter did not return a transaction');
  return j.swapTransaction;   // base64 VersionedTransaction
}

// ---------- signing ----------
let web3p = null;
function web3(){ if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3); if (!web3p) web3p = new Promise((res, rej) => { const s = document.createElement('script'); s.src = WEB3; s.onload = () => res(window.solanaWeb3); s.onerror = () => rej(new Error('Could not load the Solana library')); document.head.appendChild(s); }); return web3p; }
const b64toBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fromB58(s){ const bytes = [0]; for (const ch of s) { let c = B58.indexOf(ch); if (c < 0) throw new Error('bad base58'); for (let i = 0; i < bytes.length; i++) { c += bytes[i] * 58; bytes[i] = c & 0xff; c >>= 8; } while (c) { bytes.push(c & 0xff); c >>= 8; } } for (const ch of s) { if (ch !== '1') break; bytes.push(0); } return Uint8Array.from(bytes.reverse()); }
const bytesToB64 = b => btoa(String.fromCharCode(...b));
const RPC_LIST = () => [CONFIG.rpcUrl, 'https://solana-rpc.publicnode.com', 'https://solana.leorpc.com/?api_key=FREE', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
// Phantom's deep link only signs (signAndSendTransaction is deprecated): the app broadcasts the signed bytes itself
export async function broadcast(signedB58, backendRpc){
  const bytes = fromB58(signedB58); if (bytes.length < 65 || bytes.slice(1, 65).every(b => b === 0)) throw new Error('Phantom returned an unsigned transaction; nothing was sent');
  const b64 = bytesToB64(bytes); const fails = [];
  for (const url of RPC_LIST()) {
    try { const r = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'sendTransaction', params:[b64, { encoding:'base64', skipPreflight:false, maxRetries:3 }] }) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); if (j.result && !/^1+$/.test(j.result)) return j.result; throw new Error('RPC accepted it without a real signature'); } catch (e) { fails.push(url.replace(/^https?:\/\//, '').split('/')[0] + ': ' + e.message); }
  }
  if (backendRpc) { try { return await backendRpc('sendTransaction', [b64, { encoding:'base64', skipPreflight:false, maxRetries:3 }]); } catch (e) { fails.push('backend: ' + e.message); } }
  throw new Error('Signed, but could not broadcast: ' + fails.join(' · '));
}
// after sendTransaction: wait for the network to confirm (or reject) it, so "Sent" means it really landed
export async function confirm(sig, backendRpc, { timeoutMs = 60000 } = {}){
  const t0 = Date.now(); let lastErr = '';
  const ask = async () => {
    const body = JSON.stringify({ jsonrpc:'2.0', id:1, method:'getSignatureStatuses', params:[[sig], { searchTransactionHistory: true }] });
    for (const url of RPC_LIST()) { try { const r = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body }); const j = await r.json(); if (j.result) return j.result.value?.[0] || null; } catch (e) { lastErr = e.message; } }
    if (backendRpc) { try { const v = await backendRpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]); return v?.value?.[0] || null; } catch (e) { lastErr = e.message; } }
    throw new Error(lastErr || 'no RPC');
  };
  while (Date.now() - t0 < timeoutMs) {
    try { const st = await ask(); if (st) { if (st.err) return { ok: false, status: 'failed', detail: JSON.stringify(st.err) }; if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { ok: true, status: st.confirmationStatus }; } } catch {}
    await new Promise(r => setTimeout(r, 2500));
  }
  return { ok: false, status: 'unknown', detail: 'not confirmed within ' + Math.round(timeoutMs/1000) + 's (it may have expired before it reached the network)' };
}
function toB58(bytes){ const d = [0]; for (const b of bytes) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let s = ''; for (const b of bytes) { if (b) break; s += '1'; } for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]]; return s; }

// returns { signature } when sent, { signed: true } in test mode
export async function signWithPhantom(txB64, { send, backendRpc }){
  const shell = !!window.ReactNativeWebView, prov = (window.phantom && window.phantom.solana) || (window.solana?.isPhantom ? window.solana : null);
  if (shell && !prov) {
    // the Expo shell runs Phantom's deep-link signing and answers with a phone-os message
    return new Promise((res, rej) => {
      const to = setTimeout(() => { window.removeEventListener('message', h); rej(new Error('Phantom did not answer (timed out)')); }, 180000);
      const h = e => { const m = e.data; if (e.origin !== location.origin || m?.source !== 'phone-os' || m.type !== 'wallet-signed') return; clearTimeout(to); window.removeEventListener('message', h);
        if (m.error) return rej(new Error(m.error));
        if (m.signature) return res({ signature: m.signature });
        if (send && m.transaction) return broadcast(m.transaction, backendRpc).then(sig => res({ signature: sig }), rej);   // Phantom signed; we send
        res({ signed: true }); };
      window.addEventListener('message', h);
      window.ReactNativeWebView.postMessage(JSON.stringify({ source: 'memescreen', type: 'ms-wallet-sign', tx: toB58(b64toBytes(txB64)), send: !!send }));
    });
  }
  if (!prov) throw new Error('Phantom is not available in this browser');
  const w3 = await web3();
  const vtx = w3.VersionedTransaction.deserialize(b64toBytes(txB64));
  if (send) { const r = await prov.signAndSendTransaction(vtx); return { signature: r.signature || r }; }
  await prov.signTransaction(vtx); return { signed: true };
}

// token decimals (cached) for turning a quote's base units into a readable amount
const decCache = { [SOL]: 9 };
export async function decimals(mint){
  if (decCache[mint] != null) return decCache[mint];
  for (const url of [CONFIG.rpcUrl, 'https://solana-rpc.publicnode.com', 'https://solana.leorpc.com/?api_key=FREE', 'https://api.mainnet-beta.solana.com'].filter(Boolean)) {
    try { const r = await fetch(url, { method:'POST', headers:{ 'content-type':'application/json' }, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTokenSupply', params:[mint] }) }); const j = await r.json(); const d = j.result?.value?.decimals; if (d != null) { decCache[mint] = d; return d; } } catch {}
  }
  return 6;
}
export const explorer = sig => 'https://solscan.io/tx/' + sig;
