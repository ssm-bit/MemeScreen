// ============================================================
// MemeScreen exec — database.
// Postgres when DATABASE_URL is set (Railway/Render add-on), otherwise a SQLite file (local work, tests).
// Both drivers answer the same three calls: all(sql, params), get(sql, params), run(sql, params).
// SQL uses ? placeholders; they are rewritten to $1..$n for Postgres.
// ============================================================
import { DatabaseSync } from 'node:sqlite';

let driver = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wallets (
     user_id TEXT PRIMARY KEY,
     pubkey TEXT NOT NULL,
     enc_secret TEXT NOT NULL,
     iv TEXT NOT NULL,
     withdraw_to TEXT,
     daily_limit_sol REAL NOT NULL DEFAULT 1,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     mint TEXT NOT NULL,
     symbol TEXT,
     side TEXT NOT NULL,
     sol_in REAL,
     token_in REAL,
     sol_out REAL,
     token_out REAL,
     price_usd REAL,
     quote_json TEXT,
     tx_sig TEXT,
     status TEXT NOT NULL,
     error TEXT,
     source TEXT NOT NULL DEFAULT 'user',
     created_at BIGINT NOT NULL,
     confirmed_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS positions (
     user_id TEXT NOT NULL,
     mint TEXT NOT NULL,
     symbol TEXT,
     qty REAL NOT NULL,
     cost_usd REAL NOT NULL,
     sol_in REAL NOT NULL DEFAULT 0,
     entry_px REAL NOT NULL,
     tp_px REAL,
     sl_px REAL,
     trail_pct REAL,
     high_px REAL,
     armed INTEGER NOT NULL DEFAULT 1,
     hit TEXT,
     opened_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL,
     PRIMARY KEY (user_id, mint))`,
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     user_id TEXT,
     kind TEXT NOT NULL,
     detail TEXT,
     at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at)`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     to_addr TEXT NOT NULL,
     sol REAL NOT NULL,
     tx_sig TEXT,
     status TEXT NOT NULL,
     at BIGINT NOT NULL)`,
];

function sqlite(file){
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const s of SCHEMA) db.exec(s);
  return {
    kind: 'sqlite',
    async all(sql, p = []){ return db.prepare(sql).all(...p); },
    async get(sql, p = []){ return db.prepare(sql).get(...p) ?? null; },
    async run(sql, p = []){ return db.prepare(sql).run(...p); },
    async close(){ db.close(); },
  };
}

async function postgres(url){
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  for (const s of SCHEMA) await pool.query(s);
  return {
    kind: 'postgres',
    async all(sql, p = []){ return (await pool.query(conv(sql), p)).rows; },
    async get(sql, p = []){ return (await pool.query(conv(sql), p)).rows[0] ?? null; },
    async run(sql, p = []){ const r = await pool.query(conv(sql), p); return { changes: r.rowCount }; },
    async close(){ await pool.end(); },
  };
}

export async function open({ databaseUrl = process.env.DATABASE_URL, sqliteFile = process.env.SQLITE_FILE || './exec.sqlite' } = {}){
  driver = databaseUrl ? await postgres(databaseUrl) : sqlite(sqliteFile);
  return driver;
}
export const db = () => { if (!driver) throw new Error('db not opened'); return driver; };
export const now = () => Date.now();
export const id = () => now().toString(36) + Math.random().toString(36).slice(2, 10);

export async function event(user_id, kind, detail){
  try { await db().run('INSERT INTO events (id, user_id, kind, detail, at) VALUES (?,?,?,?,?)', [id(), user_id, kind, JSON.stringify(detail || {}).slice(0, 4000), now()]); } catch {}
}
