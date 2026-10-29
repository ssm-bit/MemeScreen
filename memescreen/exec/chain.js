// ============================================================
// MemeScreen exec — the chain and the prices.
// RPC: RPC_URL (Helius or any paid endpoint) first, then the public endpoints that allow server-side calls.
// Prices: DexScreener in batches of 30 mints, best-liquidity pair wins.
// ============================================================
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const RPCS = [process.env.RPC_URL, 'https://solana-rpc.publicnode.com', 'https://solana.leorpc.com/?api_key=FREE', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
let conns = null;
export function connections(){ if (!conns) conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true })); return conns; }

// try each RPC in order for one call
export async function rpc(fn){
  let last; for (const c of connections()) { try { return await fn(c); } catch (e) { last = e; } }
  throw last || new Error('No Solana RPC reachable');
}

export let solBalance = async (pubkey) => (await rpc(c => c.getBalance(new PublicKey(pubkey)))) / LAMPORTS_PER_SOL;
export function setSolBalance(f){ solBalance = f; }   // test hook

export let tokenBalances = async (pubkey) => tokenBalancesChain(pubkey);
export function setTokenBalances(f){ tokenBalances = f; }   // test hook
async function tokenBalancesChain(pubkey){
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const owner = new PublicKey(pubkey);
  const [a, b] = await Promise.all([
    rpc(c => c.getParsedTokenAccountsByOwner(owner, { programId: TOKEN })),
    rpc(c => c.getParsedTokenAccountsByOwner(owner, { programId: T22 })).catch(() => ({ value: [] })),
  ]);
  const out = {};
  for (const x of [...a.value, ...b.value]) { const i = x.account.data.parsed.info; const amt = +i.tokenAmount.uiAmount || 0; if (amt > 0) { out[i.mint] = out[i.mint] || { mint: i.mint, amount: 0, decimals: i.tokenAmount.decimals }; out[i.mint].amount += amt; } }
  return Object.values(out);
}

export async function decimalsOf(mint){
  if (mint === SOL_MINT) return 9;
  const r = await rpc(c => c.getTokenSupply(new PublicKey(mint)));
  return r.value.decimals;
}

// ---- prices (USD) ----
export let fetchImpl = (...a) => fetch(...a);
export function setFetch(f){ fetchImpl = f; }
const cache = new Map();   // mint -> { px, at, sym }
export async function prices(mints, { maxAgeMs = 2500 } = {}){
  const need = [...new Set(mints)].filter(m => { const c = cache.get(m); return !c || Date.now() - c.at > maxAgeMs; });
  for (let i = 0; i < need.length; i += 30) {
    const batch = need.slice(i, i + 30);
    try {
      const r = await fetchImpl('https://api.dexscreener.com/tokens/v1/solana/' + batch.join(','), { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const pairs = await r.json();
      const best = {};
      for (const p of pairs || []) { const m = p.baseToken?.address; if (!m) continue; const liq = +p.liquidity?.usd || 0; if (!best[m] || liq > best[m].liq) best[m] = { liq, px: +p.priceUsd || 0, sym: p.baseToken?.symbol || '' }; }
      for (const m of batch) if (best[m]) cache.set(m, { px: best[m].px, sym: best[m].sym, at: Date.now() });
    } catch {}
  }
  const out = {}; for (const m of mints) { const c = cache.get(m); if (c) out[m] = c.px; }
  return out;
}
export async function solPrice(){ const p = await prices([SOL_MINT], { maxAgeMs: 20000 }); return p[SOL_MINT] || 0; }
export function symbolOf(mint){ return cache.get(mint)?.sym || ''; }
