// index.js — MemeScreen backend API
// Accounts (bcrypt-hashed passwords + JWT), wallet, trades, positions, watchlist, leaderboards.
// Price data is pulled by the CLIENT directly from public APIs; this server owns user data + competition.

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { pool, query, initDb } from './db.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const START = 10000;
const GRADES = ['F', 'D', 'C', 'B', 'A'];

// ---------- helpers ----------
function sign(user) { return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Not signed in' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired — sign in again' }); }
}
function isoWeek(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return x.getUTCFullYear() + '-W' + String(Math.ceil((((x - y0) / 864e5) + 1) / 7)).padStart(2, '0');
}
const scoreFor = (ret, gIdx) => ret * (0.5 + gIdx / 4 * 0.7);
const valid = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// ---------- health ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'memescreen', time: Date.now() }));

// ---------- market data proxy (server-side, avoids browser CORS/geo blocks) ----------
let _mktCache = { at: 0, data: null };
app.get('/api/market', async (_req, res) => {
  try {
    if (Date.now() - _mktCache.at < 60000 && _mktCache.data) return res.json(_mktCache.data);
    const out = {};
    // CoinGecko works fine server-side (no CORS, generous from a single server IP)
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true');
      if (r.ok) { const p = await r.json();
        if (p.bitcoin) out.btc = { usd: p.bitcoin.usd, usd_24h_change: p.bitcoin.usd_24h_change };
        if (p.ethereum) out.eth = { usd: p.ethereum.usd, usd_24h_change: p.ethereum.usd_24h_change };
        if (p.solana) out.sol = { usd: p.solana.usd, usd_24h_change: p.solana.usd_24h_change };
      }
    } catch {}
    // global market cap
    try { const g = await (await fetch('https://api.coingecko.com/api/v3/global')).json(); out.mcap = g.data?.total_market_cap?.usd; out.mcapChg = g.data?.market_cap_change_percentage_24h_usd; } catch {}
    _mktCache = { at: Date.now(), data: out };
    res.json(out);
  } catch (e) { res.json(_mktCache.data || {}); }
});

// ---------- tiny rate limiter for the auth routes (per IP: 20 attempts / 10 min) ----------
const hits = new Map();
function limitAuth(req, res, next) {
  const k = req.ip || 'x', now = Date.now(); const a = (hits.get(k) || []).filter(t => now - t < 600000); a.push(now); hits.set(k, a);
  if (a.length > 20) return res.status(429).json({ error: 'Too many attempts — wait a few minutes and try again' });
  next();
}
process.on('unhandledRejection', e => console.error('unhandled:', e?.message || e));

// ---------- auth ----------
app.post('/api/register', limitAuth, async (req, res) => {
  try {
    let { email, password, nickname } = req.body || {};
    email = (email || '').trim().toLowerCase();
    if (!valid(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    nickname = (nickname || email.split('@')[0]).trim().slice(0, 20);

    const exists = await query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists.rowCount) return res.status(409).json({ error: 'That email is already registered' });

    const hash = await bcrypt.hash(password, 12);           // 12 rounds — passwords are never stored in plaintext
    const u = (await query('INSERT INTO users(email,password_hash,nickname) VALUES($1,$2,$3) RETURNING id,email,nickname', [email, hash, nickname])).rows[0];
    await query('INSERT INTO wallets(user_id,week_id,week_start_equity) VALUES($1,$2,$3)', [u.id, isoWeek(), START]);
    res.json({ token: sign(u), user: { id: u.id, email: u.email, nickname: u.nickname } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', limitAuth, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = (email || '').trim().toLowerCase();
    const u = (await query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    if (!u) return res.status(401).json({ error: 'No account with that email' });
    const ok = await bcrypt.compare(password || '', u.password_hash);   // compares against the hash, never the raw password
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    res.json({ token: sign(u), user: { id: u.id, email: u.email, nickname: u.nickname } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/me', auth, async (req, res) => {
  const u = (await query('SELECT id,email,nickname FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!u) return res.status(401).json({ error: 'Session expired — sign in again' });
  res.json({ user: u });
});

// ---------- wallet snapshot (cash + positions + watchlist) ----------
app.get('/api/state', auth, async (req, res) => {
  const uid = req.user.id;
  const w = (await query('SELECT * FROM wallets WHERE user_id=$1', [uid])).rows[0];
  const positions = (await query('SELECT * FROM positions WHERE user_id=$1 ORDER BY opened_at', [uid])).rows;
  const watch = (await query('SELECT token_address FROM watchlist WHERE user_id=$1', [uid])).rows.map(r => r.token_address);
  const trades = (await query('SELECT * FROM trades WHERE user_id=$1 ORDER BY ts DESC LIMIT 200', [uid])).rows;
  res.json({ wallet: w, positions, watch, trades });
});

// ---------- trading (server records the ledger; client sends the computed fill) ----------
app.post('/api/trade/open', auth, async (req, res) => {
  const uid = req.user.id;
  const { token_address, sym, name, pair, dir, qty, cost, received = 0, entry, grade, fees = 0, impact = 0 } = req.body || {};
  if (!token_address || !dir || !(cost > 0)) return res.status(400).json({ error: 'Bad trade' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = (await client.query('SELECT cash FROM wallets WHERE user_id=$1 FOR UPDATE', [uid])).rows[0];
    if (w.cash < cost) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Not enough cash' }); }
    await client.query('UPDATE wallets SET cash=cash-$1, updated_at=now() WHERE user_id=$2', [cost, uid]);
    // merge into existing same-direction position or insert
    const ex = (await client.query('SELECT * FROM positions WHERE user_id=$1 AND token_address=$2 AND dir=$3', [uid, token_address, dir])).rows[0];
    if (ex) {
      await client.query('UPDATE positions SET qty=qty+$1, cost=cost+$2, received=received+$3 WHERE id=$4', [qty, cost, received, ex.id]);
    } else {
      await client.query('INSERT INTO positions(user_id,token_address,sym,name,pair,dir,qty,cost,received,entry,grade_at_entry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [uid, token_address, sym, name, pair, dir, qty, cost, received, entry, grade]);
    }
    await client.query('INSERT INTO trades(user_id,token_address,sym,action,dir,side,price,usd,qty,fees,impact_pct,grade_at_entry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [uid, token_address, sym, 'open', dir, dir === 'long' ? 'B' : 'S', entry, cost, qty, fees, impact, grade]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

app.post('/api/trade/close', auth, async (req, res) => {
  const uid = req.user.id;
  const { position_id, token_address, dir, pct = 100, value, fill, pnl = 0, grade } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // find by id if provided, else by token+dir (client sends token_address+dir)
    let p;
    if (position_id) p = (await client.query('SELECT * FROM positions WHERE id=$1 AND user_id=$2 FOR UPDATE', [position_id, uid])).rows[0];
    else p = (await client.query('SELECT * FROM positions WHERE user_id=$1 AND token_address=$2 AND dir=$3 FOR UPDATE', [uid, token_address, dir])).rows[0];
    if (!p) { await client.query('ROLLBACK'); return res.json({ ok: true, note: 'already closed' }); }
    const f = pct / 100;
    await client.query('UPDATE wallets SET cash=cash+$1, updated_at=now() WHERE user_id=$2', [value, uid]);
    await client.query('INSERT INTO trades(user_id,token_address,sym,action,dir,side,price,usd,pnl,grade_at_entry) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [uid, p.token_address, p.sym, 'close', p.dir, p.dir === 'long' ? 'S' : 'B', fill, value, pnl, grade || p.grade_at_entry]);
    if (pct >= 100) await client.query('DELETE FROM positions WHERE id=$1', [p.id]);
    else await client.query('UPDATE positions SET qty=qty*$1, cost=cost*$1, received=received*$1 WHERE id=$2', [1 - f, p.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Server error' }); }
  finally { client.release(); }
});

app.post('/api/positions/cleanup', auth, async (req, res) => {
  const uid = req.user.id;
  // remove corrupt/zero positions
  await query('DELETE FROM positions WHERE user_id=$1 AND (qty IS NULL OR qty<=0 OR entry IS NULL OR entry<=0 OR token_address IS NULL)', [uid]);
  const rows = (await query('SELECT * FROM positions WHERE user_id=$1', [uid])).rows;
  res.json({ ok: true, remaining: rows.length });
});

app.post('/api/wallet/reset', auth, async (req, res) => {
  const uid = req.user.id;
  await query('DELETE FROM positions WHERE user_id=$1', [uid]);
  await query('DELETE FROM trades WHERE user_id=$1', [uid]);
  await query('UPDATE wallets SET cash=$1, reset_at=now(), week_start_equity=$1, week_id=$2 WHERE user_id=$3', [START, isoWeek(), uid]);
  res.json({ ok: true });
});

// ---------- paper-trading accounts (many per user) ----------
const okName = n => typeof n === 'string' && n.trim().length >= 1 && n.length <= 24;
// First time an existing user shows up here, build their "main" account from the older wallet/positions/trades tables
// so nothing they already traded is lost.
async function ensureMain(uid) {
  const has = await query('SELECT 1 FROM paper_accounts WHERE user_id=$1 AND name=$2', [uid, 'main']);
  if (has.rowCount) return;
  const w = (await query('SELECT * FROM wallets WHERE user_id=$1', [uid])).rows[0];
  const pos = (await query('SELECT * FROM positions WHERE user_id=$1 AND qty>0 AND entry>0 ORDER BY opened_at', [uid])).rows;
  const tr = (await query('SELECT * FROM trades WHERE user_id=$1 ORDER BY ts DESC LIMIT 200', [uid])).rows.reverse();
  const state = {
    cash: w ? +w.cash : START, weekId: w?.week_id || isoWeek(), weekStartEq: w ? +w.week_start_equity : START, resetAt: w ? +new Date(w.reset_at) : Date.now(), orders: [], equityLog: [],
    positions: pos.map(p => ({ addr: p.token_address, side: p.dir, qty: +p.qty, cost: +p.cost, received: +p.received, entry: +p.entry, grade: p.grade_at_entry || 'C', opened: +new Date(p.opened_at), tp: null, sl: null, sym: p.sym, name: p.name, pair: p.pair, price: +p.entry, liq: 0 })),
    trades: tr.map(t => ({ id: 'srv' + t.id, addr: t.token_address, sym: t.sym, ts: +new Date(t.ts), price: +t.price, side: t.side, usd: +t.usd, fees: +t.fees || 0, impact: +t.impact_pct || 0, grade: t.grade_at_entry, open: t.action === 'open', dir: t.dir, pnl: t.pnl == null ? null : +t.pnl })),
  };
  await query('INSERT INTO paper_accounts(user_id,name,size,state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [uid, 'main', START, JSON.stringify(state)]);
}
const acctRow = r => ({ name: r.name, size: +r.size, state: r.state, updatedAt: +new Date(r.updated_at) });

app.get('/api/accounts', auth, async (req, res) => {
  try {
    await ensureMain(req.user.id);
    const rows = (await query('SELECT * FROM paper_accounts WHERE user_id=$1 ORDER BY created_at', [req.user.id])).rows;
    res.json({ accounts: rows.map(acctRow) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/accounts/:name', auth, async (req, res) => {
  try {
    const name = req.params.name; const { size, state } = req.body || {};
    if (!okName(name)) return res.status(400).json({ error: 'Account name must be 1–24 characters' });
    if (!(+size > 0) || +size > 1e9) return res.status(400).json({ error: 'Starting balance must be between $1 and $1B' });
    const count = +(await query('SELECT count(*) FROM paper_accounts WHERE user_id=$1', [req.user.id])).rows[0].count;
    const exists = (await query('SELECT 1 FROM paper_accounts WHERE user_id=$1 AND name=$2', [req.user.id, name])).rowCount;
    if (!exists && count >= 25) return res.status(400).json({ error: 'Account limit reached (25)' });
    const r = (await query(`INSERT INTO paper_accounts(user_id,name,size,state) VALUES($1,$2,$3,$4)
      ON CONFLICT (user_id,name) DO UPDATE SET size=$3, state=$4, updated_at=now() RETURNING *`, [req.user.id, name, +size, state == null ? null : JSON.stringify(state)])).rows[0];
    res.json({ account: { name: r.name, size: +r.size, updatedAt: +new Date(r.updated_at) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/accounts/:name', auth, async (req, res) => {
  if (req.params.name === 'main') return res.status(400).json({ error: 'The main account can be reset but not deleted' });
  await query('DELETE FROM paper_accounts WHERE user_id=$1 AND name=$2', [req.user.id, req.params.name]);
  res.json({ ok: true });
});

// ---------- profile (watchlist, alert rules, indicator prefs, active account) ----------
app.get('/api/profile', auth, async (req, res) => {
  try {
    let row = (await query('SELECT data FROM profiles WHERE user_id=$1', [req.user.id])).rows[0];
    if (!row) { // carry the older watchlist table over once
      const watch = (await query('SELECT token_address FROM watchlist WHERE user_id=$1', [req.user.id])).rows.map(r => r.token_address);
      row = { data: { watch } };
      await query('INSERT INTO profiles(user_id,data) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id, JSON.stringify(row.data)]);
    }
    res.json({ profile: row.data });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/profile', auth, async (req, res) => {
  try {
    const data = (req.body || {}).profile || {};
    await query(`INSERT INTO profiles(user_id,data) VALUES($1,$2) ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=now()`, [req.user.id, JSON.stringify(data)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---------- competitions people create (join by code) ----------
const compRow = (r, uid) => ({ code: r.code, name: r.name, by: r.owner_nick, members: r.members, mine: (r.member_ids || []).includes(uid) });
app.get('/api/competitions', auth, async (req, res) => {
  const rows = (await query('SELECT * FROM competitions ORDER BY created_at DESC LIMIT 100')).rows;
  res.json({ competitions: rows.map(r => compRow(r, req.user.id)) });
});
app.post('/api/competitions', auth, async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 40); if (!name) return res.status(400).json({ error: 'Name the competition' });
  const u = (await query('SELECT nickname FROM users WHERE id=$1', [req.user.id])).rows[0];
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const r = (await query('INSERT INTO competitions(code,name,owner_id,owner_nick,members,member_ids) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [code, name, req.user.id, u.nickname, JSON.stringify([u.nickname]), JSON.stringify([req.user.id])])).rows[0];
  res.json({ competition: compRow(r, req.user.id) });
});
app.post('/api/competitions/join', auth, async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const r = (await query('SELECT * FROM competitions WHERE code=$1', [code])).rows[0]; if (!r) return res.status(404).json({ error: 'No competition with code ' + code });
  const u = (await query('SELECT nickname FROM users WHERE id=$1', [req.user.id])).rows[0];
  const members = [...new Set([...r.members, u.nickname])], ids = [...new Set([...r.member_ids, req.user.id])];
  const r2 = (await query('UPDATE competitions SET members=$1, member_ids=$2 WHERE code=$3 RETURNING *', [JSON.stringify(members), JSON.stringify(ids), code])).rows[0];
  res.json({ competition: compRow(r2, req.user.id) });
});
app.post('/api/competitions/:code/leave', auth, async (req, res) => {
  const r = (await query('SELECT * FROM competitions WHERE code=$1', [req.params.code])).rows[0]; if (!r) return res.json({ ok: true });
  const u = (await query('SELECT nickname FROM users WHERE id=$1', [req.user.id])).rows[0];
  await query('UPDATE competitions SET members=$1, member_ids=$2 WHERE code=$3', [JSON.stringify(r.members.filter(m => m !== u.nickname)), JSON.stringify(r.member_ids.filter(i => i !== req.user.id)), req.params.code]);
  res.json({ ok: true });
});
// account deletion (data deletion request): removes the user and, through ON DELETE CASCADE, everything they own
app.delete('/api/me', auth, async (req, res) => { await query('DELETE FROM users WHERE id=$1', [req.user.id]); res.json({ ok: true }); });

// ---------- watchlist ----------
app.post('/api/watch', auth, async (req, res) => {
  const { token_address, sym, on } = req.body || {};
  if (on) await query('INSERT INTO watchlist(user_id,token_address,sym) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, token_address, sym]);
  else await query('DELETE FROM watchlist WHERE user_id=$1 AND token_address=$2', [req.user.id, token_address]);
  res.json({ ok: true });
});

// ---------- competitions ----------
app.post('/api/leaderboard/sync', auth, async (req, res) => {
  // client computes its live equity (needs live prices it already has) and posts it
  const uid = req.user.id;
  const { equity, avgGradeIdx = 2, openTrades = 0, trades, returnWeek, returnAll } = req.body || {};
  if (!isFinite(+equity)) return res.status(400).json({ error: 'Bad equity' });
  const u = (await query('SELECT nickname FROM users WHERE id=$1', [uid])).rows[0];
  const w = (await query('SELECT * FROM wallets WHERE user_id=$1', [uid])).rows[0];
  const week = isoWeek();
  // roll the week if needed
  if (w.week_id !== week) await query('UPDATE wallets SET week_id=$1, week_start_equity=$2 WHERE user_id=$3', [week, equity, uid]);
  const base = { week: (w.week_id === week ? w.week_start_equity : equity), all: START };
  for (const period of ['week', 'all']) {
    const b = base[period] || START;
    const given = period === 'week' ? returnWeek : returnAll;
    const ret = isFinite(+given) && given != null ? Math.max(-100, Math.min(100000, +given)) : (equity - b) / b * 100;
    const sc = scoreFor(ret, avgGradeIdx);
    const wk = period === 'week' ? week : '';
    await query(`INSERT INTO leaderboard(user_id,period,week_id,nickname,equity,return_pct,avg_grade_idx,trades,score,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      ON CONFLICT (user_id,period,week_id) DO UPDATE SET nickname=$4,equity=$5,return_pct=$6,avg_grade_idx=$7,trades=$8,score=$9,updated_at=now()`,
      [uid, period, wk, u.nickname, equity, ret, avgGradeIdx, trades ?? openTrades, sc]);
  }
  res.json({ ok: true, week });
});

app.get('/api/leaderboard', async (req, res) => {
  const period = req.query.period === 'all' ? 'all' : 'week';
  const wk = period === 'week' ? isoWeek() : '';
  const rows = (await query(
    `SELECT nickname, return_pct, avg_grade_idx, trades, score, user_id FROM leaderboard
     WHERE period=$1 AND week_id=$2 ORDER BY score DESC LIMIT 100`, [period, wk])).rows;
  res.json({ period, week: wk, rows });
});

// ---------- boot ----------
const PORT = process.env.PORT || 4000;
async function boot() {
  try { await initDb(); } catch (e) { console.error('DB init failed:', e.message); }
  app.listen(PORT, () => console.log(`\n🟢 MemeScreen API on http://localhost:${PORT}\n   Health: http://localhost:${PORT}/api/health\n`));
}
boot();
