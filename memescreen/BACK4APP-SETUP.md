# MemeScreen on Back4App

MemeScreen can keep its accounts, paper portfolios and leaderboards in **Back4App** (a hosted Parse backend).
Nothing to host, no database to install. The Node/Postgres server in `/server` still works too — the app
talks to either one through `src/backend.js`, and behaves the same on both.

## 1. Create the app (2 minutes)

1. Sign up at back4app.com → **Build new app** → *Backend as a Service* → name it `memescreen`.
2. Open **App Settings → Security & Keys**. Copy two values:
   - **Application ID**
   - **JavaScript key**  (never the *Master key* — that one must not go in a web app)

## 2. Point MemeScreen at it

Either edit `src/config.js`:

```js
back4app: { appId: 'PASTE_APPLICATION_ID', jsKey: 'PASTE_JAVASCRIPT_KEY', serverUrl: 'https://parseapi.back4app.com' },
```

…or do it without touching code: run the app → on the login screen click **change** next to the server line
(or **Settings → Server → Change server**) → choose **Back4App** → paste both keys → *Save and reload*.

With `backend: 'auto'` the app uses Back4App as soon as both keys are present, otherwise the Express server.

## 3. Use it

Create an account from the login screen. The first save creates these classes automatically:

| Class | What it holds | Who can read / write |
|---|---|---|
| `_User` | email, nickname, password (bcrypt-hashed by Parse, never readable) | the user |
| `PaperAccount` | one row per paper-trading account: `name`, `size`, `state` (cash, positions, trades, orders, equity log) | owner only (ACL) |
| `Profile` | watchlist, alert rules, indicator prefs, last active account | owner only (ACL) |
| `Leaderboard` | weekly / all-time return, avg grade, score | everyone reads, owner writes |

Every row is written with an ACL, so one user can never read or change another user's portfolio.

## 4. Before you demo it to a class / go public

In the Back4App dashboard → **Database** → each class → **Security (CLP)**:

- `PaperAccount`, `Profile`: turn **off** public Find/Get/Create/Update/Delete; leave *Authenticated* on.
- `Leaderboard`: public **Find/Get** on; Create/Update/Delete → *Authenticated* only.
- **App Settings → Server Settings → Client class creation** → off (after the four classes exist).

Optional: paste `back4app/cloud/main.js` into **Cloud Code** and deploy. It adds the BTC/ETH/SOL/market-cap
tiles on the dashboard and stops anyone writing a leaderboard row under somebody else's nickname.

## Alternative: run the Node server on Back4App Containers

If your professor wants the *Express* API hosted on Back4App instead: push this repo to GitHub →
Back4App → **Containers** → new app from the repo → root directory `server` (it has a `Dockerfile`) →
environment variables `DATABASE_URL` (any Postgres, e.g. a free Neon database) and `JWT_SECRET` → deploy.
Then in the app choose **MemeScreen server** and paste the container's URL.
