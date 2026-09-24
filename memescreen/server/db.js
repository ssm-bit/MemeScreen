// db.js — PostgreSQL connection + schema.
// Works with a local Postgres or any cloud Postgres (Supabase, Neon, Railway).
// Set DATABASE_URL in .env. Run `npm run init-db` once to create tables.

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Cloud Postgres providers require SSL; local usually doesn't.
const isCloud = /supabase|neon|railway|render|amazonaws|heroku|back4app|sslmode=require/i.test(process.env.DATABASE_URL || '');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isCloud ? { rejectUnauthorized: false } : false,
});

export async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// ---- Schema ----
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash             DOUBLE PRECISION NOT NULL DEFAULT 10000,
  reset_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  week_id          TEXT,
  week_start_equity DOUBLE PRECISION NOT NULL DEFAULT 10000,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_address TEXT NOT NULL,
  sym           TEXT NOT NULL,
  name          TEXT,
  pair          TEXT,
  dir           TEXT NOT NULL,           -- long | short
  qty           DOUBLE PRECISION NOT NULL,
  cost          DOUBLE PRECISION NOT NULL,
  received      DOUBLE PRECISION NOT NULL DEFAULT 0,
  entry         DOUBLE PRECISION NOT NULL,
  grade_at_entry TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);

CREATE TABLE IF NOT EXISTS trades (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_address  TEXT NOT NULL,
  sym            TEXT NOT NULL,
  action         TEXT NOT NULL,          -- open | close
  dir            TEXT NOT NULL,          -- long | short
  side           TEXT NOT NULL,          -- B | S
  price          DOUBLE PRECISION NOT NULL,
  usd            DOUBLE PRECISION NOT NULL,
  qty            DOUBLE PRECISION,
  fees           DOUBLE PRECISION DEFAULT 0,
  impact_pct     DOUBLE PRECISION DEFAULT 0,
  grade_at_entry TEXT,
  pnl            DOUBLE PRECISION,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_address TEXT NOT NULL,
  sym           TEXT,
  PRIMARY KEY (user_id, token_address)
);

CREATE TABLE IF NOT EXISTS leaderboard (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period       TEXT NOT NULL,            -- week | all
  week_id      TEXT NOT NULL DEFAULT '',
  nickname     TEXT NOT NULL,
  equity       DOUBLE PRECISION NOT NULL,
  return_pct   DOUBLE PRECISION NOT NULL,
  avg_grade_idx DOUBLE PRECISION NOT NULL DEFAULT 2,
  trades       INTEGER NOT NULL DEFAULT 0,
  score        DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period, week_id)
);
CREATE INDEX IF NOT EXISTS idx_lb_rank ON leaderboard(period, week_id, score DESC);

-- Paper-trading accounts: every user can have as many as they like ("main", "swing", "degen"…).
-- state is the whole portfolio for that account (cash, positions, trades, orders, equity log) as JSON.
CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  size       DOUBLE PRECISION NOT NULL DEFAULT 10000,
  state      JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

CREATE TABLE IF NOT EXISTS competitions (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_nick TEXT NOT NULL,
  members    JSONB NOT NULL DEFAULT '[]'::jsonb,
  member_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user preferences that follow you across devices: watchlist, alert rules, indicators, active account.
CREATE TABLE IF NOT EXISTS profiles (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function initDb() {
  await pool.query(SCHEMA);
  console.log('✅ Database schema created (tables: users, wallets, positions, trades, watchlist, leaderboard, paper_accounts, profiles)');
}

// `npm run init-db`
if (process.argv.includes('--init')) {
  initDb().then(() => pool.end()).catch(e => { console.error('❌', e.message); process.exit(1); });
}
