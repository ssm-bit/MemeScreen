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

// ---------- Push notifications through Expo ----------
// The iPhone app registers its Expo Push Token in the PushDevice class (owner, token, platform) when a user signs in.
// sendPush: one token. pushToUser: every phone of one user. Both post to Expo's push API, which delivers through
// Apple APNs / Google FCM. In Expo Go, Expo's own credentials are used; a store build needs the team's credentials in EAS.
async function expoSend(messages) {
  const r = await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(messages) });
  return r.json();
}
Parse.Cloud.define('sendPush', async req => {
  const { token, title, message, data } = req.params || {};
  if (!token || !title) throw 'token and title are required';
  if (!/^Expo(nent)?PushToken\[/.test(token)) throw 'Not an Expo push token';
  return expoSend([{ to: token, title, body: message || '', data: data || {}, sound: 'default' }]);
});
Parse.Cloud.define('pushToUser', async req => {
  const { userId, title, message, data } = req.params || {};
  if (!userId || !title) throw 'userId and title are required';
  const q = new Parse.Query('PushDevice'); q.equalTo('owner', Parse.User.createWithoutData(userId)); q.limit(20);
  const devices = await q.find({ useMasterKey: true });
  if (!devices.length) return { sent: 0 };
  const res = await expoSend(devices.map(d => ({ to: d.get('token'), title, body: message || '', data: data || {}, sound: 'default' })));
  return { sent: devices.length, res };
});
// a user may only ever read and write their own push devices
Parse.Cloud.beforeSave('PushDevice', req => {
  if (!req.user) throw 'Sign in first';
  req.object.set('owner', req.user);
  const acl = new Parse.ACL(req.user); req.object.setACL(acl);
});
