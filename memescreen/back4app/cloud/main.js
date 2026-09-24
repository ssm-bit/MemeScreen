// OPTIONAL Back4App Cloud Code  (Dashboard → Cloud Code → cloud/main.js → paste → Deploy)
// Gives the dashboard its BTC / ETH / SOL / total-market-cap tiles without browser CORS limits.
// The app works without this; those four tiles just stay on "—" for anything the browser can't fetch itself.
let cache = { at: 0, data: null };
Parse.Cloud.define('market', async () => {
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;
  const out = {};
  try {
    const p = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true')).json();
    if (p.bitcoin) out.btc = p.bitcoin; if (p.ethereum) out.eth = p.ethereum; if (p.solana) out.sol = p.solana;
  } catch (e) {}
  try { const g = await (await fetch('https://api.coingecko.com/api/v3/global')).json(); out.mcap = g.data.total_market_cap.usd; out.mcapChg = g.data.market_cap_change_percentage_24h_usd; } catch (e) {}
  cache = { at: Date.now(), data: out };
  return out;
});

// Keep nicknames sane and make sure every leaderboard row belongs to the user who wrote it.
Parse.Cloud.beforeSave('Leaderboard', req => {
  if (!req.user) throw 'Sign in first';
  req.object.set('owner', req.user);
  req.object.set('nickname', String(req.user.get('nickname') || 'trader').slice(0, 20));
});
