# MemeScreen team guide

## First time on your laptop

1. Install Git (git-scm.com) and Node 20+ (nodejs.org).
2. Clone and install:

```
git clone https://github.com/ssm-bit/MemeScreen.git memescreen-project
cd memescreen-project\memescreen
npm install
npm run dev
```

3. Open the address it prints. The phone version is the same address with `?m=1` on the end, and the phone simulator is `/phone.html`.

## Every day

- Before you start: `git pull`
- After you finish: `git add .` then `git commit -m "what you changed"` then `git push`
- If push is rejected, run `git pull` first, fix any conflict it names, then push again.

## Phones (Expo Go)

Windows: run `Put-MemeScreen-on-iPhone.bat` (same hotspot or Wi-Fi) or `Put-MemeScreen-on-Phones-ANYWHERE.bat` (any network, uses tunnels). It builds `memescreen-phone` on first run and asks for your Expo login. The join page it opens has one QR code per Expo account.

The Expo shell source is `expo-shell/App.js`. The script copies it into `memescreen-phone` and fills in the laptop address.

## Backend

Back4App. The Application ID and JavaScript key are in `memescreen/src/config.js` and are safe to commit (they are client keys). Never commit the master key or a `.env` file. Ask the repo owner to add you as a collaborator on the Back4App app if you need the dashboard.

## What is not in the repo

`node_modules`, `memescreen-phone`, `.expo-homes`, `expo-accounts.json`, `cloudflared.exe`, `tunnel.log`, `hosted-url.txt`, `dist`. Each is rebuilt or created per person.

## Using Claude

- Claude Code on the web (claude.ai/code): sign in with GitHub, pick this repo, describe the change. It pushes a branch; merge the pull request on GitHub, then `git pull`.
- Cowork or Claude Code on your laptop: connect your clone as the folder. Claude edits files there; you commit and push.
