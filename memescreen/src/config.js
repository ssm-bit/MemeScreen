// ============================================================
// MemeScreen — backend configuration
//
// Two backends are supported and the app behaves the same on both:
//
//   1. BACK4APP  (Parse)  — paste your keys below. Nothing to host.
//                            Back4App dashboard → App Settings → Security & Keys
//   2. EXPRESS             — the Node + Postgres server in /server (npm start, port 4000)
//
// backend: 'auto' uses Back4App when both keys are filled in, otherwise Express.
// You can also set / change this at runtime in the app: Settings → Server.
// ============================================================
export default {
  backend: 'back4app',                   // 'auto' | 'back4app' | 'express'
  back4app: {
    appId: 'CRzmZVtYdNTKZ8UJiFiAdzayCn68qcxqomDh3TBw',                           // Application ID
    jsKey: 'd5ZabG61ROOuG6wxyhZT0krGp3faDiNOyTdovytV',                           // JavaScript key  (NOT the master key — never put the master key in a web app)
    serverUrl: 'https://parseapi.back4app.com',
  },
  // Solana RPC for the live price feed, wallet reads and token decimals. The public endpoint works but is
  // rate-limited and its WebSocket is often refused. A free Helius key (helius.dev → create API key) makes the
  // chart tick on every swap: put https://mainnet.helius-rpc.com/?api-key=KEY here and wss://mainnet.helius-rpc.com/?api-key=KEY below.
  rpcUrl: '',
  wsUrl: '',
  jupiterKey: '',                        // optional: a free key from portal.jup.ag raises the Jupiter quote rate limit for live orders
  expressUrl: '',
  // MemeScreen execution service (memescreen/exec): the trading wallet with server-side orders and 24/7 auto exits.
  // Leave '' and paste the URL in the app (Settings → Trading wallet), or set it here for everyone, e.g. 'https://ms-exec.up.railway.app'.
  execUrl: '',                        // '' = same machine that served the page, port 4000
};
