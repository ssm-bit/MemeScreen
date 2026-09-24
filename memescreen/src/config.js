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
  expressUrl: '',                        // '' = same machine that served the page, port 4000
};
