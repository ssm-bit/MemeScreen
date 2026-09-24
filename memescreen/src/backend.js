// ============================================================
// MemeScreen — backend adapter.
// One interface, two implementations (Back4App/Parse REST and the Express server).
// app.js only ever talks to `backend.*`, so switching backends never touches app logic.
//
//   register / login / me / logout          → accounts (many users, each isolated)
//   listAccounts / saveAccount / deleteAccount → a user's paper-trading accounts (as many as they want)
//   getProfile / saveProfile                → watchlist, alert rules, indicator prefs, active account
//   syncLeaderboard / leaderboard           → competitions
//   market / health
// ============================================================
import CONFIG from './config.js';

const ls = { get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

// ---------- which backend ----------
export function settings(){
  // config.js is the source of truth. A choice made in the Server window is honoured only when it was saved
  // explicitly (o.chosen) — an old leftover entry can no longer send the app to a server that is not running.
  let o = ls.get('ms_backend') || {};
  if (!o.chosen) o = {};
  const b4 = { ...CONFIG.back4app, ...(o.back4app||{}) };
  let kind = (CONFIG.backend && CONFIG.backend !== 'auto' && !o.chosen) ? CONFIG.backend : (o.backend || CONFIG.backend || 'auto');
  if (kind === 'auto') kind = (b4.appId && b4.jsKey) ? 'back4app' : 'express';
  const legacy = (() => { try { return localStorage.getItem('ms_api'); } catch { return null; } })();
  const host = (location.protocol.startsWith('http') && location.hostname && !/(^|\.)localhost$/.test(location.hostname)) ? location.hostname : 'localhost';
  const expressUrl = (o.expressUrl || legacy || CONFIG.expressUrl || ('http://' + host + ':4000')).replace(/\/$/, '');
  return { kind, back4app: b4, expressUrl };
}
export function saveSettings(patch){ ls.set('ms_backend', { ...(ls.get('ms_backend')||{}), ...patch, chosen:true }); }
export function resetSettings(){ try { localStorage.removeItem('ms_backend'); } catch {} }

// ---------- session ("keep me signed in") ----------
// remember = true  → localStorage  (survives closing the browser)
// remember = false → sessionStorage (gone when the tab/browser closes)
const SKEY = 'ms_session';
export const session = {
  get(){ try { return JSON.parse(sessionStorage.getItem(SKEY) || localStorage.getItem(SKEY) || 'null'); } catch { return null; } },
  set(s, remember){ this.clear(); try { (remember ? localStorage : sessionStorage).setItem(SKEY, JSON.stringify({ ...s, remember: !!remember })); } catch {} },
  clear(){ try { localStorage.removeItem(SKEY); sessionStorage.removeItem(SKEY); localStorage.removeItem('ms_token'); } catch {} },
};
// one-time migration from the old token-only storage
(function(){ try { const t = localStorage.getItem('ms_token'); if (t && !session.get()) session.set({ token: t, kind: 'express', user: null }, true); localStorage.removeItem('ms_token'); } catch {} })();

class HttpError extends Error { constructor(msg, status){ super(msg); this.status = status; } }
const isAuthError = e => e && (e.status === 401 || e.status === 403 || e.code === 209);

// ============================================================
// Express implementation
// ============================================================
function expressBackend(cfg){
  const base = cfg.expressUrl + '/api';
  async function call(path, { method='GET', body, authed=true } = {}){
    const headers = { 'Content-Type': 'application/json' };
    const s = session.get(); if (authed && s?.token) headers.Authorization = 'Bearer ' + s.token;
    let r; try { r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new HttpError('Can\'t reach the server at ' + cfg.expressUrl + ' — is it running?', 0); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(data.error || ('HTTP ' + r.status), r.status);
    return data;
  }
  return {
    kind: 'express', label: 'MemeScreen server · ' + cfg.expressUrl,
    async health(){ try { const r = await fetch(base + '/health'); return r.ok; } catch { return false; } },
    async register({ email, password, nickname }, remember){ const d = await call('/register', { method:'POST', authed:false, body:{ email, password, nickname } }); session.set({ token:d.token, user:d.user, kind:'express' }, remember); return d.user; },
    async login({ email, password }, remember){ const d = await call('/login', { method:'POST', authed:false, body:{ email, password } }); session.set({ token:d.token, user:d.user, kind:'express' }, remember); return d.user; },
    async me(){ const d = await call('/me'); if (!d.user) throw new HttpError('Session expired — sign in again', 401); return d.user; },
    async logout(){ session.clear(); },
    async listAccounts(){ return (await call('/accounts')).accounts; },
    async saveAccount(a){ return (await call('/accounts/' + encodeURIComponent(a.name), { method:'PUT', body:{ size:a.size, state:a.state } })).account; },
    async deleteAccount(name){ await call('/accounts/' + encodeURIComponent(name), { method:'DELETE' }); },
    async getProfile(){ return (await call('/profile')).profile || {}; },
    async saveProfile(p){ await call('/profile', { method:'PUT', body:{ profile:p } }); },
    async syncLeaderboard(b){ await call('/leaderboard/sync', { method:'POST', body:b }); },
    async leaderboard(period){ const d = await call('/leaderboard?period=' + period, { authed:false }); return d.rows.map(r => ({ nickname:r.nickname, return_pct:+r.return_pct, avg_grade_idx:+r.avg_grade_idx, trades:+r.trades, score:+r.score })); },
    async market(){ return call('/market', { authed:false }); },
    async listCompetitions(){ return (await call('/competitions')).competitions; },
    async createCompetition(name){ return (await call('/competitions', { method:'POST', body:{ name } })).competition; },
    async joinCompetition(code){ return (await call('/competitions/join', { method:'POST', body:{ code } })).competition; },
    async leaveCompetition(code){ await call('/competitions/' + encodeURIComponent(code) + '/leave', { method:'POST' }); },
    async deleteMe(){ await call('/me', { method:'DELETE' }); session.clear(); },
  };
}

// ============================================================
// Back4App (Parse Server REST API) implementation
//   _User            → accounts. Parse hashes passwords with bcrypt; they are never readable.
//   PaperAccount     → { owner, name, size, state }   ACL: owner only
//   Profile          → { owner, data }                ACL: owner only
//   Leaderboard      → { owner, period, weekId, nickname, returnPct, avgGradeIdx, trades, score }  ACL: public read, owner write
// Classes are created automatically on first save (Back4App default). See BACK4APP-SETUP.md to lock them down.
// ============================================================
function back4appBackend(cfg){
  const { appId, jsKey } = cfg.back4app; const url = cfg.back4app.serverUrl.replace(/\/$/, '');
  const ids = {};                                  // name → objectId cache for PaperAccount rows
  let profileId = null;
  async function call(path, { method='GET', body, params, authed=true } = {}){
    const headers = { 'X-Parse-Application-Id': appId, 'X-Parse-JavaScript-Key': jsKey, 'Content-Type': 'application/json' };
    const s = session.get(); if (authed && s?.token) headers['X-Parse-Session-Token'] = s.token;
    const qs = params ? '?' + Object.entries(params).map(([k,v]) => k + '=' + encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))).join('&') : '';
    let r; try { r = await fetch(url + path + qs, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
    catch { throw new HttpError('Can\'t reach Back4App — check your connection and keys', 0); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const nice = { 101:'Wrong email or password', 202:'That email is already registered', 203:'That email is already registered', 125:'Enter a valid email', 209:'Session expired — sign in again' }[data.code]; const e = new HttpError(nice || data.error || ('HTTP ' + r.status), data.code === 209 ? 401 : r.status); e.code = data.code; throw e; }
    return data;
  }
  const me = () => session.get()?.user;
  const ptr = () => ({ __type:'Pointer', className:'_User', objectId: me().id });
  const ownerAcl = () => ({ [me().id]: { read:true, write:true } });
  const toUser = u => ({ id:u.objectId, email:u.email || u.username, nickname:u.nickname || (u.username||'').split('@')[0] });
  return {
    kind: 'back4app', label: 'Back4App · ' + appId.slice(0,6) + '…',
    async health(){ try { await call('/health', { authed:false }); return true; } catch (e) { return e.status !== 0 && e.status !== 401 && e.status !== 403 ? true : false; } },
    async register({ email, password, nickname }, remember){
      email = (email||'').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError('Enter a valid email', 400);
      if (!password || password.length < 8) throw new HttpError('Password must be at least 8 characters', 400);
      nickname = (nickname || email.split('@')[0]).trim().slice(0,20);
      const d = await call('/users', { method:'POST', authed:false, body:{ username:email, email, password, nickname } });
      const user = { id:d.objectId, email, nickname }; session.set({ token:d.sessionToken, user, kind:'back4app' }, remember); return user;
    },
    async login({ email, password }, remember){ const d = await call('/login', { method:'POST', authed:false, body:{ username:(email||'').trim().toLowerCase(), password } }); const user = toUser(d); session.set({ token:d.sessionToken, user, kind:'back4app' }, remember); return user; },
    async me(){ const u = toUser(await call('/users/me')); const s = session.get(); session.set({ ...s, user:u }, s.remember); return u; },
    async logout(){ try { await call('/logout', { method:'POST' }); } catch {} session.clear(); },
    async listAccounts(){
      const d = await call('/classes/PaperAccount', { params:{ where:{ owner:ptr() }, limit:'100', order:'createdAt' } });
      return d.results.map(r => { ids[r.name] = r.objectId; return { name:r.name, size:r.size, state:r.state||null, updatedAt:+new Date(r.updatedAt) }; });
    },
    async saveAccount(a){
      const body = { name:a.name, size:a.size, state:a.state };
      if (!ids[a.name]) { const f = await call('/classes/PaperAccount', { params:{ where:{ owner:ptr(), name:a.name }, limit:'1' } }); if (f.results[0]) ids[a.name] = f.results[0].objectId; }
      if (ids[a.name]) { const d = await call('/classes/PaperAccount/' + ids[a.name], { method:'PUT', body }); return { name:a.name, size:a.size, updatedAt:+new Date(d.updatedAt) }; }
      const d = await call('/classes/PaperAccount', { method:'POST', body:{ ...body, owner:ptr(), ACL:ownerAcl() } }); ids[a.name] = d.objectId; return { name:a.name, size:a.size, updatedAt:+new Date(d.createdAt) };
    },
    async deleteAccount(name){ if (!ids[name]) await this.listAccounts(); if (ids[name]) { await call('/classes/PaperAccount/' + ids[name], { method:'DELETE' }); delete ids[name]; } },
    async getProfile(){ const d = await call('/classes/Profile', { params:{ where:{ owner:ptr() }, limit:'1' } }); const r = d.results[0]; profileId = r?.objectId || null; return r?.data || {}; },
    async saveProfile(p){ if (profileId) await call('/classes/Profile/' + profileId, { method:'PUT', body:{ data:p } }); else { const d = await call('/classes/Profile', { method:'POST', body:{ data:p, owner:ptr(), ACL:ownerAcl() } }); profileId = d.objectId; } },
    async syncLeaderboard(b){
      const acl = { '*':{ read:true }, [me().id]:{ read:true, write:true } };
      for (const period of ['week','all']){
        const weekId = period === 'week' ? b.weekId : '';
        const row = { period, weekId, nickname: me().nickname, equity:b.equity, returnPct: period==='week' ? b.returnWeek : b.returnAll, avgGradeIdx:b.avgGradeIdx, trades:b.trades, score: period==='week' ? b.scoreWeek : b.scoreAll };
        const f = await call('/classes/Leaderboard', { params:{ where:{ owner:ptr(), period, weekId }, limit:'1' } });
        if (f.results[0]) await call('/classes/Leaderboard/' + f.results[0].objectId, { method:'PUT', body:row });
        else await call('/classes/Leaderboard', { method:'POST', body:{ ...row, owner:ptr(), ACL:acl } });
      }
    },
    async leaderboard(period, weekId){ const d = await call('/classes/Leaderboard', { authed:false, params:{ where:{ period, weekId: period==='week' ? weekId : '' }, order:'-score', limit:'100' } }); return d.results.map(r => ({ nickname:r.nickname, return_pct:r.returnPct, avg_grade_idx:r.avgGradeIdx, trades:r.trades, score:r.score })); },
    // optional Cloud Code function (back4app/cloud/main.js). Without it the dashboard falls back to browser-side sources.
    async market(){ const d = await call('/functions/market', { method:'POST', authed:false, body:{} }); return d.result || {}; },
    // Competition: { name, code, ownerNick, members:[nicknames], memberIds:[userIds] }  public read, public write (so anyone can join)
    async listCompetitions(){ const d = await call('/classes/Competition', { params:{ order:'-createdAt', limit:'100' } }); return d.results.map(c => ({ id:c.objectId, name:c.name, code:c.code, by:c.ownerNick, members:c.members||[], mine:(c.memberIds||[]).includes(me().id) })); },
    async createCompetition(name){ const code = Math.random().toString(36).slice(2,8).toUpperCase(); const d = await call('/classes/Competition', { method:'POST', body:{ name:String(name).slice(0,40), code, owner:ptr(), ownerNick:me().nickname, members:[me().nickname], memberIds:[me().id], ACL:{ '*':{ read:true, write:true } } } }); return { id:d.objectId, name, code, by:me().nickname, members:[me().nickname], mine:true }; },
    async joinCompetition(code){ code = String(code||'').trim().toUpperCase(); const f = await call('/classes/Competition', { params:{ where:{ code }, limit:'1' } }); const c = f.results[0]; if (!c) throw new HttpError('No competition with code ' + code, 404);
      if (!(c.memberIds||[]).includes(me().id)) await call('/classes/Competition/' + c.objectId, { method:'PUT', body:{ members:{ __op:'AddUnique', objects:[me().nickname] }, memberIds:{ __op:'AddUnique', objects:[me().id] } } });
      return { id:c.objectId, name:c.name, code:c.code, by:c.ownerNick, members:[...new Set([...(c.members||[]), me().nickname])], mine:true }; },
    async leaveCompetition(code){ const f = await call('/classes/Competition', { params:{ where:{ code }, limit:'1' } }); const c = f.results[0]; if (!c) return; await call('/classes/Competition/' + c.objectId, { method:'PUT', body:{ members:{ __op:'Remove', objects:[me().nickname] }, memberIds:{ __op:'Remove', objects:[me().id] } } }); },
    async deleteMe(){ const id = me().id; try { for (const cls of ['PaperAccount','Profile','Leaderboard']) { const d = await call('/classes/' + cls, { params:{ where:{ owner:ptr() }, limit:'200' } }); for (const r of d.results) await call('/classes/' + cls + '/' + r.objectId, { method:'DELETE' }); } } catch {} await call('/users/' + id, { method:'DELETE' }); session.clear(); },
  };
}

export function createBackend(){ const cfg = settings(); return cfg.kind === 'back4app' ? back4appBackend(cfg) : expressBackend(cfg); }
export { isAuthError };
