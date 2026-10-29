// ============================================================
// MemeScreen exec — the 24/7 watcher.
// Every WATCH_MS: load every armed position with an exit, price them in one batch, and when a level is crossed
// disarm the position first (so two ticks can never both fire), then sell through the same placeOrder the app uses.
// Trailing stop: sl_px follows high_px up by trail_pct.
// ============================================================
import { db, now, event } from './db.js';
import * as chain from './chain.js';
import { push } from './notify.js';

export const state = { running: false, lastTickAt: 0, lastLagMs: 0, ticks: 0, fired: 0, errors: 0 };
const cooldown = new Map();   // user:mint -> timestamp before which a failed exit is not retried
let placeOrderImpl = null;
export function setPlaceOrder(fn){ placeOrderImpl = fn; }

export async function tick(){
  const t0 = Date.now();
  const rows = await db().all('SELECT * FROM positions WHERE armed = 1 AND (tp_px IS NOT NULL OR sl_px IS NOT NULL OR trail_pct IS NOT NULL)');
  if (rows.length) {
    const px = await chain.prices(rows.map(r => r.mint));
    for (const r of rows) {
      const p = px[r.mint]; if (!(p > 0)) continue;
      if ((cooldown.get(r.user_id + ':' + r.mint) || 0) > Date.now()) continue;
      // trailing stop: ratchet the stop up with new highs
      if (r.trail_pct != null) {
        const high = Math.max(r.high_px || 0, p); const sl = high * (1 - r.trail_pct / 100);
        if (high !== r.high_px || sl > (r.sl_px || 0)) { r.sl_px = Math.max(r.sl_px || 0, sl); r.high_px = high; await db().run('UPDATE positions SET high_px = ?, sl_px = ?, updated_at = ? WHERE user_id = ? AND mint = ?', [high, r.sl_px, now(), r.user_id, r.mint]); }
      }
      const hitTP = r.tp_px != null && p >= r.tp_px, hitSL = r.sl_px != null && p <= r.sl_px;
      if (!hitTP && !hitSL) continue;
      const kind = hitTP ? 'tp' : 'sl';
      // disarm first: an exclusive update so a second tick (or a second instance) cannot fire the same exit
      const u = await db().run('UPDATE positions SET armed = 0, hit = ?, updated_at = ? WHERE user_id = ? AND mint = ? AND armed = 1', [kind, now(), r.user_id, r.mint]);
      if (!u.changes) continue;
      state.fired++;
      fire(r, kind, p).catch(() => {});
    }
  }
  state.lastTickAt = Date.now(); state.lastLagMs = state.lastTickAt - t0; state.ticks++;
}

async function fire(r, kind, p){
  const label = kind === 'tp' ? 'Take-profit' : 'Stop-loss';
  await event(r.user_id, 'exit_hit', { mint: r.mint, kind, price: p, tp: r.tp_px, sl: r.sl_px });
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await placeOrderImpl(r.user_id, { mint: r.mint, side: 'sell', pct: 100, slippageBps: 300, source: 'watcher_' + kind, symbol: r.symbol });
      await push(r.user_id, 'MemeScreen · ' + (r.symbol || r.mint.slice(0, 4)), `${label} hit at $${fmt(p)}: sold ${res.tokenIn.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${r.symbol || ''} for ◎${res.out.toFixed(4)}`, { addr: r.mint });
      await event(r.user_id, 'exit_sold', { mint: r.mint, kind, sig: res.sig });
      return;
    } catch (e) { lastErr = e; state.errors++; await new Promise(x => setTimeout(x, 2500 * attempt)); }
  }
  // could not sell: re-arm so the next tick tries again, and tell the user
  cooldown.set(r.user_id + ':' + r.mint, Date.now() + 60000);
  await db().run('UPDATE positions SET armed = 1, updated_at = ? WHERE user_id = ? AND mint = ?', [now(), r.user_id, r.mint]);
  await event(r.user_id, 'exit_failed', { mint: r.mint, kind, error: String(lastErr?.message || lastErr) });
  await push(r.user_id, 'MemeScreen · ' + (r.symbol || r.mint.slice(0, 4)), `${label} hit but the sale failed (${String(lastErr?.message || lastErr).slice(0, 80)}). Retrying.`, { addr: r.mint });
}

const fmt = x => x >= 1 ? x.toFixed(2) : x.toExponential(2).replace('e-', 'e-');

export function start(ms = +(process.env.WATCH_MS || 3000)){
  if (state.running) return; state.running = true;
  const loop = async () => { try { await tick(); } catch (e) { state.errors++; console.log('watcher tick error', e.message); } if (state.running) setTimeout(loop, ms); };
  loop();
}
export function stop(){ state.running = false; }
