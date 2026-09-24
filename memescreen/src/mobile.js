// ============================================================
// MemeScreen — phone behaviour layer.
// app.js is untouched by this file: it only re-arranges the same DOM for a phone
// (segments inside Trade, account row in Settings, long-press on the chart).
// Active whenever <html> has the "mobile" class (set in index.html).
// ============================================================
const root = document.documentElement;
const isMobile = () => root.classList.contains('mobile');
const $ = id => document.getElementById(id);
const SHORT = { dash: 'Home', screen: 'Screen', trade: 'Trade', news: 'News', portfolio: 'Portfolio', comp: 'Compete', settings: 'Settings' };
const LONG = { dash: 'Dashboard', screen: 'Screener', trade: 'Trade', news: 'News', portfolio: 'Portfolio', comp: 'Competitions', settings: 'Settings' };

// ---------- Trade segments ----------
const terminal = document.querySelector('.terminal');
const segs = document.createElement('div');
segs.className = 'm-segs';
segs.innerHTML = '<button data-seg="list">Markets</button><button data-seg="chart">Chart &amp; trade</button><button data-seg="pos">Positions<span class="cnt" id="mPosCnt"></span></button>';
terminal.parentNode.insertBefore(segs, terminal);
const fab = document.createElement('button');
fab.className = 'm-fab'; fab.id = 'mFab'; fab.type = 'button';
document.body.appendChild(fab);

function setSeg(s, { scroll = true } = {}) {
  terminal.dataset.seg = s;
  segs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.seg === s));
  if (scroll && isMobile()) { const sc = $('app'); sc.scrollTo({ top: Math.max(0, terminal.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - segs.offsetHeight), behavior: 'instant' }); }
  // the chart was laid out while hidden — let KLineChart measure its real box now
  if (s === 'chart') setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  updateFab(); updateCount();
}
segs.addEventListener('click', e => { const b = e.target.closest('button[data-seg]'); if (b) setSeg(b.dataset.seg); });
setSeg('list', { scroll: false });

// picking a token (Markets list, dashboard "open in terminal") jumps to its chart
document.addEventListener('click', e => {
  if (!isMobile()) return;
  if (e.target.closest('.star')) return;
  if (e.target.closest('tr.tok') || e.target.closest('#featOpen')) setSeg('chart');
  else if (e.target.closest('#railMore')) setSeg('list');
  else if (e.target.closest('#nav button[data-v=trade]') && !document.querySelector('#detail .hdr')) setSeg('list');
});
// floating "Trade" button: visible on the chart segment while the ticket is off-screen
function updateFab() {
  const onTrade = $('v-trade')?.classList.contains('on') && $('app').style.display !== 'none';
  const op = $('orderpanel'); const sym = document.querySelector('#detail .hdr .sym')?.textContent;
  if (!isMobile() || !onTrade || terminal.dataset.seg !== 'chart' || !sym || !op) return fab.classList.remove('show');
  const r = op.getBoundingClientRect();
  fab.textContent = 'Trade ' + sym + ' ↓';
  fab.classList.toggle('show', r.top > window.innerHeight - 120);
}
fab.onclick = () => $('orderpanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
window.addEventListener('scroll', updateFab, { passive: true });
$('app').addEventListener('scroll', updateFab, { passive: true });   // on a phone #app is the scroller (the page itself is locked)
// stop two-finger zoom and sideways drags from moving the page
['gesturestart','gesturechange','gestureend'].forEach(t => document.addEventListener(t, e => { if (isMobile()) e.preventDefault(); }, { passive: false }));

function updateCount() { if (!$('mPosCnt')) return;
  const n = document.querySelectorAll('#bottomPanel tr.pos').length;
  const c = $('mPosCnt'); if (c && $('bottomPanel') && document.querySelector('.tbt.on')?.dataset.bt === 'positions') c.textContent = n ? n : '';
}
setInterval(() => { if (isMobile()) { updateCount(); updateFab(); } }, 1000);

// ---------- long-press on the chart = the desktop right-click order menu ----------
let lp = null;
document.addEventListener('touchstart', e => {
  const kc = e.target.closest && e.target.closest('#kc'); if (!kc || e.touches.length !== 1) return;
  const t = e.touches[0], x0 = t.clientX, y0 = t.clientY;
  clearTimeout(lp?.h);
  lp = { x0, y0, h: setTimeout(() => {
    const r = kc.getBoundingClientRect();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x0, clientY: y0 });
    // offsetX/Y are what app.js reads; define them explicitly so the price maps to the finger, not the canvas child
    Object.defineProperty(ev, 'offsetX', { value: x0 - r.left }); Object.defineProperty(ev, 'offsetY', { value: y0 - r.top });
    kc.dispatchEvent(ev); if (navigator.vibrate) navigator.vibrate(12);
  }, 550) };
}, { passive: true });
const cancelLP = e => { if (!lp) return; const t = e.touches && e.touches[0]; if (!t || Math.hypot(t.clientX - lp.x0, t.clientY - lp.y0) > 10) { clearTimeout(lp.h); lp = null; } };
document.addEventListener('touchmove', cancelLP, { passive: true });
document.addEventListener('touchend', () => { clearTimeout(lp?.h); lp = null; }, { passive: true });

// ---------- apply / undo the phone arrangement ----------
const who = document.querySelector('.wallet .who');
const whoHome = who?.parentNode;
let acctRow = null, last = null;
function apply() {
  const m = isMobile(); if (m === last) return; last = m;
  // tab bar labels
  document.querySelectorAll('#nav button').forEach(b => { const n = [...b.childNodes].find(x => x.nodeType === 3); if (n) n.nodeValue = (m ? SHORT : LONG)[b.dataset.v]; });
  // nickname + log out move into Settings → Account (the header has no room for them)
  if (who) {
    if (m) { if (!acctRow) { acctRow = document.createElement('div'); acctRow.className = 'm-account'; } const a = $('acct'); if (a && acctRow.parentNode !== a.parentNode) a.after(acctRow); acctRow.appendChild(who); }
    else { whoHome.appendChild(who); acctRow?.remove(); }
  }
  let tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.content = '#14161C';
  updateFab();
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
}
new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
apply();
