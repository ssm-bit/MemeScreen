import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.MASTER_KEY = randomBytes(32).toString('hex'); process.env.SQLITE_FILE = ':memory:'; process.env.PORT = '4199'; process.env.WATCHER = 'off';
process.env.BACK4APP_APP_ID = 'app'; process.env.BACK4APP_JS_KEY = 'js';
const auth = await import('../auth.js'); const chain = await import('../chain.js'); const order = await import('../order.js');
const { main } = await import('../index.js');
auth.setFetch(async (url, o) => { if (url.endsWith('/users/me')) { const t = o.headers['X-Parse-Session-Token']; return t === 'tok' ? { ok: true, json: async () => ({ objectId: 'u9', username: 'mullah' }) } : { ok: false, json: async () => ({}) }; }
  if (url.endsWith('/login')) { const b = JSON.parse(o.body); return b.password === 'pw' ? { ok: true, json: async () => ({ objectId: 'u9', sessionToken: 'x' }) } : { ok: false, json: async () => ({}) }; } return { ok: true, json: async () => ({}) }; });
chain.setSolBalance(async () => 0.5);
const H = { authorization: 'Bearer tok', 'content-type': 'application/json' };
const api = (p, o = {}) => fetch('http://127.0.0.1:4199' + p, { headers: H, ...o }).then(async r => ({ status: r.status, body: await r.json() }));
before(async () => { await main(); });

test('401 without a token', async () => { const r = await fetch('http://127.0.0.1:4199/v1/wallet'); assert.equal(r.status, 401); });
test('create wallet is idempotent; balance route answers', async () => {
  const a = await api('/v1/wallet', { method: 'POST' }); const b = await api('/v1/wallet', { method: 'POST' });
  assert.equal(a.status, 200); assert.equal(a.body.pubkey, b.body.pubkey);
  chain.setFetch(async () => ({ ok: true, json: async () => [] }));
  const w = await api('/v1/wallet'); assert.equal(w.body.sol, 0.5); assert.ok(w.body.spendable < 0.5);
});
test('order validation errors come back as 400 with a message', async () => {
  const r = await api('/v1/order', { method: 'POST', body: JSON.stringify({ mint: 'x', side: 'hold' }) }); assert.equal(r.status, 400); assert.match(r.body.error, /side/);
});
test('exits route needs a position; positions and orders list', async () => {
  const r = await api('/v1/exits', { method: 'POST', body: JSON.stringify({ mint: 'nope', tp: 10 }) }); assert.equal(r.status, 400);
  assert.deepEqual((await api('/v1/positions')).body, []); assert.deepEqual((await api('/v1/orders')).body, []);
});
test('withdraw: wrong password refused, right password builds + sends a transfer (send mocked)', async () => {
  const bad = await api('/v1/withdraw', { method: 'POST', body: JSON.stringify({ to: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', sol: 0.01, password: 'no' }) }); assert.match(bad.body.error, /Password/);
  const inval = await api('/v1/withdraw', { method: 'POST', body: JSON.stringify({ to: 'not-an-address', sol: 0.01, password: 'pw' }) }); assert.match(inval.body.error, /valid Solana address/);
  let rawLen = 0; order.setChainImpl({ send: async raw => { rawLen = raw.length; return 'WSIG'; }, status: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) });
  chain.rpc; // real getLatestBlockhash goes to the public RPC
  const ok = await api('/v1/withdraw', { method: 'POST', body: JSON.stringify({ to: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', sol: 0.01, password: 'pw' }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.sig, 'WSIG'); assert.ok(rawLen > 100);
  const lim = await api('/v1/withdraw', { method: 'POST', body: JSON.stringify({ to: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', sol: 1, password: 'pw' }) }); assert.match(lim.body.error, /Daily withdrawal limit/);
});
test('healthz', async () => { const r = await fetch('http://127.0.0.1:4199/healthz').then(r => r.json()); assert.equal(r.ok, true); assert.equal(r.db, 'sqlite'); });
after(() => setTimeout(() => process.exit(0), 100));
