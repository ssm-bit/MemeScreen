// ============================================================
// MemeScreen exec — key custody.
// One Solana keypair per user. The 64-byte secret is encrypted with AES-256-GCM under MASTER_KEY
// (32 bytes, hex, from the environment) and only ever decrypted inside a request, never cached.
// The public key is the only thing that leaves this module in plain text.
// ============================================================
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

function masterKey(){
  const hex = process.env.MASTER_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('MASTER_KEY must be 64 hex characters (openssl rand -hex 32)');
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(secret64){
  if (!(secret64 instanceof Uint8Array) || secret64.length !== 64) throw new Error('secret must be 64 bytes');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(Buffer.from(secret64)), c.final(), c.getAuthTag()]);
  return { enc: enc.toString('hex'), iv: iv.toString('hex') };
}

export function decryptSecret(encHex, ivHex){
  const buf = Buffer.from(encHex, 'hex'); const tag = buf.subarray(buf.length - 16); const body = buf.subarray(0, buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
}

export function newWallet(){
  const kp = Keypair.generate();
  const { enc, iv } = encryptSecret(kp.secretKey);
  kp.secretKey.fill(0);
  return { pubkey: kp.publicKey.toBase58(), enc, iv };
}

// run fn(keypair) and wipe the secret afterwards, whatever happens
export async function withKeypair(row, fn){
  const secret = decryptSecret(row.enc_secret, row.iv);
  const kp = Keypair.fromSecretKey(secret);
  try { return await fn(kp); }
  finally { secret.fill(0); try { kp.secretKey.fill(0); } catch {} }
}

// a log filter: refuses to print anything that looks like a 64-byte base58 secret
const B58_64 = /[1-9A-HJ-NP-Za-km-z]{85,90}/;
export function safeLog(...a){
  const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  if (B58_64.test(s)) { console.log('[redacted: looked like a secret key]'); return; }
  console.log(s);
}

export function constEq(a, b){ const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
