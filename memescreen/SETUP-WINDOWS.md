# MemeScreen — Windows setup (step by step)

You'll do this in three stages: **install tools → run the backend → run the app**.
Copy-paste the commands exactly. Lines starting with `#` are just notes; don't type them.

---

## Stage 0 — Install the tools (once)

1. **Node.js** (runs the server and the app tooling)
   - Go to https://nodejs.org → download the **LTS** Windows installer → run it, click Next through everything.
   - Verify: open **PowerShell** (press Start, type "powershell", Enter) and run:
     ```
     node --version
     npm --version
     ```
     You should see version numbers. If "not recognized", close and reopen PowerShell.

2. **Rust** (only needed to build the .exe — skip if you just want to run the app in a window for now)
   - Go to https://www.rust-lang.org/tools/install → download **rustup-init.exe** → run it → press Enter for the default install.
   - Install **Microsoft C++ Build Tools**: https://visualstudio.microsoft.com/visual-cpp-build-tools/ → run it → check **"Desktop development with C++"** → Install. (Tauri needs this to compile.)
   - Verify:
     ```
     rustc --version
     ```

3. **A cloud database** (free — this is your Postgres)
   - Go to https://neon.tech → sign up (free) → **Create project** → name it `memescreen`.
   - After it's created, find **Connection string** (looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`). **Copy it** — you'll paste it in Stage 1.
   - (Supabase or Railway work identically if you prefer.)

---

## Stage 1 — Run the backend server

1. Unzip the project somewhere simple, e.g. `C:\memescreen`.
2. In PowerShell:
   ```
   cd C:\memescreen\server
   npm install
   ```
3. Create the config file. Copy the example:
   ```
   copy .env.example .env
   ```
4. Open `.env` in Notepad (`notepad .env`) and fill in two lines:
   - `DATABASE_URL=` paste your Neon connection string
   - `JWT_SECRET=` paste a long random string. Generate one with:
     ```
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
     ```
   Save and close.
5. Create the database tables (once):
   ```
   npm run init-db
   ```
   You should see: `✅ Database schema created`.
6. Start the server:
   ```
   npm start
   ```
   You should see: `🟢 MemeScreen API on http://localhost:4000`.
   **Leave this window open** — this is your backend. Open a NEW PowerShell window for Stage 2.

---

## Stage 2 — Run the app

### Option A — Just see it running (fastest)
In a new PowerShell:
```
cd C:\memescreen
npm install
npm run dev
```
Open the URL it prints (http://localhost:5173) in your browser. Create an account and trade.

### Option B — Build the real .exe (desktop app)
```
cd C:\memescreen
npm install
npm run tauri build
```
First build takes 5–15 minutes (Rust compiles a lot the first time). When done, your installer is at:
```
C:\memescreen\src-tauri\target\release\bundle\nsis\MemeScreen_1.0.0_x64-setup.exe
```
Run that to install MemeScreen like any Windows program. The `.exe` still needs the backend server (Stage 1) running.

---

## How it fits together

```
  [ MemeScreen.exe / browser ]  →  talks to  →  [ your backend server ]  →  [ Neon Postgres ]
         (the app UI)                              (localhost:4000)          (accounts, trades)
         |
         └─ pulls LIVE PRICES straight from DexScreener / PumpPortal / GeckoTerminal
```

- **Accounts, trades, positions, leaderboards** live in your database via the server.
- **Live prices and charts** are pulled by the app directly from the public crypto APIs.
- Passwords are **bcrypt-hashed on the server** — the database never stores a readable password.

---

## Going live later (so friends can use it without your PC on)

1. Deploy the `server` folder to a free host (Railway, Render, or Fly.io). Set the same `DATABASE_URL` and `JWT_SECRET` as environment variables there.
2. It gives you a public URL like `https://memescreen-api.up.railway.app`.
3. In the app: **Settings → Change API URL** → paste that URL. Rebuild the `.exe` and share it.

---

## Troubleshooting

- **App says "Server not reachable"** → the backend (Stage 1) isn't running, or the API URL is wrong. Start `npm start` in the server folder.
- **`npm run init-db` errors** → the `DATABASE_URL` is wrong. Re-copy it from Neon; make sure it ends with `?sslmode=require`.
- **Tauri build fails** → the C++ Build Tools aren't installed (Stage 0, step 2), or restart PowerShell after installing Rust.
- **Port 4000 in use** → change `PORT=4000` to `PORT=4001` in `.env`, and set the API URL in the app to match.
