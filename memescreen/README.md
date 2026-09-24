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

## Live site (no laptop needed)

The app is published to **GitHub Pages** by `.github/workflows/pages.yml` on every push to `main`:

- Web: https://ssm-bit.github.io/MemeScreen/
- Phone: https://ssm-bit.github.io/MemeScreen/?m=1 — open in Safari or Chrome, then *Add to Home Screen*. It is https, so alerts work as real notifications on the phone.
- Phone simulator: https://ssm-bit.github.io/MemeScreen/phone.html

One-time setup on GitHub: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. The first deploy takes about a minute after that; check the Actions tab.

Accounts, paper accounts, saved screens and competitions live in Back4App (keys in `src/config.js`), so the same login works on the site, the simulator and the iPhone app.

## Quick start (working on the code)

See **SETUP-WINDOWS.md**. Short version:

```
# 1. backend
cd server && npm install && copy .env.example .env   # then edit .env
npm run init-db && npm start

# 2. app (new terminal)
cd .. && npm install && npm run dev                  # or: npm run tauri build
```

## Backend (accounts for many users)

`src/config.js` is the source of truth and is set to **Back4App**. The Server window (login screen → *change*, or Settings → Server) can switch a browser to the Express server for development; *Use the team default* puts it back. Two interchangeable backends:

- **Back4App** (hosted Parse) — see **BACK4APP-SETUP.md**. Paste two keys, done.
- **Express + Postgres** in `/server` — `npm run init-db && npm start`. `server/Dockerfile` deploys it to Back4App Containers / Render / Railway.

Every user gets isolated data: any number of **paper-trading accounts** (each with its own starting balance, positions, orders and history), a watchlist, alert rules, and a place on the weekly / all-time leaderboards (the `main` account competes). State syncs to the backend a moment after every change and is pulled on login, so it follows you between the desktop site and the phone. "Keep me signed in" stores the session in localStorage; unticked, it lives in sessionStorage and ends with the browser.

## Charting

`src/drawtools.js` adds a TradingView-style toolbar on top of KLineChart: cursors (cross / dot / arrow / eraser), trend-line tools (trend line, ray, info line, extended, arrow, horizontal line / ray, vertical, parallel channel, price channel), Fib retracement and trend-based extension, pitchfork, Schiff pitchfork, Gann box, rectangle / circle / triangle / parallelogram, text / callout / price note / arrow markers / flag, XABCD, head-and-shoulders, Elliott 12345 and ABC, triangle pattern, long / short position planners, price / date / date-and-price range. Magnet, lock, hide, delete-selected (Del), clear. Drawings are saved per token in the browser. Right-click (long-press on a phone) on empty chart space still opens the order menu; right-click on a drawing deletes it. ⛶ makes the chart full screen.

## Phone app

The phone version is the same app (same `app.js`, same backend, same account and alerts) with a phone layout.

- **Simulator:** with `npm run dev` running, open **http://localhost:5173/phone.html**. You get a phone with a home screen: tap the MemeScreen icon to launch the app (it opens on the sign-in / create-account screen), press the bar at the bottom to go home. The app keeps running in the background, so alerts drop down as phone notifications, badge the icon, and collect in the notification centre (tap the status bar). Tapping a notification opens that token's chart.
- **Without the frame:** http://localhost:5173/?m=1 (or any window narrower than 760px / Chrome DevTools device mode). `?m=0` forces desktop.
- **Real phone:** open the live site (above) and *Add to Home Screen*. For unpushed code: same Wi-Fi, open the `Network:` address Vite prints.
- **iPhone through Expo Go:** `Put-MemeScreen-on-iPhone.bat` in the parent folder. It now points the Expo shell at the live site, so only the Expo server runs on the laptop. `Put-MemeScreen-on-iPhone-LOCAL.bat` serves the website from the laptop instead.
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
