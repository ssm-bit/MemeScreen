import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.MASTER_KEY = randomBytes(32).toString('hex');
process.env.SQLITE_FILE = ':memory:';
process.env.BACK4APP_APP_ID = 'app'; process.env.BACK4APP_JS_KEY = 'js';
const { open, db, now } = await import('../db.js');
const keys = await import('../keys.js');
const auth = await import('../auth.js');
const chain = await import('../chain.js');
const order = await import('../order.js');
const watcher = await import('../watcher.js');
const notify = await import('../notify.js');
const { Keypair, VersionedTransaction } = await import('@solana/web3.js');
const nacl = (await import('tweetnacl')).default;

before(async () => { await open(); });

test('keys: encrypt/decrypt round trip, wrong key fails, secret never serialized', () => {
  const w = keys.newWallet();
  assert.match(w.pubkey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const sec = keys.decryptSecret(w.enc, w.iv);
  assert.equal(sec.length, 64);
  assert.equal(Keypair.fromSecretKey(sec).publicKey.toBase58(), w.pubkey);
  const saved = process.env.MASTER_KEY; process.env.MASTER_KEY = randomBytes(32).toString('hex');
  assert.throws(() => keys.decryptSecret(w.enc, w.iv));
  process.env.MASTER_KEY = saved;
  assert.ok(!JSON.stringify({ pubkey: w.pubkey, enc_secret: w.enc, iv: w.iv }).includes(Buffer.from(sec).toString('base64')));
});

test('auth: token → user via mocked /users/me, cached, 401 path', async () => {
  let calls = 0;
  auth.setFetch(async (url, o) => { calls++; if (o.headers['X-Parse-Session-Token'] === 'good') return { ok: true, json: async () => ({ objectId: 'u1', username: 'mullah' }) }; return { ok: false, json: async () => ({}) }; });
  const u = await auth.userFromToken('good'); assert.equal(u.id, 'u1');
  await auth.userFromToken('good'); assert.equal(calls, 1, 'cached');
  assert.equal(await auth.userFromToken('bad'), null);
  assert.equal(await auth.userFromToken(''), null);
});

test('db: wallet row + order row + position math', async () => {
  const w = keys.newWallet();
  await db().run('INSERT INTO wallets (user_id, pubkey, enc_secret, iv, created_at) VALUES (?,?,?,?,?)', ['u1', w.pubkey, w.enc, w.iv, now()]);
  const row = await order.getWallet('u1'); assert.equal(row.pubkey, w.pubkey);
  await keys.withKeypair(row, async kp => { assert.equal(kp.publicKey.toBase58(), w.pubkey); });
});

test('watcher: SL fires once, disarms, sells via placeOrder, re-arms on failure', async () => {
  const mint = 'MINT1111111111111111111111111111111111111111';
  await db().run('INSERT INTO positions (user_id, mint, symbol, qty, cost_usd, sol_in, entry_px, tp_px, sl_px, armed, opened_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)', ['u1', mint, 'TST', 100, 10, 0.1, 0.1, 0.2, 0.08, now(), now()]);
  chain.setFetch(async () => ({ ok: true, json: async () => [{ baseToken: { address: mint, symbol: 'TST' }, priceUsd: '0.09', liquidity: { usd: 1000 } }] }));
  notify.setFetch(async () => ({ ok: true, json: async () => ({ result: { sent: 1 } }) }));
  let sells = 0; watcher.setPlaceOrder(async () => { sells++; return { sig: 'sig1', out: 0.05, tokenIn: 100 }; });
  await watcher.tick(); assert.equal(sells, 0, 'price 0.09 is above SL 0.08');
  chain.setFetch(async () => ({ ok: true, json: async () => [{ baseToken: { address: mint, symbol: 'TST' }, priceUsd: '0.07', liquidity: { usd: 1000 } }] }));
  await new Promise(r => setTimeout(r, 2600));   // price cache maxAge
  await watcher.tick(); await new Promise(r => setTimeout(r, 50));
  assert.equal(sells, 1); const p = await order.getPosition('u1', mint); assert.equal(p.armed, 0); assert.equal(p.hit, 'sl');
  await watcher.tick(); assert.equal(sells, 1, 'does not fire twice');
  // failure path: re-arm with a failing seller
  await db().run('UPDATE positions SET armed = 1, hit = NULL WHERE user_id = ? AND mint = ?', ['u1', mint]);
  process.env.BACK4APP_MASTER_KEY = 'mk';
  watcher.setPlaceOrder(async () => { throw new Error('slippage'); });
  await new Promise(r => setTimeout(r, 2600)); await watcher.tick(); await new Promise(r => setTimeout(r, 16000));
  const p2 = await order.getPosition('u1', mint); assert.equal(p2.armed, 1, 're-armed after 3 failed attempts');
});

test('watcher: trailing stop ratchets up', async () => {
  const mint = 'MINT2222222222222222222222222222222222222222';
  await db().run('INSERT INTO positions (user_id, mint, symbol, qty, cost_usd, sol_in, entry_px, trail_pct, high_px, armed, opened_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)', ['u1', mint, 'TR', 10, 10, 0.1, 1.0, 10, 1.0, now(), now()]);
  chain.setFetch(async () => ({ ok: true, json: async () => [{ baseToken: { address: mint, symbol: 'TR' }, priceUsd: '2.0', liquidity: { usd: 1000 } }] }));
  watcher.setPlaceOrder(async () => ({ sig: 's', out: 1, tokenIn: 10 }));
  await watcher.tick();
  const p = await order.getPosition('u1', mint); assert.equal(p.high_px, 2.0); assert.ok(Math.abs(p.sl_px - 1.8) < 1e-9); assert.equal(p.armed, 1);
});

test('order path: real Jupiter quote + swap build, signed with the wallet, send mocked', { timeout: 60000 }, async () => {
  if (!process.env.REAL) { console.log('skip (REAL=1 to hit Jupiter)'); return; }
  const w = keys.newWallet();
  await db().run('INSERT INTO wallets (user_id, pubkey, enc_secret, iv, created_at) VALUES (?,?,?,?,?)', ['u2', w.pubkey, w.enc, w.iv, now()]);
  chain.setFetch((...a) => fetch(...a));
  const sent = [];
  order.setChainImpl({ send: async raw => { const tx = VersionedTransaction.deserialize(raw); const sig = tx.signatures[0]; const ok = nacl.sign.detached.verify(tx.message.serialize(), sig, Keypair.fromSecretKey(keys.decryptSecret(w.enc, w.iv)).publicKey.toBytes()); assert.ok(ok, 'signature verifies'); sent.push(raw.length); return 'FAKESIG' + 'x'.repeat(80); }, status: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) });
  // the fresh wallet has no SOL: the pre-check must refuse a buy
  await assert.rejects(order.placeOrder('u2', { mint: '7fumw7GYTHZJJxkKJ8sSh1CqTdHmB234vX3xsKjepump', side: 'buy', solIn: 0.01 }), /Wallet has/);
  // bypass the balance check to exercise quote → build → sign → send → bookkeeping
  const bal = chain.solBalance; chain.setSolBalance(async () => 1);
  const r = await order.placeOrder('u2', { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', side: 'buy', solIn: 0.01, tp: 50, sl: 25 });   // BONK
  chain.setSolBalance(bal);
  assert.equal(r.status, 'confirmed'); assert.ok(sent[0] > 400, 'a real swap tx was serialized'); assert.ok(r.out > 0);
  const p = await order.getPosition('u2', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  assert.ok(p.entry_px > 0); assert.ok(Math.abs(p.tp_px / p.entry_px - 1.5) < 1e-9); assert.ok(Math.abs(p.sl_px / p.entry_px - 0.75) < 1e-9);
  const o = (await db().all('SELECT * FROM orders WHERE user_id = ?', ['u2'])).find(x => x.status === 'confirmed'); assert.ok(o.tx_sig.startsWith('FAKESIG'));
});
