// ============================================================
// MemeScreen exec — the order path.
// placeOrder(userId, { mint, side, solIn | pct, slippageBps, tp, sl, trailPct, source })
//   quote -> swap build -> sign with the user's wallet -> send -> confirm -> record order + position.
// The watcher calls the same function for automatic exits. Nothing here is specific to HTTP.
// ============================================================
import { VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { db, now, id, event } from './db.js';
import { withKeypair } from './keys.js';
import * as chain from './chain.js';
import * as jup from './jupiter.js';
import { push } from './notify.js';

export const FEE_RESERVE = 0.012;      // SOL kept back for network + priority fees and the wrapped-SOL account
const CONFIRM_MS = 60000;

// test hooks: the real send/confirm can be swapped for fakes
export let sendImpl = async (raw) => chain.rpc(c => c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }));
export let statusImpl = async (sig) => chain.rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: true }));
export function setChainImpl({ send, status } = {}){ if (send) sendImpl = send; if (status) statusImpl = status; }

export async function confirm(sig, timeoutMs = CONFIRM_MS){
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const st = (await statusImpl(sig))?.value?.[0]; if (st) { if (st.err) return { ok: false, status: 'failed', detail: JSON.stringify(st.err) }; if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { ok: true, status: st.confirmationStatus }; } } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return { ok: false, status: 'expired', detail: 'not confirmed within ' + Math.round(timeoutMs / 1000) + 's' };
}

export async function getWallet(userId){ return db().get('SELECT * FROM wallets WHERE user_id = ?', [userId]); }
export async function getPosition(userId, mint){ return db().get('SELECT * FROM positions WHERE user_id = ? AND mint = ?', [userId, mint]); }

async function signAndSend(wallet, txB64){
  const raw = await withKeypair(wallet, async kp => { const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64')); tx.sign([kp]); return Buffer.from(tx.serialize()); });
  const sig = await sendImpl(raw);
  return sig;
}

export async function placeOrder(userId, o){
  const { mint, side, slippageBps = 150, source = 'user' } = o;
  if (!mint || !['buy', 'sell'].includes(side)) throw new Error('mint and side (buy|sell) are required');
  const wallet = await getWallet(userId); if (!wallet) throw new Error('No trading wallet yet');
  const oid = id(); const t0 = now();
  const rec = async (fields) => { await db().run(`UPDATE orders SET ${Object.keys(fields).map(k => k + ' = ?').join(', ')} WHERE id = ?`, [...Object.values(fields), oid]); };
  await db().run('INSERT INTO orders (id, user_id, mint, side, status, source, created_at) VALUES (?,?,?,?,?,?,?)', [oid, userId, mint, side, 'quoting', source, t0]);
  try {
    // ---- size ----
    let inputMint, outputMint, amount, solIn = 0, tokenIn = 0, dec = 9;
    const [solPx] = await Promise.all([chain.solPrice()]);
    if (side === 'buy') {
      solIn = +o.solIn; if (!(solIn > 0)) throw new Error('solIn must be > 0');
      const bal = await chain.solBalance(wallet.pubkey);
      if (bal < solIn + FEE_RESERVE) throw new Error(`Wallet has ◎${bal.toFixed(4)}; this order needs ◎${(solIn + FEE_RESERVE).toFixed(4)} including the fee reserve`);
      inputMint = chain.SOL_MINT; outputMint = mint; amount = Math.floor(solIn * LAMPORTS_PER_SOL);
    } else {
      const pct = Math.min(100, Math.max(0.01, +(o.pct ?? 100)));
      const hold = (await chain.tokenBalances(wallet.pubkey)).find(t => t.mint === mint);
      if (!hold) throw new Error('This wallet holds none of that token');
      dec = hold.decimals; tokenIn = hold.amount * pct / 100;
      inputMint = mint; outputMint = chain.SOL_MINT; amount = Math.floor(tokenIn * Math.pow(10, dec));
      const bal = await chain.solBalance(wallet.pubkey); if (bal < 0.003) throw new Error(`Not enough SOL for fees (◎${bal.toFixed(4)})`);
    }
    // ---- quote + build + sign + send, with one retry on an expired blockhash ----
    let q, sig, c;
    for (let attempt = 0; attempt < 2; attempt++) {
      q = await jup.quote({ inputMint, outputMint, amount, slippageBps });
      await rec({ status: 'sent', quote_json: JSON.stringify(q).slice(0, 8000) });
      const txB64 = await jup.buildSwap(q, wallet.pubkey);
      sig = await signAndSend(wallet, txB64);
      await rec({ tx_sig: sig });
      c = await confirm(sig);
      if (c.ok || c.status === 'failed') break;
    }
    if (!c.ok) { await rec({ status: c.status, error: c.detail }); await event(userId, 'order_' + c.status, { oid, mint, side, detail: c.detail }); throw new Error((c.status === 'failed' ? 'Failed on-chain: ' : 'Not confirmed: ') + c.detail); }
    // ---- bookkeeping ----
    const outDec = side === 'buy' ? await chain.decimalsOf(mint).catch(() => 6) : 9;
    const out = +q.outAmount / Math.pow(10, outDec);
    const sym = chain.symbolOf(mint) || o.symbol || '';
    const t1 = now();
    if (side === 'buy') {
      const cost = solIn * solPx, entry = out > 0 ? cost / out : 0;
      const ex = await getPosition(userId, mint);
      if (ex) { const qty = ex.qty + out, costUsd = ex.cost_usd + cost; await db().run('UPDATE positions SET qty = ?, cost_usd = ?, sol_in = ?, entry_px = ?, symbol = ?, armed = 1, hit = NULL, updated_at = ? WHERE user_id = ? AND mint = ?', [qty, costUsd, ex.sol_in + solIn, costUsd / qty, sym, t1, userId, mint]); }
      else await db().run('INSERT INTO positions (user_id, mint, symbol, qty, cost_usd, sol_in, entry_px, armed, opened_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)', [userId, mint, sym, out, cost, solIn, entry, t1, t1]);
      const p = await getPosition(userId, mint);
      const tp = o.tp != null ? +o.tp : null, sl = o.sl != null ? +o.sl : null, trail = o.trailPct != null ? +o.trailPct : null;   // tp/sl are percents of entry
      if (tp != null || sl != null || trail != null) await db().run('UPDATE positions SET tp_px = ?, sl_px = ?, trail_pct = ?, high_px = ?, updated_at = ? WHERE user_id = ? AND mint = ?',
        [tp != null ? p.entry_px * (1 + tp / 100) : p.tp_px, sl != null ? p.entry_px * (1 - sl / 100) : p.sl_px, trail, p.entry_px, t1, userId, mint]);
      await rec({ status: 'confirmed', sol_in: solIn, token_out: out, price_usd: entry, symbol: sym, confirmed_at: t1 });
    } else {
      const solOut = out;
      const ex = await getPosition(userId, mint);
      if (ex) { const frac = Math.min(1, tokenIn / Math.max(ex.qty, 1e-12)); if (frac >= 0.999) await db().run('DELETE FROM positions WHERE user_id = ? AND mint = ?', [userId, mint]); else await db().run('UPDATE positions SET qty = ?, cost_usd = ?, sol_in = ?, updated_at = ? WHERE user_id = ? AND mint = ?', [ex.qty - tokenIn, ex.cost_usd * (1 - frac), ex.sol_in * (1 - frac), t1, userId, mint]); }
      await rec({ status: 'confirmed', token_in: tokenIn, sol_out: solOut, price_usd: tokenIn > 0 ? (solOut * solPx) / tokenIn : 0, symbol: sym, confirmed_at: t1 });
    }
    await event(userId, 'order_confirmed', { oid, mint, side, sig, source });
    if (source === 'user') push(userId, 'MemeScreen · ' + (sym || mint.slice(0, 4)), (side === 'buy' ? 'Bought ' + out.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + sym + ' for ◎' + solIn : 'Sold ' + tokenIn.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + sym + ' for ◎' + out.toFixed(4)), { addr: mint }).catch(() => {});
    return { orderId: oid, sig, status: 'confirmed', out, solIn, tokenIn, symbol: sym };
  } catch (e) {
    const cur = await db().get('SELECT status FROM orders WHERE id = ?', [oid]);
    if (cur && !['failed', 'expired'].includes(cur.status)) await rec({ status: 'failed', error: String(e.message || e).slice(0, 500) });
    throw e;
  }
}

export async function positionsWithPnl(userId){
  const rows = await db().all('SELECT * FROM positions WHERE user_id = ? ORDER BY opened_at DESC', [userId]);
  const px = rows.length ? await chain.prices(rows.map(r => r.mint)) : {};
  return rows.map(r => { const p = px[r.mint] || 0, val = p * r.qty; return { ...r, price: p, value: val, pnl_usd: val - r.cost_usd, pnl_pct: r.cost_usd ? (val - r.cost_usd) / r.cost_usd * 100 : 0, armed: !!r.armed }; });
}
