# MemeScreen

TradingView for memecoins — chart, grade, and paper-trade Solana memecoins with live data.
Real accounts (email + password), cloud database, weekly and all-time competitions, price alerts.

**Paper trading only.** No real funds, no wallet connection. Passwords are bcrypt-hashed.

## What's in here

```
memescreen/
├── server/            ← backend API (Node + Express + Postgres)
│   ├── index.js       ← auth, trades, positions, watchlist, leaderboards
│   ├── db.js          ← database schema + connection
│   └── .env.example   ← copy to .env and fill in
├── src/               ← the app UI (HTML/CSS/JS)
│   ├── index.html     ← login screen + app shell
│   ├── app.js         ← all app logic + live data + server sync
│   └── styles.css
├── src-tauri/         ← desktop wrapper (turns the app into a .exe)
├── SETUP-WINDOWS.md   ← START HERE — step-by-step
└── README.md
```

## Quick start

See **SETUP-WINDOWS.md**. Short version:

```
# 1. backend
cd server && npm install && copy .env.example .env   # then edit .env
npm run init-db && npm start

# 2. app (new terminal)
cd .. && npm install && npm run dev                  # or: npm run tauri build
```

## Backend (accounts for many users)

Two interchangeable backends — pick one in `src/config.js` or at runtime (login screen → *change*, or Settings → Server):

- **Back4App** (hosted Parse) — see **BACK4APP-SETUP.md**. Paste two keys, done.
- **Express + Postgres** in `/server` — `npm run init-db && npm start`. `server/Dockerfile` deploys it to Back4App Containers / Render / Railway.

Every user gets isolated data: any number of **paper-trading accounts** (each with its own starting balance, positions, orders and history), a watchlist, alert rules, and a place on the weekly / all-time leaderboards (the `main` account competes). State syncs to the backend a moment after every change and is pulled on login, so it follows you between the desktop site and the phone. "Keep me signed in" stores the session in localStorage; unticked, it lives in sessionStorage and ends with the browser.

## Charting

`src/drawtools.js` adds a TradingView-style toolbar on top of KLineChart: cursors (cross / dot / arrow / eraser), trend-line tools (trend line, ray, info line, extended, arrow, horizontal line / ray, vertical, parallel channel, price channel), Fib retracement and trend-based extension, pitchfork, Schiff pitchfork, Gann box, rectangle / circle / triangle / parallelogram, text / callout / price note / arrow markers / flag, XABCD, head-and-shoulders, Elliott 12345 and ABC, triangle pattern, long / short position planners, price / date / date-and-price range. Magnet, lock, hide, delete-selected (Del), clear. Drawings are saved per token in the browser. Right-click (long-press on a phone) on empty chart space still opens the order menu; right-click on a drawing deletes it. ⛶ makes the chart full screen.

## Phone app

The phone version is the same app (same `app.js`, same backend, same account and alerts) with a phone layout.

- **Simulator:** with `npm run dev` running, open **http://localhost:5173/phone.html**. You get a phone with a home screen: tap the MemeScreen icon to launch the app (it opens on the sign-in / create-account screen), press the bar at the bottom to go home. The app keeps running in the background, so alerts drop down as phone notifications, badge the icon, and collect in the notification centre (tap the status bar). Tapping a notification opens that token's chart.
- **Without the frame:** http://localhost:5173/?m=1 (or any window narrower than 760px / Chrome DevTools device mode). `?m=0` forces desktop.
- **Real phone:** same Wi-Fi, open the `Network:` address Vite prints. "Add to Home Screen" runs it full-screen.
- **System notifications:** `src/public/sw.js` is a service worker; alerts go through it so they also work as real OS notifications (needs localhost or https).

Files: `src/mobile.css`, `src/mobile.js`, `src/phone.html`, `src/public/` (service worker, manifest, icon).

## Stack

- **Frontend:** vanilla JS + Vite, wrapped by **Tauri 2** for the desktop `.exe`
- **Backend:** Back4App (Parse) *or* Node + Express with JWT auth and bcrypt password hashing
- **Database:** Back4App's, or PostgreSQL (Neon / Supabase / Railway free tier, or local)
- **Live data:** DexScreener (prices, screener), PumpPortal (real-time trades), GeckoTerminal (chart history)

## Security notes

- Passwords are never stored in plaintext — only a bcrypt hash (12 rounds).
- Auth uses signed JWTs (30-day expiry) in the `Authorization: Bearer` header.
- The client never sees other users' data; every query is scoped to the signed-in user id.
- This is a student/portfolio project. Before any real public launch, add: rate limiting, email verification, HTTPS-only cookies, and a security review.
