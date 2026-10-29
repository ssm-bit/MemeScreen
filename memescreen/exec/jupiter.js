// ============================================================
// MemeScreen exec — Jupiter quote and swap build (same calls the web app makes in src/live.js, run server side).
// ============================================================
const LITE = 'https://lite-api.jup.ag/swap/v1', PRO = 'https://api.jup.ag/swap/v1';
export let fetchImpl = (...a) => fetch(...a);
export function setFetch(f){ fetchImpl = f; }

async function jup(path, opts = {}){
  const key = process.env.JUPITER_KEY || '';
  const hosts = key ? [[PRO, { 'x-api-key': key }], [LITE, {}]] : [[LITE, {}]];
  let last;
  for (const [h, hd] of hosts) {
    try {
      const r = await fetchImpl(h + path, { ...opts, headers: { 'content-type': 'application/json', ...hd, ...(opts.headers || {}) } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || ('Jupiter ' + r.status));
      return j;
    } catch (e) { last = e; }
  }
  throw last || new Error('Jupiter unreachable');
}

export async function quote({ inputMint, outputMint, amount, slippageBps = 150 }){
  const q = await jup(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amount)}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
  if (!q.outAmount) throw new Error(q.error || 'No route for this size');
  return q;
}

// returns base64 VersionedTransaction. An optional platform fee (basis points) goes to FEE_ACCOUNT (a wrapped-SOL token account we own).
export async function buildSwap(quoteResponse, userPublicKey){
  const body = { quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2000000, priorityLevel: 'high' } } };
  if (process.env.FEE_ACCOUNT) body.feeAccount = process.env.FEE_ACCOUNT;
  const j = await jup('/swap', { method: 'POST', body: JSON.stringify(body) });
  if (!j.swapTransaction) throw new Error(j.error || 'Jupiter did not return a transaction');
  return j.swapTransaction;
}
export const feeBps = () => +(process.env.PLATFORM_FEE_BPS || 0);
