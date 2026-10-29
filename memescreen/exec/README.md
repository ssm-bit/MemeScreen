# MemeScreen execution service (ms-exec)

Per-user trading wallets with the key held here (encrypted), server-side Jupiter orders, and a 24/7 watcher that sells on stop-loss / take-profit / trailing stop with no Phantom redirect. The web and phone app talk to it with the user's Back4App session token.

## Run locally

```
cd memescreen/exec
npm install
cp .env.example .env          # fill MASTER_KEY (openssl rand -hex 32); leave DATABASE_URL empty for SQLite
npm run dev                   # http://localhost:4100/healthz
npm test                      # unit + HTTP tests (REAL=1 npm test also hits Jupiter for a real swap build)
```

Point the app at it: Settings → Trading wallet → service URL `http://localhost:4100` (or `execUrl` in `src/config.js`).

## Deploy (Railway, ~5 minutes)

1. railway.app → New Project → Deploy from GitHub repo → `ssm-bit/MemeScreen`. In the service settings set **Root Directory** to `memescreen/exec`.
2. Add a database: + New → Database → PostgreSQL. Railway injects `DATABASE_URL` into the service automatically (check Variables).
3. Variables: `MASTER_KEY` (openssl rand -hex 32 — keep an offline copy), `BACK4APP_APP_ID`, `BACK4APP_JS_KEY`, `BACK4APP_MASTER_KEY` (for push), `ALLOWED_ORIGINS=https://ssm-bit.github.io`, optional `RPC_URL` (Helius).
4. Settings → Networking → Generate Domain. Open `https://<domain>/healthz` → `{"ok":true,...}`.
5. Put that URL in `src/config.js` as `execUrl` (or paste it in the app under Settings → Trading wallet) and push the site.

Render works the same (Web Service from the repo, root `memescreen/exec`, Docker runtime, add a Postgres instance and copy its Internal URL into `DATABASE_URL`).

## API

All `/v1` routes: `Authorization: Bearer <Back4App session token>`.

| Route | Body | Returns |
|---|---|---|
| POST /v1/wallet | — | `{ pubkey }` (creates once, then returns the same) |
| GET /v1/wallet | — | `{ pubkey, sol, solUsd, spendable, tokens[] }` |
| POST /v1/order | `{ mint, side: buy\|sell, solIn \| pct, slippageBps?, tp?, sl?, trailPct? }` (tp/sl/trail in % of entry) | `{ orderId, sig, status, out }` |
| POST /v1/exits | `{ mint, tp, sl, trailPct }` (null clears) | `{ ok, position }` |
| GET /v1/positions | — | positions with `price, value, pnl_usd, pnl_pct, tp_px, sl_px, armed, hit` |
| GET /v1/orders | — | last 100 orders |
| POST /v1/withdraw | `{ to, sol, password }` | `{ sig }` — password re-checked with Back4App, daily limit ◎1 |
| GET /healthz | — | watcher state |

## How the money is protected

- Keys are AES-256-GCM encrypted under `MASTER_KEY`; decrypted per request inside `withKeypair()` and wiped after. Logs refuse anything that looks like a secret.
- A fresh password check and a daily limit on withdrawals; 10 orders / minute / user.
- The watcher disarms a position with an exclusive update before selling, so an exit fires once even with two instances.
- Jupiter swaps keep a ◎0.012 fee reserve; a sell retries 3 times then re-arms and pushes a notification.
- Before public users: move `MASTER_KEY` to a cloud KMS (one function in keys.js), restrict `ALLOWED_ORIGINS`, and get the custody/legal review the team plan describes.
