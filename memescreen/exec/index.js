// ============================================================
// MemeScreen exec — HTTP API.
//   POST /v1/wallet            create (or return) the user's trading wallet          { pubkey }
//   GET  /v1/wallet            balance                                              { pubkey, sol, solUsd, tokens[] }
//   POST /v1/order             { mint, side, solIn | pct, slippageBps, tp, sl, trailPct }   -> { orderId, sig, status }
//   POST /v1/exits             { mint, tp, sl, trailPct }  (percent of entry; null clears)   -> { ok, position }
//   GET  /v1/positions         positions with live P&L
//   GET  /v1/orders            last 100 orders
//   POST /v1/withdraw          { to, sol, password }                               -> { sig }
//   GET  /healthz              watcher state
// Every /v1 route needs  Authorization: Bearer <Back4App session token>.
// ============================================================
import express from 'express';
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { open, db, now, id, event } from './db.js';
import { newWallet, withKeypair, safeLog } from './keys.js';
import { requireUser, checkPassword, rateLimit } from './auth.js';
import * as chain from './chain.js';
import { placeOrder, positionsWithPnl, getWallet, getPosition, confirm, sendImpl, FEE_RESERVE } from './order.js';
import * as watcher from './watcher.js';

const app = express();
app.set('etag', false);
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use((req, res, next) => {
  const o = req.headers.origin; const ok = ORIGINS.includes('*') || (o && ORIGINS.includes(o));
  if (ok) res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes('*') ? '*' : o);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use((req, res, next) => { const t = Date.now(); res.on('finish', () => { if (req.path !== '/healthz') safeLog(new Date().toISOString(), req.method, req.path, res.statusCode, (Date.now() - t) + 'ms'); }); next(); });

const wrap = fn => (req, res) => fn(req, res).catch(e => { res.status(400).json({ error: String(e.message || e) }); });
const v1 = express.Router(); v1.use(requireUser());

v1.post('/wallet', wrap(async (req, res) => {
  let w = await getWallet(req.user.id);
  if (!w) { const nw = newWallet(); await db().run('INSERT INTO wallets (user_id, pubkey, enc_secret, iv, created_at) VALUES (?,?,?,?,?)', [req.user.id, nw.pubkey, nw.enc, nw.iv, now()]); w = await getWallet(req.user.id); await event(req.user.id, 'wallet_created', { pubkey: nw.pubkey }); }
  res.json({ pubkey: w.pubkey, created_at: w.created_at, withdraw_to: w.withdraw_to, daily_limit_sol: w.daily_limit_sol });
}));

v1.get('/wallet', wrap(async (req, res) => {
  const w = await getWallet(req.user.id); if (!w) return res.json({ pubkey: null });
  const [sol, tokens, solUsd] = await Promise.all([chain.solBalance(w.pubkey), chain.tokenBalances(w.pubkey).catch(() => []), chain.solPrice()]);
  const px = tokens.length ? await chain.prices(tokens.map(t => t.mint)) : {};
  res.json({ pubkey: w.pubkey, sol, solUsd, spendable: Math.max(0, sol - FEE_RESERVE), feeReserve: FEE_RESERVE, withdraw_to: w.withdraw_to, daily_limit_sol: w.daily_limit_sol,
    tokens: tokens.map(t => ({ ...t, symbol: chain.symbolOf(t.mint), price: px[t.mint] || 0, value: (px[t.mint] || 0) * t.amount })) });
}));

v1.post('/order', rateLimit(10, 60000), wrap(async (req, res) => {
  const { mint, side, solIn, pct, slippageBps, tp, sl, trailPct, symbol } = req.body || {};
  const r = await placeOrder(req.user.id, { mint, side, solIn, pct, slippageBps, tp, sl, trailPct, symbol, source: 'user' });
  res.json(r);
}));

v1.post('/exits', wrap(async (req, res) => {
  const { mint, tp, sl, trailPct } = req.body || {};
  const p = await getPosition(req.user.id, mint); if (!p) throw new Error('No open position for that token');
  const tpPx = tp == null ? null : p.entry_px * (1 + (+tp) / 100), slPx = sl == null ? null : p.entry_px * (1 - (+sl) / 100);
  await db().run('UPDATE positions SET tp_px = ?, sl_px = ?, trail_pct = ?, high_px = ?, armed = 1, hit = NULL, updated_at = ? WHERE user_id = ? AND mint = ?', [tpPx, slPx, trailPct == null ? null : +trailPct, p.entry_px, now(), req.user.id, mint]);
  res.json({ ok: true, position: await getPosition(req.user.id, mint) });
}));

v1.get('/positions', wrap(async (req, res) => { res.json(await positionsWithPnl(req.user.id)); }));
v1.get('/orders', wrap(async (req, res) => { res.json(await db().all('SELECT id, mint, symbol, side, sol_in, token_in, sol_out, token_out, price_usd, tx_sig, status, error, source, created_at, confirmed_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id])); }));
v1.get('/events', wrap(async (req, res) => { res.json(await db().all('SELECT kind, detail, at FROM events WHERE user_id = ? ORDER BY at DESC LIMIT 100', [req.user.id])); }));

v1.post('/withdraw', rateLimit(5, 60000), wrap(async (req, res) => {
  const { to, sol, password } = req.body || {};
  const w = await getWallet(req.user.id); if (!w) throw new Error('No trading wallet yet');
  if (!(await checkPassword(req.user, password))) throw new Error('Password check failed');
  let dest; try { dest = new PublicKey(to); } catch { throw new Error('Destination is not a valid Solana address'); }
  const amt = +sol; if (!(amt > 0)) throw new Error('Amount must be > 0');
  const since = now() - 86400000; const used = (await db().get('SELECT COALESCE(SUM(sol),0) AS s FROM withdrawals WHERE user_id = ? AND status = ? AND at > ?', [req.user.id, 'confirmed', since]))?.s || 0;
  if (used + amt > w.daily_limit_sol) throw new Error(`Daily withdrawal limit is ◎${w.daily_limit_sol} (◎${(+used).toFixed(4)} used in the last 24h)`);
  const bal = await chain.solBalance(w.pubkey); if (bal < amt + 0.00001) throw new Error(`Wallet has ◎${bal.toFixed(4)}`);
  const wid = id(); await db().run('INSERT INTO withdrawals (id, user_id, to_addr, sol, status, at) VALUES (?,?,?,?,?,?)', [wid, req.user.id, to, amt, 'sent', now()]);
  const { blockhash, lastValidBlockHeight } = await chain.rpc(c => c.getLatestBlockhash('confirmed'));
  const raw = await withKeypair(w, async kp => { const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight }).add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: Math.floor(amt * LAMPORTS_PER_SOL) })); tx.sign(kp); return tx.serialize(); });
  const sig = await sendImpl(raw);
  const c = await confirm(sig);
  await db().run('UPDATE withdrawals SET tx_sig = ?, status = ? WHERE id = ?', [sig, c.ok ? 'confirmed' : c.status, wid]);
  await db().run('UPDATE wallets SET withdraw_to = ? WHERE user_id = ?', [to, req.user.id]);
  await event(req.user.id, c.ok ? 'withdraw_confirmed' : 'withdraw_' + c.status, { to, sol: amt, sig });
  if (!c.ok) throw new Error((c.status === 'failed' ? 'Failed on-chain: ' : 'Not confirmed: ') + c.detail);
  res.json({ sig, status: c.status });
}));

app.use('/v1', v1);
app.get('/healthz', (req, res) => res.json({ ok: true, watcher: watcher.state, db: db().kind, feeBps: +(process.env.PLATFORM_FEE_BPS || 0), at: Date.now() }));
app.get('/', (req, res) => res.type('text').send('MemeScreen execution service. See /healthz.'));

export async function main(){
  if (!process.env.MASTER_KEY) throw new Error('MASTER_KEY is not set (openssl rand -hex 32)');
  await open();
  // FAKE_CHAIN=1 (local testing only): real Jupiter quotes and real signing, but nothing is broadcast and every wallet reads as ◎0.5
  if (process.env.FAKE_CHAIN === '1' && process.env.NODE_ENV !== 'production') { const { setChainImpl } = await import('./order.js'); setChainImpl({ send: async () => 'FAKE' + Date.now().toString(36).padEnd(84, 'x'), status: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }); chain.setSolBalance(async () => 0.5); chain.setTokenBalances(async pub => { const w = await db().get('SELECT user_id FROM wallets WHERE pubkey = ?', [pub]); const ps = w ? await db().all('SELECT mint, qty FROM positions WHERE user_id = ?', [w.user_id]) : []; return ps.map(x => ({ mint: x.mint, amount: x.qty, decimals: 6 })); }); safeLog('FAKE_CHAIN: sends are simulated'); }
  watcher.setPlaceOrder(placeOrder);
  if (process.env.WATCHER !== 'off') watcher.start();
  const port = +(process.env.PORT || 4100);
  await new Promise(r => app.listen(port, r));
  safeLog(`ms-exec listening on :${port} (${db().kind}, watcher ${watcher.state.running ? 'on' : 'off'})`);
  return app;
}
export { app };
if (process.argv[1] && process.argv[1].endsWith('index.js')) main().catch(e => { console.error(e.message); process.exit(1); });
