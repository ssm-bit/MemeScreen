// ============================================================
// MemeScreen exec — who is calling.
// The app sends its Back4App session token as  Authorization: Bearer <token>.
// We ask Back4App /users/me who that is and cache the answer for 60 seconds.
// Withdrawals additionally re-check the password with /login (never stored).
// ============================================================
const B4A = process.env.BACK4APP_URL || 'https://parseapi.back4app.com';
const APP = process.env.BACK4APP_APP_ID || '';
const JS = process.env.BACK4APP_JS_KEY || '';
const cache = new Map();   // token -> { user, at }

export let fetchImpl = (...a) => fetch(...a);   // tests swap this
export function setFetch(f){ fetchImpl = f; }

export async function userFromToken(token){
  if (!token) return null;
  const c = cache.get(token); if (c && Date.now() - c.at < 60000) return c.user;
  const r = await fetchImpl(B4A + '/users/me', { headers: { 'X-Parse-Application-Id': APP, 'X-Parse-JavaScript-Key': JS, 'X-Parse-Session-Token': token } });
  if (!r.ok) return null;
  const j = await r.json(); if (!j.objectId) return null;
  const user = { id: j.objectId, username: j.username, email: j.email };
  cache.set(token, { user, at: Date.now() });
  return user;
}

export function requireUser(){
  return async (req, res, next) => {
    try {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const user = await userFromToken(m ? m[1].trim() : null);
      if (!user) return res.status(401).json({ error: 'Sign in to MemeScreen first (missing or expired session)' });
      req.user = user; next();
    } catch (e) { res.status(401).json({ error: 'Could not verify the session: ' + e.message }); }
  };
}

// fresh password check for withdrawals; returns true/false, stores nothing
export async function checkPassword(user, password){
  if (!password) return false;
  const r = await fetchImpl(B4A + '/login', { method: 'POST', headers: { 'X-Parse-Application-Id': APP, 'X-Parse-JavaScript-Key': JS, 'Content-Type': 'application/json', 'X-Parse-Revocable-Session': '1' }, body: JSON.stringify({ username: user.username, password }) });
  if (!r.ok) return false;
  const j = await r.json();
  // the login created a session we do not need: drop it
  if (j.sessionToken) fetchImpl(B4A + '/logout', { method: 'POST', headers: { 'X-Parse-Application-Id': APP, 'X-Parse-JavaScript-Key': JS, 'X-Parse-Session-Token': j.sessionToken } }).catch(() => {});
  return j.objectId === user.id;
}

// simple per-user rate limit: n calls per window
const buckets = new Map();
export function rateLimit(n, windowMs){
  return (req, res, next) => {
    const k = (req.user?.id || req.ip) + ':' + req.path; const t = Date.now();
    const b = (buckets.get(k) || []).filter(x => t - x < windowMs);
    if (b.length >= n) return res.status(429).json({ error: `Too many requests: ${n} per ${Math.round(windowMs/1000)}s` });
    b.push(t); buckets.set(k, b); next();
  };
}
