// ============================================================
// Backend: see backend.js + config.js (Back4App or the Express server — same app either way)
// ============================================================
import * as DT from './drawtools.js';
import * as SCR from './screener.js';
import * as WAL from './wallet.js';
import { createBackend, session, settings as backendSettings, saveSettings as saveBackendSettings, resetSettings as resetBackendSettings, isAuthError } from './backend.js';
let backend = createBackend();

// ---------- NEWS SOURCES CONFIG ----------
// Primary: cryptocurrency.cv (free, no key, CORS, 300+ sources incl. Solana/altcoins).
// Fallbacks: major-outlet RSS via rss2json. Tried top-to-bottom until one returns articles.
const NEWS_SOURCES = {
  cv: [
    'https://cryptocurrency.cv/api/news?limit=50',
  ],
  rss: [
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://decrypt.co/feed',
    'https://cryptoslate.com/feed/',
    'https://bitcoinmagazine.com/.rss/full/',
    'https://cryptopotato.com/feed/',
    'https://beincrypto.com/feed/',
  ],
};
// a saved session only counts for the backend it was created on
if (session.get() && session.get().kind && session.get().kind !== backend.kind) session.clear();
let TOKEN = session.get()?.token || null;          // truthy = signed in
let ME = session.get()?.user || null, guest = false;
const signedIn = () => !!TOKEN && !guest;

// ---------- constants (restored) ----------
const START = 10000, PLATFORM = 0.01, LP = 0.003, NET = 0.10, GRADES = ['F','D','C','B','A'];
const ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0A0D12"/><circle cx="50" cy="50" r="36" fill="none" stroke="#22E4A0" stroke-width="6"/><path d="M57 31L70 26" fill="none" stroke="#22E4A0" stroke-width="5" stroke-linecap="round"/><rect x="31" y="38" width="10" height="13" rx="2.5" fill="#22E4A0"/><rect x="59" y="38" width="10" height="13" rx="2.5" fill="#22E4A0"/><path d="M33 66Q50 68 67 58" fill="none" stroke="#22E4A0" stroke-width="5.5" stroke-linecap="round"/></svg>');

// ---------- global news feed (ticker + alerts) ----------
let globalNews = [], newsSeen = new Set();
async function loadNewsFromCV(){
  for (const url of NEWS_SOURCES.cv){
    try {
      const r = await fetch(url, { headers:{ accept:'application/json' } });
      if(!r.ok) continue;
      const j = await r.json();
      const arr = j.articles || j.results || j.data || j.items || j.news || [];
      if(!Array.isArray(arr) || !arr.length) continue;
      return arr.map(a=>({ title:a.title||a.headline||'', link:a.link||a.url||'#', src:(a.source||a.source_name||a.publisher||'News').toString().split(' ')[0].toUpperCase(), ts:+new Date(a.pubDate||a.published_at||a.posted_at||a.date||a.time||Date.now()) })).filter(n=>n.title);
    } catch {}
  }
  throw new Error('cv unavailable');
}
async function loadNewsFromRSS(){
  let items=[];
  await Promise.all(NEWS_SOURCES.rss.map(async f=>{ try { const r=await fetch('https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(f)); const j=await r.json(); if(j.items) items=items.concat(j.items.map(i=>({title:i.title,link:i.link,src:(j.feed?.title||'News').split(' ')[0].toUpperCase(),ts:+new Date(i.pubDate)}))); } catch {} }));
  return items;
}
async function loadGlobalNews(){
  try {
    let items=[];
    try { items = await loadNewsFromCV(); } catch(e){ items = await loadNewsFromRSS(); }
    if(!items.length) { try { items = await loadNewsFromRSS(); } catch {} }
    items.sort((a,b)=>b.ts-a.ts);
    // de-dupe by title
    const seen=new Set(); globalNews = items.filter(n=>{ const k=n.title.toLowerCase().slice(0,60); if(seen.has(k)) return false; seen.add(k); return true; }).slice(0,50);
    renderTicker(); if($('v-dash')?.classList.contains('on')) renderDash(); if($('v-news')?.classList.contains('on')) renderNews();
    // fire alerts for fresh headlines mentioning a watched/held token
    const watched = new Set([...watch, ...positions.map(p=>p.addr)]);
    for (const n of globalNews){ if (newsSeen.has(n.link)) continue; newsSeen.add(n.link);
      for (const t of tokens){ if(!watched.has(t.addr)) continue; const kw=[t.sym.toLowerCase(),(t.name||'').toLowerCase()].filter(x=>x.length>3); if(kw.some(k=>n.title.toLowerCase().includes(k))){ fireAlert('new', t, 'News: '+n.title.slice(0,80)); break; } }
    }
  } catch {}
}
function renderTicker(){ const el=$('tickerTrack'); if(!el) return; if(!globalNews.length){ el.innerHTML='<span class="tk-item">Loading crypto headlines…</span>'; return; } const html = globalNews.map(n=>`<a href="${n.link}" target="_blank" rel="noopener" class="tk-item"><span class="tk-src">${n.src}</span>${n.title}</a>`).join('<span class="tk-dot">•</span>'); el.innerHTML = html + '<span class="tk-dot">•</span>' + html; }

// ---------- global error surface ----------
window.addEventListener('error', e => { const el = document.getElementById('autherr'); const authOn = document.getElementById('auth')?.style.display !== 'none'; if (el && authOn) el.textContent = 'Load error: ' + (e.message||e.error); });
window.addEventListener('unhandledrejection', e => { console.error('[MemeScreen] promise rejection', e.reason); });

// ---------- early auth tab wiring ----------
document.addEventListener('click', (e) => { const id = e.target && e.target.id; if (id === 'tab-login' || id === 'tab-reg') setMode(id === 'tab-reg' ? 'reg' : 'login'); });

// ---------- phone-simulator bridge: when the app runs inside phone.html it tells the "phone OS" about alerts + sign-in ----------
const inPhoneFrame = (() => { try { return window.parent !== window && /phone\.html/.test(window.parent.location.pathname); } catch { return false; } })();
function notifyHost(msg){ try { if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ source:'memescreen', ...msg })); } catch {}   // Expo / React Native shell
  if (!inPhoneFrame) return; try { window.parent.postMessage({ source:'memescreen', ...msg }, location.origin); } catch {} }
// Every outside link opens in the system browser / a new tab. Inside the Expo shell or the phone simulator a plain link
// would replace the app with the web page, so links are routed through here instead.
function openExternal(url){ if (!url || url === '#') return; if (window.ReactNativeWebView) { try { window.ReactNativeWebView.postMessage(JSON.stringify({ source:'memescreen', type:'ms-open-url', url })); } catch {} return; } const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.ext = '1'; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); }
document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href]'); if (!a || a.dataset.ext) return; const href = a.getAttribute('href') || ''; if (!/^https?:/i.test(href)) return; e.preventDefault(); openExternal(a.href); }, true);
window.addEventListener('message', e => { if (e.origin !== location.origin || e.data?.source !== 'phone-os') return; if (e.data.type === 'open-token') openTokenFromAlert(e.data.addr); });

// ---------- state ----------
let cash = START, positions = [], trades = [], tokens = [], selected = null, sizeUsd = 250, live = false, tf = '5m', chartCache = {}, watch = new Set(), alerts = [], unread = 0;
let indi = { ma20:false, ma50:false, ema20:false, rsi:false, bb:false }, drawTool = null, newsCache = {};
let ordType = 'market';
let orders = []; // resting: {id, addr, sym, kind:'limit'|'stop', dir, usd, trigger, tp, sl}
let accounts = [], activeAcct = 'main';
let equityLog = [], weekId = null, weekStartEq = START, resetAt = Date.now(), nick = '', traderId = null, lastPrices = {}, priceHist = {}, firedAt = {}, seen = new Set(), prevGrade = {};
let rules = { move1m: { on: true, pct: 5 }, move5m: { on: true, pct: 15 }, grade: { on: true }, liq: { on: true }, newpair: { on: true, minGrade: 'B' } };
const $ = id => document.getElementById(id);
const fmt = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtP = p => p >= 1 ? '$' + p.toFixed(2) : p >= 0.01 ? '$' + p.toFixed(4) : '$' + p.toPrecision(3);
const fmtK = n => n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(1) + 'k' : '$' + n.toFixed(0);
const pct = x => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
const age = ms => { const m = Math.max(1, Math.round((Date.now() - ms) / 60000)); return m < 60 ? m + 'm' : m < 1440 ? Math.round(m/60) + 'h' : Math.round(m/1440) + 'd'; };
const store = { get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),2600); }
function gBadge(g){ return '<span class="g" style="background:var(--' + g + ')">' + g + '</span>'; }
function isoWeek(d = new Date()){ const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(x.getUTCFullYear(),0,1)); return x.getUTCFullYear() + '-W' + String(Math.ceil((((x - y0)/864e5) + 1)/7)).padStart(2,'0'); }

// ---------- grade ----------
function grade(t){
  let s = 0; s += Math.min(t.liq / 50000, 1) * 35;
  const tot = t.buys + t.sells || 1, skew = Math.abs(t.buys - t.sells) / tot; s += (1 - skew) * 15;
  const vl = t.vol24 / Math.max(t.liq, 1); s += vl > 50 ? 0 : vl > 20 ? 8 : 15;
  const ageMin = (Date.now() - t.created) / 60000; s += Math.min(ageMin / 1440, 1) * 20;
  s += t.liq > 0 && t.mcap / t.liq < 20 ? 15 : t.mcap / t.liq < 60 ? 7 : 0;
  if (t.liq < 5000) s = Math.min(s, 30);
  const g = s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
  const flags = [];
  if (t.liq < 10000) flags.push('Thin liquidity — under $10k, exiting will move the price');
  if (vl > 20) flags.push('Volume is ' + vl.toFixed(0) + '× liquidity — possible wash trading');
  if (t.sells > t.buys * 1.5) flags.push('Sells outpacing buys ' + (t.sells / Math.max(t.buys,1)).toFixed(1) + ':1 in the last hour');
  if (ageMin < 60) flags.push('Pair is under an hour old');
  if (t.mcap / Math.max(t.liq,1) > 60) flags.push('Market cap is ' + (t.mcap / t.liq).toFixed(0) + '× the liquidity backing it');
  return { g, score: Math.round(s), flags };
}

// ---------- data: DexScreener ----------
function mapPair(q){ return { addr:q.baseToken.address, pair:q.pairAddress, sym:q.baseToken.symbol, name:q.baseToken.name, price:+q.priceUsd, liq:q.liquidity?.usd||0, vol24:q.volume?.h24||0, mcap:q.marketCap||q.fdv||0, buys:q.txns?.h1?.buys||0, sells:q.txns?.h1?.sells||0, buys5:q.txns?.m5?.buys||0, sells5:q.txns?.m5?.sells||0, vol5:q.volume?.m5||0, vol1:q.volume?.h1||0, boosts:q.boosts?.active||0, socials:(q.info?.socials||[]).length + (q.info?.websites||[]).length, ch1:q.priceChange?.h1||0, ch24:q.priceChange?.h24||0, created:q.pairCreatedAt||Date.now()-36e5, url:q.url }; }
async function fetchPairs(addrs){ const pairs = await (await fetch('https://api.dexscreener.com/tokens/v1/solana/' + addrs.slice(0,30).join(','))).json(); const best = {}; for (const q of pairs){ const a = q.baseToken?.address; if (!a || !q.priceUsd) continue; if (!best[a] || (q.liquidity?.usd||0) > best[a].liq) best[a] = mapPair(q); } return Object.values(best); }
async function fetchLive(){
  const get = u => fetch(u).then(r=>r.json()).catch(()=>[]);
  const [boosts, latest, profiles] = await Promise.all([get('https://api.dexscreener.com/token-boosts/top/v1'), get('https://api.dexscreener.com/token-boosts/latest/v1'), get('https://api.dexscreener.com/token-profiles/latest/v1')]);
  const addrs = [...new Set([...boosts, ...latest, ...profiles].filter(b => b.chainId === 'solana').map(b => b.tokenAddress))];
  const held = [...positions.map(p => p.addr), ...watch].filter(a => !addrs.includes(a));
  const want = [...held, ...addrs].slice(0, 60); const batches = await Promise.all([fetchPairs(want.slice(0,30)), want.length > 30 ? fetchPairs(want.slice(30,60)) : []]);
  const list = batches.flat(); if (!list.length) throw new Error('empty'); return list;
}
const SIM = [['BONKZ','Bonk Zilla'],['WIFHAT','dog with hat'],['GPTCAT','ChatGPT Cat'],['PEPEAI','Pepe Agent'],['TRUMPY','Trumpy Coin'],['PIZZA','Pizza Time'],['FLOKI2','Floki Returns'],['MOONDOG','Moon Dog'],['SNEK','Snek'],['CAPY','Capybara']];
function makeSim(){ return SIM.map(([sym,name],i) => { const price = [0.0000231,0.0042,0.31,0.00088,1.24,0.0031,0.000067,0.019,0.55,0.0009][i]; const liq = [3200,48000,210000,9500,620000,27000,1800,70000,340000,12000][i]; return { addr:'sim'+i, pair:'sim'+i, sym, name, price, target:price, liq, vol24: liq*(1+Math.random()*30), vol1: liq*(0.05+Math.random()*2), vol5: liq*(0.01+Math.random()*0.3), buys5: Math.round(Math.random()*40), sells5: Math.round(Math.random()*40), boosts: Math.round(Math.random()*5), socials: Math.round(Math.random()*3), mcap: liq*(3+Math.random()*80), buys:20+Math.round(Math.random()*300), sells:20+Math.round(Math.random()*300), ch1:(Math.random()-.5)*40, ch24:(Math.random()-.4)*120, created: Date.now()-Math.random()*3*864e5, url:'#' }; }); }
function tickSim(){ for (const t of tokens){ const d = (Math.random()-.5)*0.06; t.target = (t.target||t.price)*(1+d); t.ch1 += d*100; } }
function applyPair(list){ const map = Object.fromEntries(list.map(t => [t.addr, t])); for (const t of tokens) if (map[t.addr]) { const cur = t.price; Object.assign(t, map[t.addr], { grade: t.grade }); t.target = t.price; t.price = cur || t.target; } for (const p of positions) { const t = tokens.find(x => x.addr === p.addr); if (t) p.token = t; } }
async function refresh(){
  try { const list = await fetchLive(); for (const t of list) { const old = tokens.find(x => x.addr === t.addr); t.target = t.price; if (old) { t.price = old.price; t.whales = old.whales; } } tokens = list; live = true; $('dot').className = 'dot live'; }
  catch (e) { if (!tokens.length) { tokens = makeSim(); live = false; $('dot').className = 'dot sim'; $('feed').textContent = 'simulated data — live feed unavailable here; open the file directly in a browser (or host it) for live prices'; } else if (!live) tickSim(); }
  for (const p of positions) { const t = tokens.find(x => x.addr === p.addr); if (t) p.token = t; }
  for (const t of tokens) t.grade = grade(t);
  if (selected) selected = tokens.find(t => t.addr === selected.addr) || selected;
  checkNewPairs(); render(); syncStream(); try { SCR.evaluateAlerts(); if ($('v-screen')?.classList.contains('on')) SCR.render(); } catch (e) { console.warn('screener', e); }
}
async function pollPrices(){
  if (!live) tickSim(); else { try { const addrs = [...new Set([...tokens.map(t => t.addr), ...positions.map(p => p.addr), ...watch])]; applyPair(await fetchPairs(addrs)); } catch {} }
  for (const t of tokens) { const old = t.grade?.g; t.grade = grade(t); if (old && GRADES.indexOf(t.grade.g) < GRADES.indexOf(old)) fireAlert('grade', t, `${t.sym} downgraded ${old} → ${t.grade.g}`); }
  checkLiquidations(); checkOrders(); checkExits(); syncStream();
}

// ---------- streaming: PumpPortal ----------
let ws = null, wsKeys = [], solUsd = 0, streaming = 0;
async function fetchSol(){ try { const r = await (await fetch('https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112')).json(); const p = r.find(x => ['USDC','USDT'].includes(x.quoteToken?.symbol)) || r[0]; solUsd = +p.priceUsd || solUsd; } catch {} }
function wantedKeys(){ return [...new Set([selected?.addr, ...positions.map(p => p.addr), ...watch].filter(a => a && !String(a).startsWith('sim')))].slice(0, 20); }
function syncStream(){
  if (!live) return; const keys = wantedKeys(); if (keys.join() === wsKeys.join() && ws && ws.readyState === 1) return;
  try {
    if (!ws || ws.readyState > 1) { ws = new WebSocket('wss://pumpportal.fun/api/data'); ws.onopen = () => { wsKeys = []; syncStream(); }; ws.onclose = () => { streaming = 0; setTimeout(syncStream, 5000); }; ws.onerror = () => {};
      ws.onmessage = ev => { try { const m = JSON.parse(ev.data); if (!m.mint || !m.solAmount || !m.tokenAmount) return; const t = tokens.find(x => x.addr === m.mint); if (!t) return; const px = (m.solAmount / m.tokenAmount) * (solUsd || 0); if (!px || !isFinite(px)) return; t.target = px; t.price = px; t.lastTrade = { side: m.txType, usd: m.solAmount * solUsd, at: Date.now() }; if (m.solAmount * solUsd >= 1000) { (t.whales ||= []).push({ usd: m.solAmount * solUsd, side: m.txType, at: Date.now() }); if (t.whales.length > 50) t.whales.shift(); } streaming++; pushTick(t); } catch {} }; return; }
    if (ws.readyState !== 1) return; if (wsKeys.length) ws.send(JSON.stringify({ method:'unsubscribeTokenTrade', keys: wsKeys })); if (keys.length) ws.send(JSON.stringify({ method:'subscribeTokenTrade', keys })); wsKeys = keys;
  } catch { ws = null; }
}

// ---------- trade math ----------
function quoteBuy(t, usd){ const R = t.liq/2 || 1; const impact = usd/(R+usd); const fees = usd*(PLATFORM+LP)+NET; const fill = t.price*(1+impact); const qty = Math.max(0,(usd-fees))/fill; const breakeven = fill*(1+2*(PLATFORM+LP)+impact)/t.price - 1; return { impact, fees, fill, qty, breakeven }; }
function quoteSell(t, qty){ const gross = qty*t.price; const R = t.liq/2 || 1; const impact = gross/(R+gross); const net = gross*(1-impact); const fees = net*(PLATFORM+LP)+NET; return { impact, fees, proceeds: Math.max(0, net-fees), fill: t.price*(1-impact) }; }
function quoteShort(t, usd){ const R = t.liq/2 || 1; const impact = usd/(R+usd); const fees = usd*(PLATFORM+LP)+NET; const fill = t.price*(1-impact); const qty = usd/t.price; const received = usd*(1-impact) - fees; return { impact, fees, fill, qty, received }; }
function quoteBuyback(t, qty){ const gross = qty*t.price; const R = t.liq/2 || 1; const impact = gross/(R+gross); const c = gross*(1+impact); const fees = c*(PLATFORM+LP)+NET; return { impact, fees, cost: c+fees, fill: t.price*(1+impact) }; }
function posValue(p){ return p.side === 'short' ? Math.max(0, p.cost + p.received - quoteBuyback(p.token, p.qty).cost) : quoteSell(p.token, p.qty).proceeds; }
function equity(){ return cash + positions.reduce((s,p) => s + posValue(p), 0); }
function placeOrder(side, kind, trigger, tp, sl){
  if (!selected) return; const t = selected;
  if (sizeUsd > cash) return toast('Not enough cash');
  const o = { id: Date.now()+''+Math.random().toString(36).slice(2,5), addr:t.addr, sym:t.sym, dir:side, kind, usd:sizeUsd, trigger:+trigger, tp: tp?+tp:null, sl: sl?+sl:null, created:Date.now() };
  orders.push(o); cash -= 0; // collateral reserved at fill, not now
  toast((kind==='limit'?'Limit':'Stop')+' '+side+' '+t.sym+' @ '+fmtP(+trigger)); save(); render();
}
function checkOrders(){
  for (const o of [...orders]){ const t = tokens.find(x=>x.addr===o.addr); if(!t) continue; const p=t.price;
    let fill=false;
    if (o.kind==='limit') fill = o.dir==='long' ? p<=o.trigger : p>=o.trigger;   // buy limit below, short limit above
    if (o.kind==='stop')  fill = o.dir==='long' ? p>=o.trigger : p<=o.trigger;   // stop entry
    if (fill){ orders = orders.filter(x=>x!==o); const prevSel=selected; selected=t; const prevSize=sizeUsd; sizeUsd=o.usd; openTrade(o.dir, { tp:o.tp, sl:o.sl, fillPrice:o.trigger }); selected=prevSel; sizeUsd=prevSize; fireAlert('move1m', t, `${t.sym} ${o.kind} ${o.dir} filled @ ${fmtP(o.trigger)}`); }
  }
}
function checkExits(){
  for (const pos of [...positions]){ if(pos.tp==null && pos.sl==null) continue; const p=pos.token.price;
    const hitTP = pos.tp!=null && (pos.side==='long' ? p>=pos.tp : p<=pos.tp);
    const hitSL = pos.sl!=null && (pos.side==='long' ? p<=pos.sl : p>=pos.sl);
    if (hitTP || hitSL){ const other = hitTP ? (pos.sl?'stop-loss cancelled':'') : (pos.tp?'take-profit cancelled':''); closeTrade(pos.addr, pos.side, 100); fireAlert(hitTP?'new':'liq', pos.token, `${pos.token.sym} ${hitTP?'take-profit':'stop-loss'} hit @ ${fmtP(p)}${other?' · '+other:''}`); }
  }
}
function openTrade(side, opts){
  if (!selected) return; const t = selected; const q = side === 'long' ? quoteBuy(t, sizeUsd) : quoteShort(t, sizeUsd);
  // limit/stop orders fill at the requested trigger price (or better), not the current market price
  if (opts && opts.fillPrice){ const fp = opts.fillPrice; const qty = side==='long' ? Math.max(0,(sizeUsd-q.fees))/fp : sizeUsd/fp; q.fill = fp; q.qty = qty; }
  if (sizeUsd > cash) return toast('Not enough cash');
  if (q.impact > 0.25 && !confirm('Price impact is ' + (q.impact*100).toFixed(1) + '% on this pool. Continue?')) return;
  if (side === 'long' && ['D','F'].includes(t.grade.g) && !confirm('This token is graded ' + t.grade.g + '.\n\n' + t.grade.flags.join('\n') + '\n\nMemeScreen informs, it doesn\'t block. Continue?')) return;
  cash -= sizeUsd; const tr = { id: Date.now()+''+Math.random().toString(36).slice(2,6), addr: t.addr, sym: t.sym, ts: Date.now(), price: q.fill, side: side === 'long' ? 'B' : 'S', usd: sizeUsd, fees: q.fees, impact: q.impact, grade: t.grade.g, open: true, dir: side }; trades.push(tr);
  const ex = positions.find(p => p.addr === t.addr && p.side === side);
  if (ex) { ex.cost += sizeUsd; ex.qty += q.qty; if (side==='short') ex.received += q.received; ex.token = t; } else positions.push({ addr: t.addr, side, token: t, qty: q.qty, cost: sizeUsd, received: side==='short' ? q.received : 0, entry: q.fill, grade: t.grade.g, opened: Date.now(), tp: opts?.tp||null, sl: opts?.sl||null });
  toast((side === 'long' ? 'Long ' : 'Short ') + t.sym + ' · ' + fmt(sizeUsd) + ' · impact ' + (q.impact*100).toFixed(2) + '% · fees ' + fmt(q.fees)); save(); render(); try { KC._drawSig=null; applyDrawings(true); } catch {} syncLeaderboard();
}
function closeTrade(addr, side, pctOf){
  const p = positions.find(x => x.addr === addr && x.side === side); if (!p) return; const f = pctOf/100; const value = posValue(p) * f; const fill = side === 'short' ? quoteBuyback(p.token, p.qty*f).fill : quoteSell(p.token, p.qty*f).fill; const pnl = value - p.cost*f;
  cash += value; p.cost *= (1-f); p.received *= (1-f); p.qty *= (1-f);
  const tr = { id: Date.now()+''+Math.random().toString(36).slice(2,6), addr, sym: p.token.sym, ts: Date.now(), price: fill, side: side === 'short' ? 'B' : 'S', usd: value, pnl, grade: p.grade, open: false, dir: side }; trades.push(tr);
  if (pctOf === 100 || p.qty <= 1e-9) positions = positions.filter(x => x !== p);
  toast('Closed ' + pctOf + '% of ' + p.token.sym + ' ' + side + ' for ' + fmt(value) + ' (' + fmt(pnl) + ')'); save(); render(); syncLeaderboard();
}
function closeAllPositions(){
  if(!positions.length){ toast('No open positions'); return; }
  if(!confirm('Close all '+positions.length+' open positions at market?')) return;
  for(const p of [...positions]) closeTrade(p.addr, p.side, 100);
  toast('All positions closed');
}
function checkLiquidations(){ for (const p of [...positions]) if (p.side === 'short' && posValue(p) <= 0) { positions = positions.filter(x => x !== p); trades.push({ id: Date.now()+'', addr:p.addr, sym:p.token.sym, ts:Date.now(), price:p.token.price, side:'B', usd:0, pnl:-p.cost, grade:p.grade, open:false, dir:'short' }); fireAlert('liq', p.token, `${p.token.sym} short liquidated — ${fmt(p.cost)} collateral gone`); save(); render(); } }

// ---------- persistence ----------
// Three layers:  in-memory  →  this browser (instant, works offline / for guests)  →  the cloud backend (signed-in users).
//   account state (cash, positions, trades, orders…) is per paper account;  prefs (watchlist, alert rules, indicators) are per user.
const userKey = () => (signedIn() && ME?.email) ? ME.email : 'guest';
function prefsObj(){ return { watch:[...watch], rules, indi, activeAcct, screens: SCR.getScreens(), wallet: WAL.prefs() }; }
function saveLocal(){ if (typeof activeAcct === 'undefined') return; saveActiveState(); store.set('ms_prefs_'+userKey(), { ...prefsObj(), alerts: alerts.slice(0,100), traderId }); }
function save(what){ saveLocal(); markDirty(what || 'acct'); announce('state'); }
function load(){ traderId = 't_' + Math.random().toString(36).slice(2,10); }
function loadPrefs(){ const s = store.get('ms_prefs_'+userKey()) || (userKey()==='guest' ? store.get('ms_app') : null); if (!s) { watch = new Set(); alerts = []; return; } watch = new Set(s.watch||[]); alerts = s.alerts||[]; rules = Object.assign(rules, s.rules||{}); indi = Object.assign(indi, s.indi||{}); if (s.screens) SCR.setScreens(s.screens); if (s.wallet) WAL.applyPrefs(s.wallet); traderId = s.traderId || traderId; }

// ---- cloud sync (debounced; retries; last write wins per account) ----
let dirtyAcct = false, dirtyProfile = false, syncTimer = null, syncing = false, lastCloudAt = {};
const setSync = t => { const e = $('sync'); if (e) e.textContent = t; };
function markDirty(what){ if (!signedIn()) return; if (what === 'prefs') dirtyProfile = true; else if (what === 'both') dirtyAcct = dirtyProfile = true; else dirtyAcct = true; setSync('saving…'); clearTimeout(syncTimer); syncTimer = setTimeout(flushCloud, 1200); }
let flushWarned = false;
async function flushCloud(){
  if (!signedIn() || syncing) return; syncing = true; clearTimeout(syncTimer);
  try {
    if (dirtyAcct) { dirtyAcct = false; const name = activeAcct; const r = await backend.saveAccount({ name, size: acctSize(), state: snapshot() }); if (r?.updatedAt) lastCloudAt[name] = r.updatedAt; }
    if (dirtyProfile) { dirtyProfile = false; await backend.saveProfile(prefsObj()); }
    setSync('synced'); flushWarned = false;
  } catch (e) {
    if (isAuthError(e)) { syncing = false; toast('Session expired — sign in again'); return logout(); }
    dirtyAcct = dirtyProfile = true; setSync('offline — will retry'); syncTimer = setTimeout(flushCloud, 10000);
    if (!flushWarned) { flushWarned = true; toast('Not saved to ' + backend.label + ': ' + (e.message || 'no connection') + '. Retrying.'); }
  } finally { syncing = false; if ((dirtyAcct || dirtyProfile) && !syncTimer) syncTimer = setTimeout(flushCloud, 1200); }
}
window.addEventListener('pagehide', () => { if (dirtyAcct || dirtyProfile) flushCloud(); });
// pull everything for the signed-in user: their paper accounts + profile. Cloud copy wins over this browser's cache.
async function pullCloud({ keepActive = false } = {}){
  let list = await backend.listAccounts();
  if (!list.length) { await backend.saveAccount({ name:'main', size:START, state:null }); list = [{ name:'main', size:START, state:null }]; }
  if (!list.find(a => a.name === 'main')) list.unshift({ name:'main', size:START, state:null });
  accounts = list.map(a => ({ id:a.name, size:+a.size || START }));
  for (const a of list) { if (a.state) store.set(acctKey(a.name), a.state); if (a.updatedAt) lastCloudAt[a.name] = a.updatedAt; }
  let prof = {}; try { prof = await backend.getProfile() || {}; } catch {}
  if (prof.watch) watch = new Set(prof.watch); if (prof.rules) rules = Object.assign(rules, prof.rules); if (prof.indi) indi = Object.assign(indi, prof.indi); if (prof.screens) SCR.setScreens(prof.screens); if (prof.wallet) WAL.applyPrefs(prof.wallet);
  if (!keepActive) activeAcct = (prof.activeAcct && accounts.find(a => a.id === prof.activeAcct)) ? prof.activeAcct : (accounts.find(a => a.id === activeAcct) ? activeAcct : 'main');
  if (!accounts.find(a => a.id === activeAcct)) activeAcct = 'main';
  saveAccounts(); loadActiveState(); relinkTokens(); setSync('synced');
}
// another device changed something? (checked every 30s while idle)
async function pollCloud(){
  if (!signedIn() || dirtyAcct || dirtyProfile || syncing || document.hidden) return;
  try { const list = await backend.listAccounts(); const mine = list.find(a => a.name === activeAcct);
    const names = list.map(a => a.name).sort().join('|'), have = accounts.map(a => a.id).sort().join('|');
    if (dirtyAcct || syncing) return;
    if ((mine && mine.updatedAt > (lastCloudAt[activeAcct] || 0) + 500) || (names && names !== have)) { for (const a of list) { if (a.state) store.set(acctKey(a.name), a.state); lastCloudAt[a.name] = a.updatedAt; } accounts = list.map(a => ({ id:a.name, size:+a.size || START })); if (!accounts.find(a => a.id === activeAcct)) activeAcct = 'main'; saveAccounts(); loadActiveState(); relinkTokens(); renderAccountUI(); render(); }
    setSync('synced');
  } catch (e) { if (isAuthError(e)) logout(); else setSync('offline'); }
}
function relinkTokens(){ for (const p of positions) { const t = tokens.find(x => x.addr === p.addr); if (t) p.token = t; } }
// other tabs / the phone simulator on this same browser: stay in step instantly
const chan = ('BroadcastChannel' in window) ? new BroadcastChannel('memescreen') : null; const tabId = Math.random().toString(36).slice(2);
function announce(type){ try { chan?.postMessage({ type, user:userKey(), acct:activeAcct, from:tabId }); } catch {} }
if (chan) chan.onmessage = e => { const m = e.data || {}; if (m.from === tabId || m.user !== userKey() || $('app').style.display === 'none') return;
  if (m.type === 'state' && m.acct === activeAcct) { loadActiveState(); loadPrefs(); relinkTokens(); render(); if ($('v-portfolio')?.classList.contains('on')) renderPortfolio(); try { KC._drawSig = null; applyDrawings(true); } catch {} }
  if (m.type === 'accounts') { loadAccounts(); renderAccountUI(); }
  if (m.type === 'logout') { location.reload(); } };
function rollWeek(){ const w = isoWeek(); if (weekId !== w) { weekId = w; weekStartEq = equity(); save(); } }


// ---------- on-screen alert cards ----------
function ensureAlertStack(){ let el = document.getElementById('alertstack'); if (!el){ el = document.createElement('div'); el.id='alertstack'; el.className='alertstack'; document.body.appendChild(el); } return el; }
function pushAlertCard(kind, sym, msg){
  const el = ensureAlertStack(); const card = document.createElement('div'); card.className = 'acard ' + (kind==='grade'||kind==='liq'?'bad':kind==='new'||kind==='screen'?'good':'move');
  card.innerHTML = `<b>${sym}</b><span>${msg}</span><button aria-label="dismiss">×</button>`;
  card.querySelector('button').onclick = () => card.remove();
  el.prepend(card); while (el.children.length > 4) el.lastChild.remove();
  setTimeout(() => card.classList.add('in'), 10);
  setTimeout(() => { card.classList.remove('in'); setTimeout(()=>card.remove(), 300); }, 6000);
}

// ---------- alerts + push ----------
// System notifications go through the service worker when there is one (required on phones), else the classic API.
let swReg = null;
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'ms-open-token') openTokenFromAlert(e.data.addr); }); }
function openTokenFromAlert(addr){ try { window.focus(); } catch {} const t = tokens.find(x => x.addr === addr); if (t) selected = t; show('trade'); render(); if (t) document.querySelector('.m-segs [data-seg=chart]')?.click(); }
async function sysNotify(title, body, tag, addr){
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try { if (swReg && swReg.active) { await swReg.showNotification(title, { body, icon: 'icon.svg', badge: 'icon.svg', tag, renotify: !!tag, data: { addr } }); return true; } } catch {}
  try { const n = new Notification(title, { body, icon: ICON, tag }); n.onclick = () => { n.close(); openTokenFromAlert(addr); }; return true; } catch { return false; }
}
function notifState(){ const el = $('notifstate'); if (!('Notification' in window)) { el.innerHTML = 'This browser does not support notifications. In-app alerts still work.'; return; } const p = Notification.permission; el.innerHTML = p === 'granted' ? '<span class="ok">Browser notifications are on.</span> Alerts show here and as system notifications, even when this tab is in the background.' : p === 'denied' ? '<span class="warn">Blocked.</span> Allow notifications for this site in your browser settings.' : 'Off. Enable to get system notifications when a watched memecoin moves.'; }
function fireAlert(kind, t, msg){
  const key = kind + ':' + t.addr; if (firedAt[key] && Date.now() - firedAt[key] < 300000) return; firedAt[key] = Date.now();
  const a = { kind, addr: t.addr, sym: t.sym, msg, at: Date.now() }; alerts.unshift(a); alerts = alerts.slice(0,100); unread++; $('abadge').style.display = ''; $('abadge').textContent = unread;
  toast(msg); pushAlertCard(kind, t.sym, msg); sysNotify('MemeScreen · ' + t.sym, msg, key, t.addr); notifyHost({ type:'ms-alert', kind, sym:t.sym, addr:t.addr, msg, unread });
  renderAlerts(); saveLocal();
}
function evalAlerts(){
  const now = Date.now(); const watched = new Set([...watch, ...positions.map(p => p.addr)]);
  for (const t of tokens) { (priceHist[t.addr] ||= []).push([now, t.price]); priceHist[t.addr] = priceHist[t.addr].filter(x => now - x[0] <= 330000); if (!watched.has(t.addr)) continue; const h = priceHist[t.addr];
    const at = ms => { const c = h.find(x => now - x[0] <= ms); return c ? c[1] : null; };
    const p1 = at(60000), p5 = at(300000);
    if (rules.move1m.on && p1 && h[0][0] <= now - 55000) { const c = (t.price - p1)/p1*100; if (Math.abs(c) >= rules.move1m.pct) fireAlert('move1m', t, `${t.sym} ${pct(c)} in 1 minute · now ${fmtP(t.price)}`); }
    if (rules.move5m.on && p5 && h[0][0] <= now - 295000) { const c = (t.price - p5)/p5*100; if (Math.abs(c) >= rules.move5m.pct) fireAlert('move5m', t, `${t.sym} ${pct(c)} in 5 minutes · now ${fmtP(t.price)}`); } }
}
function checkNewPairs(){ for (const t of tokens) { if (seen.has(t.addr)) continue; seen.add(t.addr); if (seen.size <= 40) continue; if (rules.newpair.on && (Date.now()-t.created) < 1800000 && GRADES.indexOf(t.grade.g) >= GRADES.indexOf(rules.newpair.minGrade)) fireAlert('new', t, `New ${t.grade.g}-grade launch: ${t.sym} · ${fmtK(t.liq)} liquidity`); } }
function renderAlerts(){ $('alog').innerHTML = alerts.length ? alerts.map(a => `<div class="alert ${a.kind==='grade'?'grade':a.kind==='liq'?'liq':a.kind==='new'?'new':''}">${a.msg}<time>${new Date(a.at).toLocaleString()}</time></div>`).join('') : '<div class="empty">Nothing yet. Star a few tokens or open a position and the rules start watching.</div>';
  $('rules').innerHTML = `
    <div class="rule"><label><input type="checkbox" id="r1" ${rules.move1m.on?'checked':''}> Price moves</label> <input type="number" id="r1p" value="${rules.move1m.pct}" min="1" max="100">% in 1 minute</div>
    <div class="rule"><label><input type="checkbox" id="r5" ${rules.move5m.on?'checked':''}> Price moves</label> <input type="number" id="r5p" value="${rules.move5m.pct}" min="1" max="500">% in 5 minutes</div>
    <div class="rule"><label><input type="checkbox" id="rg" ${rules.grade.on?'checked':''}> Safety grade downgrades</label></div>
    <div class="rule"><label><input type="checkbox" id="rl" ${rules.liq.on?'checked':''}> Short position liquidated</label></div>
    <div class="rule"><label><input type="checkbox" id="rn" ${rules.newpair.on?'checked':''}> New pair launches graded</label> <select id="rng"><option ${rules.newpair.minGrade==='A'?'selected':''}>A</option><option ${rules.newpair.minGrade==='B'?'selected':''}>B</option><option ${rules.newpair.minGrade==='C'?'selected':''}>C</option></select> or better</div>`;
  const rd = () => { rules.move1m = { on: $('r1').checked, pct: +$('r1p').value||5 }; rules.move5m = { on: $('r5').checked, pct: +$('r5p').value||15 }; rules.grade.on = $('rg').checked; rules.liq.on = $('rl').checked; rules.newpair = { on: $('rn').checked, minGrade: $('rng').value }; save('prefs'); };
  ['r1','r1p','r5','r5p','rg','rl','rn','rng'].forEach(id => $(id).onchange = rd);
}
$('enable').onclick = async () => { if (!('Notification' in window)) return toast('Not supported here'); const p = await Notification.requestPermission(); notifState(); if (p === 'granted') sysNotify('MemeScreen', 'Notifications are on. You\'ll hear about it when a watched memecoin moves.', 'ms-on'); };
$('testn').onclick = () => { const t = selected || tokens[0]; if (!t) return; delete firedAt['test:'+t.addr]; fireAlert('test', t, `Test: ${t.sym} is at ${fmtP(t.price)} right now`); };

// ---------- server sync ----------
function avgGradeIdxFromTrades(){ const ts = trades.filter(t => t.open); return ts.length ? ts.reduce((s,t)=>s+GRADES.indexOf(t.grade),0)/ts.length : 2; }
// the global board tracks your MAIN account (every other paper account is a private sandbox)
let lbT = 0;
async function syncLeaderboard(){
  if (!signedIn() || activeAcct !== 'main') return; const now = Date.now(); if (now - lbT < 4000) return; lbT = now;
  const eq = equity(), g = avgGradeIdxFromTrades(), rw = (eq-weekStartEq)/weekStartEq*100, ra = (eq-baseline())/baseline()*100;
  try { await backend.syncLeaderboard({ equity:eq, avgGradeIdx:g, trades: trades.filter(t=>t.open).length, openTrades: positions.length, returnWeek:rw, returnAll:ra, scoreWeek:score(rw,g), scoreAll:score(ra,g), weekId: weekId||isoWeek() }); } catch {}
}

// ---------- competitions ----------
const BOTS = ['degen_dave','rugproof_rita','liquidity_larry','pepe_pilot','solana_sam','chart_chloe','fomo_frank','grade_a_gina','moon_marcus','stoploss_sue'];
let bots = null;
function botBoard(period){ if (!bots) bots = BOTS.map((n,i)=>({ nick:n, ret:(Math.random()-.35)*60, retAll:(Math.random()-.3)*180, g:Math.random()*4, trades:5+Math.round(Math.random()*40) })); for (const bt of bots){ bt.ret += (Math.random()-.5)*0.4; bt.retAll += (Math.random()-.5)*0.4; } return bots.map(bt=>({ nick:bt.nick, ret: period==='week'?bt.ret:bt.retAll, g:bt.g, trades:bt.trades, score: score(period==='week'?bt.ret:bt.retAll, bt.g), me:false })); }
function score(ret,g){ return ret*(0.5+g/4*0.7); }
const EXT_COMPS = [
  { name:'Pump.fun Trading Arena', where:'pump.fun', prize:'SOL rewards', link:'https://pump.fun', note:'Live memecoin launches' },
  { name:'Jupiter Trading League', where:'Jupiter', prize:'JUP rewards', link:'https://jup.ag', note:'Solana DEX volume comp' },
  { name:'Birdeye Trader Cup', where:'Birdeye', prize:'Points', link:'https://birdeye.so', note:'PnL leaderboard' },
];
function renderExternal(){ const el=$('extComps'); if(!el) return; el.innerHTML = EXT_COMPS.map(c=>`<a class="extcomp" href="${c.link}" target="_blank" rel="noopener"><div><b>${c.name}</b><div class="hint">${c.where} · ${c.note}</div></div><span class="hint">${c.prize} ↗</span></a>`).join(''); }
let comps = [], compLoading = false;
async function loadComps(){ if (!signedIn()) { comps = []; return; } try { comps = await backend.listCompetitions(); } catch { comps = []; } }
function renderCompList(){ const el=$('compList'); if(!el) return;
  const official = [{name:'Weekly Championship',desc:'Resets Monday 00:00 UTC · everyone at $10k',official:true},{name:'All-Time Leaderboard',desc:'Since your last reset · risk-adjusted',official:true}];
  el.innerHTML = official.map(r=>`<div class="row comprow"><span><b>${r.name}</b> <span class="ok" style="font-size:10px">OFFICIAL</span><div class="hint">${r.desc}</div></span><button class="mini" disabled>Entered</button></div>`).join('')
    + (signedIn() ? `<div class="row comprow joinbox"><input id="joinCode" placeholder="Enter a code" maxlength="8" autocapitalize="characters" spellcheck="false" aria-label="Competition code"><button class="mini primary" id="joinBtn">Join</button></div>` : '<div class="hint" style="margin:8px 0">Sign in to create or join a competition.</div>')
    + comps.map(c=>`<div class="row comprow"><span><b>${esc(c.name)}</b><div class="hint">by ${esc(c.by)} · code <b class="num">${esc(c.code)}</b> · ${c.members.length} trader${c.members.length===1?'':'s'}</div></span><span class="acctbtns">${c.mine?`<button class="mini" data-board="${esc(c.code)}">Board</button><button class="mini" data-leave="${esc(c.code)}">Leave</button>`:`<button class="mini primary" data-join="${esc(c.code)}">Join</button>`}</span></div>`).join('');
  const jb=$('joinBtn'); if(jb) jb.onclick=()=>joinComp($('joinCode').value);
  const jc=$('joinCode'); if(jc) jc.onkeydown=e=>{ if(e.key==='Enter') joinComp(jc.value); };
  el.querySelectorAll('[data-join]').forEach(b=>b.onclick=()=>joinComp(b.dataset.join));
  el.querySelectorAll('[data-leave]').forEach(b=>b.onclick=async()=>{ try { await backend.leaveCompetition(b.dataset.leave); toast('Left the competition'); await loadComps(); renderCompList(); } catch(e){ toast(e.message); } });
  el.querySelectorAll('[data-board]').forEach(b=>b.onclick=()=>showCompBoard(b.dataset.board));
}
async function joinComp(code){ code=(code||'').trim().toUpperCase(); if(!code) return toast('Enter the competition code'); if(!signedIn()) return toast('Sign in first'); try { const c = await backend.joinCompetition(code); toast('Joined '+c.name); await loadComps(); renderCompList(); showCompBoard(code); } catch(e){ toast(e.message||'Could not join'); } }
async function showCompBoard(code){ const c = comps.find(x=>x.code===code); if(!c) return; const host=$('compBoard'); if(!host) return;
  let rows=[]; try { const all = await backend.leaderboard('week', isoWeek()); rows = all.filter(r=>c.members.includes(r.nickname)); } catch {}
  for (const m of c.members) if (!rows.find(r=>r.nickname===m)) rows.push({ nickname:m, return_pct:0, avg_grade_idx:2, trades:0, score:0 });
  rows.sort((x,y)=>y.score-x.score);
  host.innerHTML = `<div class="card"><div class="cardhead"><h3>${esc(c.name)} · this week</h3><button class="mini" id="compBoardClose" aria-label="Close">✕</button></div><div class="hint" style="margin-bottom:8px">Code <b class="num">${esc(c.code)}</b> · share it so others can join</div><table><thead><tr><th></th><th>Trader</th><th>Return</th><th>Avg grade</th><th>Trades</th><th>Score</th></tr></thead><tbody>${rows.map((r,i)=>`<tr class="${ME&&r.nickname===ME.nickname?'me':''}"><td class="rank num">${i+1}</td><td style="text-align:left">${esc(r.nickname)}</td><td class="num ${r.return_pct>=0?'up':'dn'}">${pct(r.return_pct)}</td><td>${gBadge(GRADES[Math.max(0,Math.min(4,Math.round(r.avg_grade_idx)))])}</td><td class="num">${r.trades}</td><td class="num">${(+r.score).toFixed(1)}</td></tr>`).join('')}</tbody></table></div>`;
  $('compBoardClose').onclick=()=>{ host.innerHTML=''; }; host.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
async function renderComp(){
  const eq = equity(); const wret=(eq-weekStartEq)/weekStartEq*100, aret=(eq-baseline())/baseline()*100, g=avgGradeIdxFromTrades();
  $('join').innerHTML = (TOKEN && !guest) ? `<div class="joinrow"><div><h3 style="margin:0">🏆 You're competing as <span class="ok">${ME?.nickname||'you'}</span></h3><div class="hint" style="margin-top:4px">Week ${weekId||isoWeek()} · weekly return ${pct(wret)} · all-time ${pct(aret)} · avg entry grade ${GRADES[Math.round(g)]}</div></div><div class="joinscore"><div class="hint">Your score</div><b class="num" style="font-size:22px;color:var(--brand)">${score(wret,g).toFixed(1)}</b></div></div>` : `<h3>Sign in to compete globally</h3><div class="hint">Guests see simulated opponents. <a href="#" id="gotoacct">Create an account</a> to appear on the real board.</div>`;
  const ga = $('gotoacct'); if (ga) ga.onclick = e => { e.preventDefault(); logout(); };
  $('wkinfo').textContent = `Week ${weekId||isoWeek()} · resets Monday 00:00 UTC · measured from your equity at week start`;
  renderExternal(); if (!compLoading) { compLoading = true; loadComps().then(()=>{ compLoading=false; renderCompList(); }); } renderCompList();
  const cc=$('createComp'); if(cc) cc.onclick=async()=>{ if(!signedIn()) return toast('Sign in to create a competition'); const n=prompt('Competition name:'); if(!n) return; try { const c=await backend.createCompetition(n); toast('Created "'+c.name+'" · code '+c.code); await loadComps(); renderCompList(); showCompBoard(c.code); } catch(e){ toast(e.message||'Could not create'); } };
  for (const period of ['week','all']){
    let rows = null;
    if (signedIn()) { try { const d = await backend.leaderboard(period, isoWeek()); rows = d.map(r=>({ nick:r.nickname, ret:r.return_pct, g:r.avg_grade_idx, trades:r.trades, score:r.score, me: ME && r.nickname===ME.nickname })); } catch {} }
    if (!rows || !rows.length) { rows = botBoard(period); if (TOKEN && !guest) rows.push({ nick:ME?.nickname||'you', ret:period==='week'?wret:aret, g, trades:positions.length, score:score(period==='week'?wret:aret,g), me:true }); rows.sort((x,y)=>y.score-x.score); }
    $(period==='week'?'lb-week':'lb-all').innerHTML = rows.map((r,i)=>`<tr class="${r.me?'me':''}"><td class="rank num">${i+1}</td><td style="text-align:left">${r.nick}${r.me?' <span class="ok">(you)</span>':''}</td><td class="num ${r.ret>=0?'up':'dn'}">${pct(r.ret)}</td><td>${gBadge(GRADES[Math.max(0,Math.min(4,Math.round(r.g)))])}</td><td class="num">${r.trades}</td><td class="num">${r.score.toFixed(1)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No entries yet.</td></tr>';
  }
}

// ---------- portfolio ----------
function renderPortfolio(){
  WAL.render();
  const B=baseline(); const eq = equity(), pnl = eq - B, closed = trades.filter(t => !t.open); const wins = closed.filter(t => t.pnl > 0).length; const fees = trades.reduce((s,t) => s + (t.fees||0), 0);
  $('pkpis').innerHTML = [['Equity', fmt(eq)], ['Total P&L', fmt(pnl) + ' (' + pct(pnl/B*100) + ')'], ['Win rate', closed.length ? Math.round(wins/closed.length*100) + '% of ' + closed.length : '—'], ['Fees paid', fmt(fees)], ['Open positions', positions.length], ['This week', pct((eq-weekStartEq)/weekStartEq*100)]].map(([k,v]) => `<div>${k}<b class="num">${v}</b></div>`).join('');
  const byg = {}; for (const t of closed) { byg[t.grade] = (byg[t.grade]||0) + (t.pnl||0); } const mx = Math.max(1, ...Object.values(byg).map(Math.abs));
  $('bygrade').innerHTML = GRADES.slice().reverse().map(g => { const v = byg[g]||0; return `<div class="row"><span>${gBadge(g)}</span><span style="flex:1;margin:0 10px;height:8px;background:var(--raised);border-radius:4px;overflow:hidden;position:relative"><span style="position:absolute;top:0;bottom:0;${v>=0?'left:50%':'right:50%'};width:${Math.abs(v)/mx*50}%;background:var(--${v>=0?'brand':'F'})"></span></span><b class="num ${v>=0?'up':'dn'}">${fmt(v)}</b></div>`; }).join('') + (closed.length ? '' : '<div class="empty">Close a position to see where your money actually goes.</div>');
  $('history').innerHTML = trades.length ? `<table><thead><tr><th>Time</th><th>Token</th><th>Side</th><th>Price</th><th>Amount</th><th>Fees</th><th>Impact</th><th>Grade</th><th>P&L</th></tr></thead><tbody>${trades.slice().reverse().slice(0,50).map(t => `<tr><td class="num">${new Date(t.ts).toLocaleTimeString()}</td><td class="sym">${t.sym}</td><td><span class="side ${t.dir}">${t.open?'OPEN':'CLOSE'} ${t.dir.toUpperCase()}</span></td><td class="num">${fmtP(t.price)}</td><td class="num">${fmt(t.usd)}</td><td class="num">${t.fees?fmt(t.fees):'—'}</td><td class="num">${t.impact!=null?(t.impact*100).toFixed(2)+'%':'—'}</td><td>${gBadge(t.grade)}</td><td class="num ${(t.pnl||0)>=0?'up':'dn'}">${t.pnl!=null?fmt(t.pnl):'—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No trades yet.</div>';
  drawEquity();
}
function drawEquity(){ const c = $('eqc'); if (!c) return; const dpr = devicePixelRatio||1, W = c.clientWidth||600, H = 160; c.width = W*dpr; c.height = H*dpr; const ctx = c.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,W,H); const h = equityLog.map(x=>x[1]); if (h.length < 2) { ctx.fillStyle='#5A6575'; ctx.font='13px sans-serif'; ctx.fillText('Builds as you trade…', 14, 80); return; } const B=baseline(); const min = Math.min(...h, B), max = Math.max(...h, B), r = (max-min)||1; const y = v => 10 + (max-v)/r*(H-20); ctx.setLineDash([3,3]); ctx.strokeStyle='#2A3341'; ctx.beginPath(); ctx.moveTo(0,y(B)); ctx.lineTo(W,y(B)); ctx.stroke(); ctx.setLineDash([]); ctx.beginPath(); h.forEach((v,i)=>{ const x = i/(h.length-1)*(W-10)+5; i?ctx.lineTo(x,y(v)):ctx.moveTo(x,y(v)); }); ctx.strokeStyle = h[h.length-1] >= B ? '#22E4A0' : '#F0483E'; ctx.lineWidth = 2; ctx.stroke(); }

// ---------- chart ----------
const TF = { '1m':['minute',1], '5m':['minute',5], '15m':['minute',15], '1h':['hour',1] }, STEP = { '1m':60,'5m':300,'15m':900,'1h':3600 };
function simCandles(t, n=180){ const step = STEP[tf]; let p = t.price/(1+(Math.random()-.5)*.6); const out=[]; const now = Math.floor(Date.now()/1000); for (let i=n;i>0;i--){ const o=p, c=p*(1+(Math.random()-.5)*.08), h=Math.max(o,c)*(1+Math.random()*.03), l=Math.min(o,c)*(1-Math.random()*.03); out.push({ t: now-i*step, o,h,l,c, v: Math.random()*t.liq*.05 }); p=c; } const k = t.price/out[out.length-1].c; for (const c of out){ c.o*=k; c.h*=k; c.l*=k; c.c*=k; } return out; }
function hasLW(){ return typeof window.LightweightCharts !== 'undefined'; }
function showChartMenu(x, y, price){
  document.getElementById('chartmenu')?.remove();
  const cur = selected.price;
  // find an order within 2% of the clicked price to offer cancel
  const near = orders.filter(o=>o.addr===selected.addr).find(o=>Math.abs(o.trigger-price)/price < 0.02);
  const m = document.createElement('div'); m.id='chartmenu'; m.className='chartmenu';
  m.style.left = x+'px'; m.style.top = y+'px';
  m.innerHTML = `<div class="cm-price">@ ${fmtP(price)}</div>
    ${near?`<button data-a="cancel" style="color:var(--F)">✕ Cancel ${near.kind} ${near.dir} @ ${fmtP(near.trigger)}</button>`:''}
    <button data-a="limit-long">Buy limit here (long)</button>
    <button data-a="limit-short">Sell limit here (short)</button>
    <button data-a="stop-long">Buy stop here</button>
    <button data-a="tp">Set as take-profit</button>
    <button data-a="sl">Set as stop-loss</button>`;
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener('click', close); };
  setTimeout(()=>document.addEventListener('click', close), 10);
  m.querySelectorAll('button').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); const a=b.dataset.a; close();
    if(a==='cancel' && near){ orders=orders.filter(o=>o!==near); save(); applyDrawings(); renderPositions(); toast('Order cancelled'); }
    else if(a==='limit-long') placeOrder('long','limit',price);
    else if(a==='limit-short') placeOrder('short','limit',price);
    else if(a==='stop-long') placeOrder('long','stop',price);
    else if(a==='tp' || a==='sl'){ const pos=positions.find(p=>p.addr===selected.addr); if(!pos) return toast('Open a position first'); if(a==='tp') pos.tp=price; else pos.sl=price; save(); renderPositions(); applyDrawings(); toast((a==='tp'?'Take-profit':'Stop-loss')+' set @ '+fmtP(price)); } });
}
// ========================================================
// KLineChart engine (native drawing tools + indicators)
// ========================================================
let KC = null, KCtoken = null, KCtf = null;
function hasKC(){ return typeof window.klinecharts !== 'undefined'; }
// keep hasLW for any stragglers but route everything through KC
function makeKCChart(){
  const wrap = $('chartwrap'); if (!wrap || !hasKC()) return;
  try { if (KC) klinecharts.dispose(KC); } catch {} KC = null; KCtoken = null;
  wrap.innerHTML = '<div id="kc" style="width:100%;height:440px"></div>';
  KC = klinecharts.init('kc', {
    styles: {
      grid: { horizontal: { color: 'rgba(42,46,57,0.5)' }, vertical: { color: 'rgba(42,46,57,0.5)' } },
      candle: {
        type: 'candle_solid',
        bar: { upColor:'#26A69A', downColor:'#EF5350', noChangeColor:'#888888', upBorderColor:'#26A69A', downBorderColor:'#EF5350', upWickColor:'#26A69A', downWickColor:'#EF5350' },
        priceMark: { last: { text:{ color:'#fff' }, line:{ color:'#787B86' } }, high:{ color:'#8A8F9C' }, low:{ color:'#8A8F9C' } },
        tooltip: { rect:{ color:'rgba(20,22,28,0.9)', borderColor:'#2A2E39' }, text:{ color:'#B2B5BE' } }
      },
      indicator: { tooltip: { text: { color:'#B2B5BE' } } },
      xAxis: { axisLine:{ color:'#2A2E39' }, tickText:{ color:'#8A8F9C' }, tickLine:{ color:'#2A2E39' } },
      yAxis: { axisLine:{ color:'#2A2E39' }, tickText:{ color:'#8A8F9C' }, tickLine:{ color:'#2A2E39' } },
      crosshair: { horizontal:{ line:{ color:'#787B86', style:'dashed' }, text:{ backgroundColor:'#2A2E39' } }, vertical:{ line:{ color:'#787B86', style:'dashed' }, text:{ backgroundColor:'#2A2E39' } } },
      separator: { color:'#2A2E39' }
    }
  });
  try { KC.setPriceVolumePrecision(0, 2); } catch {}
  try { const kcEl2=document.getElementById('kc'); if(kcEl2 && window.ResizeObserver){ new ResizeObserver(()=>{ try{ if(KC&&KC.resize) KC.resize(); }catch{} }).observe(kcEl2); } } catch {}
  // volume sub-pane
  const phone = document.documentElement.classList.contains('mobile');
  try { KC.createIndicator('VOL', false, { id: 'vol_pane', height: phone ? 64 : 100 }); } catch {}
  // on a phone the always-on OHLC legend wraps over the candles — show it only while a finger is on the chart
  if (phone) { try { KC.setStyles({ candle:{ tooltip:{ showRule:'follow_cross' } }, indicator:{ tooltip:{ showRule:'follow_cross' } } }); } catch {} }
  // right-click to place order at cursor price
  const kcEl = document.getElementById('kc');
  if (kcEl) kcEl.addEventListener('contextmenu', ev => {
    ev.preventDefault(); if(!selected||!KC) return; if (Date.now() - (window.__msSkipChartMenu||0) < 400) return;   // that right-click just deleted a drawing
    try { const data = KC.convertFromPixel({ x: ev.offsetX, y: ev.offsetY }, { paneId: 'candle_pane' }); let val = data && (Array.isArray(data)?data[0]?.value:data.value); if(val==null) return; const price = val / tokenSupply(selected); showChartMenu(ev.clientX, ev.clientY, +price); } catch {}
  });
}
function kcData(candles, mult){
  const m = (mult && isFinite(mult) && mult>0) ? mult : 1;
  const seen=new Set(); const out=[];
  for(const k of candles||[]){ const t=Math.floor(k.t)*1000; const c=+k.c; if(!isFinite(t)||!isFinite(c)||c<=0||seen.has(t)) continue; seen.add(t); out.push({ timestamp:t, open:(+k.o)*m, high:(+k.h)*m, low:(+k.l)*m, close:c*m, volume:+k.v||0 }); }
  return out.sort((a,b)=>a.timestamp-b.timestamp);
}
// supply = marketCap / price, so price*supply = marketCap (chart shows mcap on the axis)
// cached per token so the eased price and a freshly-polled mcap can't make the scale (and every order line) jitter
const supplyCache = {};
function liveMcap(t){ const s=tokenSupply(t); return s!==1 ? t.price*s : (t.mcap||0); }
function tokenSupply(t){ if(!t) return 1; if(supplyCache[t.addr]) return supplyCache[t.addr]; const s=(t.mcap>0 && (t.target||t.price)>0) ? t.mcap/(t.target||t.price) : 1; if(s!==1) supplyCache[t.addr]=s; return s; }
async function loadChart(t){
  if(!hasKC()) return;
  const key = t.addr + tf; const src = $('csrc');
  if (!chartCache[key] || (Date.now() - chartCache[key].at > 60000 && chartCache[key].mode !== 'live')) {
    if (!live || String(t.pair).startsWith('sim')) chartCache[key] = { at: Date.now(), candles: chartCache[key]?.candles || simCandles(t), mode: 'sim' };
    else { try { const [unit, agg] = TF[tf]; const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${t.pair}/ohlcv/${unit}?aggregate=${agg}&limit=300&currency=usd`, { headers: { accept: 'application/json' } }); const j = await r.json(); const list = (j.data?.attributes?.ohlcv_list||[]).map(a => ({ t:a[0], o:+a[1], h:+a[2], l:+a[3], c:+a[4], v:+a[5] })).reverse(); if (!list.length) throw 0; chartCache[key] = { at: Date.now(), candles: list, mode: 'live' }; } catch { chartCache[key] = { at: Date.now(), candles: (chartCache[key]?.candles)||simCandles(t), mode: 'sim' }; } }
  }
  const cc = chartCache[key]; if (selected?.addr !== t.addr) return;
  if (src) src.textContent = (cc.mode === 'live' ? 'Market cap · GeckoTerminal · PumpPortal' : 'Market cap · simulated');
  if (!KC || !document.getElementById('kc')) makeKCChart();
  if (!KC) return;
  const tokenChanged = KCtoken !== t.addr, dataChanged = tokenChanged || KCtf !== tf || KC._applied !== cc;
  if (dataChanged) { KC.applyNewData(kcData(cc.candles, tokenSupply(t))); KC._applied = cc; }
  KCtoken = t.addr; KCtf = tf;
  try { setTimeout(()=>{ if(KC && KC.resize) KC.resize(); }, 50); } catch {}
  if (tokenChanged || !KC._indi) { applyIndicators(); KC._indi = 1; }
  if (tokenChanged) DT.restore();                       // this token's saved drawings
  KC._drawSig=null; applyDrawings(true);
}
function pushTick(t){
  if (!selected || selected.addr !== t.addr) return; const cc = chartCache[t.addr+tf]; if (!cc?.candles?.length) return;
  const now = Math.floor(Date.now()/1000), step = STEP[tf]; let k = cc.candles[cc.candles.length-1];
  if (now >= k.t + step) { k = { t: k.t + step*Math.floor((now-k.t)/step), o:k.c, h:k.c, l:k.c, c:k.c, v:0 }; cc.candles.push(k); if (cc.candles.length > 400) cc.candles.shift(); }
  k.c = t.price; k.h = Math.max(k.h,k.c); k.l = Math.min(k.l,k.c); if (t.lastTrade && Date.now()-t.lastTrade.at < 500) k.v += t.lastTrade.usd||0;
  if (KC && KCtoken === t.addr && KCtf === tf) { const m=tokenSupply(t); try { KC.updateData({ timestamp: Math.floor(k.t)*1000, open:(+k.o)*m, high:(+k.h)*m, low:(+k.l)*m, close:(+k.c)*m, volume:+k.v||0 }); } catch {} }
}
// ---------- indicators (native KLineChart) ----------
let kcIndicators = {};
function applyIndicators(){
  if (!KC) return;
  // main-pane overlays
  const wantMain = { ma20: ['MA',{ calcParams:[20] }], ma50:['MA',{ calcParams:[50] }], ema20:['EMA',{ calcParams:[20] }], bb:['BOLL',{}] };
  const wantSub = { rsi:['RSI',{}] };
  // remove all then re-add per current toggles (simple + reliable)
  for (const key in kcIndicators){ try { KC.removeIndicator(kcIndicators[key].paneId, kcIndicators[key].name); } catch {} }
  kcIndicators = {};
  for (const k in wantMain){ if (indi[k]){ try { const [name,opt]=wantMain[k]; KC.createIndicator({ name, ...opt }, true, { id:'candle_pane' }); kcIndicators[k]={ name, paneId:'candle_pane' }; } catch {} } }
  for (const k in wantSub){ if (indi[k]){ try { const [name,opt]=wantSub[k]; const id = KC.createIndicator({ name, ...opt }, false, { id:k+'_pane' }); kcIndicators[k]={ name, paneId: id||(k+'_pane') }; } catch {} } }
}
// ---------- drawings (native overlays + TP/SL/order lines) ----------
SCR.init({ tokens: () => tokens, select: t => { selected = t; show('trade'); render(); document.querySelector('.m-segs [data-seg=chart]')?.click(); }, toast, fireAlert, saveScreens: () => save('prefs'), signedIn });
WAL.init({ grade, fetchPairs, gBadge, toast, openExternal, fmt, fmtP, fmtK, solUsd: () => solUsd, savePrefs: () => save('prefs'), select: t => { const have = tokens.find(x => x.addr === t.addr); if (!have) { t.grade = grade(t); tokens.push(t); } selected = have || t; show('trade'); render(); document.querySelector('.m-segs [data-seg=chart]')?.click(); } });
function renderLegal(){ const el=$('legalBody'); if(!el || el.dataset.done) return; el.dataset.done='1';
  const del=$('deleteAcct'); if(del) del.onclick=async()=>{ if(!signedIn()) return toast('Guest data lives only in this browser. Clear the site data to remove it.'); if(!confirm('Delete your MemeScreen account and every paper account, trade and setting tied to it? This cannot be undone.')) return; const typed=prompt('Type DELETE to confirm'); if(typed!=='DELETE') return; try { await backend.deleteMe(); try { Object.keys(localStorage).filter(k=>k.startsWith('ms_')).forEach(k=>localStorage.removeItem(k)); } catch {} toast('Account deleted'); setTimeout(()=>location.reload(), 800); } catch(e){ toast(e.message||'Could not delete'); } }; }
DT.init({ chart: () => KC, token: () => selected, supply: () => tokenSupply(selected), barMs: () => STEP[tf]*1000, fmtP, toast });
// labelled horizontal line for entry / TP / SL / resting orders. If the level is outside the visible price range the
// line pins to the top/bottom edge with an arrow, so a far-away take-profit or stop-loss never silently disappears.
let msLineReg=false;
function ensureMsLine(){ if(msLineReg||!hasKC()) return; msLineReg=true; try { klinecharts.registerOverlay({ name:'msLine', totalStep:2, needDefaultPointFigure:false, needDefaultXAxisFigure:false, needDefaultYAxisFigure:false,
  createPointFigures: ({ overlay, coordinates, bounding }) => { if(!coordinates.length) return []; const d=overlay.extendData||{}; const raw=coordinates[0].y; const H=bounding.height, W=bounding.width; const off = raw<8 ? 'up' : raw>H-8 ? 'down' : null; const y = off==='up'?8 : off==='down'?H-8 : raw; const text=(d.text||'')+(off==='up'?'  ▲ above view':off==='down'?'  ▼ below view':'');
    return [ { type:'line', attrs:{ coordinates:[{x:0,y},{x:W,y}] }, styles:{ style:'dashed', dashedValue:[5,4], color:d.color, size:1 }, ignoreEvent:true },
             { type:'text', attrs:{ x:W-6, y: off==='up'? y+2 : y-2, text, align:'right', baseline: off==='up'?'top':'bottom' }, styles:{ style:'fill', color:'#0A0D12', size:11, weight:'600', family:'system-ui,-apple-system,Segoe UI,sans-serif', backgroundColor:d.color, borderRadius:3, paddingLeft:5, paddingRight:5, paddingTop:3, paddingBottom:3 }, ignoreEvent:true } ]; } }); } catch(e){ console.warn('msLine', e); } }
function applyDrawings(force){
  if (!KC || !selected) return;
  // signature of what SHOULD be drawn — skip redraw if unchanged (so a drag isn't destroyed mid-move)
  const sig = JSON.stringify(positions.filter(p=>p.addr===selected.addr).map(p=>[p.entry,p.tp,p.sl]).concat(orders.filter(o=>o.addr===selected.addr).map(o=>[o.trigger,o.kind])))+'|'+selected.addr;
  if (!force && KC._drawSig === sig) return;
  KC._drawSig = sig;
  try { (KC._mslines||[]).forEach(id=>{ try{ KC.removeOverlay(id); }catch{} }); } catch {}
  KC._mslines = [];
    ensureMsLine(); const sup=tokenSupply(selected);
  const line=(price,color,text)=>{ try { const id=KC.createOverlay({ name:'msLine', points:[{ value:price*sup }], lock:true, extendData:{ color, text } }); if(id) KC._mslines.push(id); } catch {} };
  for (const pos of positions.filter(p=>p.addr===selected.addr)){
    const dir = pos.side==='long'?1:-1, usdAt = px => (px-pos.entry)*dir*pos.qty;
    line(pos.entry, '#9AA3B2', `${pos.side.toUpperCase()} entry ${fmtP(pos.entry)}`);
    if (pos.tp) line(pos.tp, '#26A69A', `TP ${fmtP(pos.tp)} · +${fmt(Math.abs(usdAt(pos.tp))).replace('-','')}`);
    if (pos.sl) line(pos.sl, '#EF5350', `SL ${fmtP(pos.sl)} · −${fmt(Math.abs(usdAt(pos.sl))).replace('-','')}`);
  }
  for (const o of orders.filter(o=>o.addr===selected.addr)) line(o.trigger, '#F5C542', `${o.kind} ${o.dir} ${fmtP(o.trigger)} · ${fmt(o.usd)}`);
}
// ---------- tick engine + targeted DOM updates ----------
function tick(){
  let moved = false; for (const t of tokens) { if (t.target == null) t.target = t.price; if (t.price !== t.target) { t.price += (t.target - t.price)*0.35; if (Math.abs(t.price-t.target)/t.target < 1e-5) t.price = t.target; moved = true; } }
  for (const p of positions) { const t = tokens.find(x => x.addr === p.addr); if (t) p.token = t; }
  if (selected) pushTick(selected); if (moved || streaming) updateLive();
}
function updateLive(){
  const B=baseline(); const eq = equity(), pnl = eq - B; const setT=(id,v)=>{ const e=$(id); if(e) e.textContent=v; }; const setC=(id,c)=>{ const e=$(id); if(e) e.className=c; }; setT('cash',fmt(cash)); setT('equity',fmt(eq)); setT('pnl',fmt(pnl)+' ('+pct(pnl/B*100)+')'); setC('pnl','num '+(pnl>=0?'up':'dn')); const wr=(eq-weekStartEq)/weekStartEq*100; setT('wk',pct(wr)); setC('wk','num '+(wr>=0?'up':'dn'));
  for (const t of tokens) { const el = document.querySelector(`tr[data-a="${t.addr}"] .pr`); const mc = liveMcap(t); if (el && el.textContent !== fmtK(mc)) { el.textContent = fmtK(mc); el.classList.remove('fu','fd'); void el.offsetWidth; el.classList.add(t.price >= (lastPrices[t.addr] ?? t.price) ? 'fu' : 'fd'); } lastPrices[t.addr] = t.price; }
  if (selected) { const pe = document.querySelector('.t-center .price'); if (pe) pe.firstChild.textContent = fmtP(selected.price) + ' '; if (selected.lastTrade && Date.now()-selected.lastTrade.at < 4000) { const lt = $('lasttrade'); if (lt) lt.innerHTML = `<span class="${selected.lastTrade.side==='buy'?'up':'dn'}">${selected.lastTrade.side.toUpperCase()}</span> ${fmt(selected.lastTrade.usd)} · ${new Date(selected.lastTrade.at).toLocaleTimeString()}`; } }
  // positions refresh via renderPositions on its own interval (avoids desync with the table structure)
  if (bottomTab==='positions' && positions.length) { const now = Date.now(); if (!window._posT || now-window._posT > 1000) { window._posT = now; renderPositions(); } }
  const f = $('feed'); if (live) f.textContent = (streaming ? 'streaming ' + wsKeys.length + ' token' + (wsKeys.length===1?'':'s') + ' · ' + streaming + ' trades · ' : 'live · ') + 'quotes every 2s · ' + new Date().toLocaleTimeString();
}

// ---------- news tab ----------
let newsCoinFilter = null;
function renderNews(){
  const el=$('newsList'); if(!el) return;
  // --- heatmap: each tracked coin colored by |1h change|, sized by volume, click to filter its news ---
  const hmHost=$('newsHeatmap');
  if(hmHost){
    const coins=[...tokens].sort((a,b)=>Math.abs(b.ch1)-Math.abs(a.ch1)).slice(0,24);
    hmHost.innerHTML = coins.map(t=>{ const ch=t.ch1||0; const mag=Math.min(Math.abs(ch)/30,1); const col= ch>=0 ? `rgba(38,166,154,${0.15+mag*0.75})` : `rgba(239,83,80,${0.15+mag*0.75})`; const sel=newsCoinFilter===t.sym?'sel':''; return `<div class="hmcell ${sel}" data-sym="${t.sym}" style="background:${col}" title="${t.name||t.sym} · ${pct(ch)} 1h"><span class="hmsym">${t.sym}</span><span class="hmch">${pct(ch)}</span></div>`; }).join('');
    hmHost.querySelectorAll('.hmcell').forEach(c=>c.onclick=()=>{ newsCoinFilter = newsCoinFilter===c.dataset.sym?null:c.dataset.sym; if($('newsFilter')) $('newsFilter').value = newsCoinFilter||''; renderNews(); });
  }
  const manualF = ($('newsFilter')?.value||'').toLowerCase();
  const coinTok = newsCoinFilter ? tokens.find(t=>t.sym===newsCoinFilter) : null;
  // build keyword set for a coin: its symbol, name words, and inferred narrative terms
  function coinKeywords(t){ if(!t) return []; const kw=[t.sym.toLowerCase()]; (t.name||'').toLowerCase().split(/\s+/).forEach(w=>{ if(w.length>2) kw.push(w); });
    const narr={ ai:['ai','gpt','agent','llm','neural','openai','anthropic'], dog:['dog','doge','shib','inu','puppy','woof'], cat:['cat','kitty','meow','feline'], frog:['frog','pepe','toad'], politics:['trump','biden','election','maga','government'], finance:['etf','bank','treasury','yield','fed','sec'] };
    const hay=(t.sym+' '+(t.name||'')).toLowerCase();
    for(const k in narr){ if(narr[k].some(term=>hay.includes(term))) narr[k].forEach(term=>kw.push(term)); }
    return [...new Set(kw)];
  }
  const kws = coinTok ? coinKeywords(coinTok) : (manualF? [manualF] : []);
  let items=(globalNews||[]);
  let matchType='all';
  if(kws.length){
    const direct = items.filter(n=>{ const t=n.title.toLowerCase(); return kws.some(k=>t.includes(k)); });
    if(direct.length){ items=direct; matchType='direct'; }
    else { matchType='narrative'; /* keep all, but we'll show a note */ }
  }
  // header
  const hdr=$('newsFilterLabel');
  if(hdr){
    if(coinTok){
      const links = `<a class="coinlink" href="https://dexscreener.com/solana/${coinTok.pair||''}" target="_blank" rel="noopener" title="DexScreener">📊 Chart</a><a class="coinlink" href="https://x.com/search?q=%24${encodeURIComponent(coinTok.sym)}&f=live" target="_blank" rel="noopener" title="Search X/Twitter">𝕏 Social</a><a class="coinlink" href="https://www.google.com/search?q=${encodeURIComponent(coinTok.sym+' '+(coinTok.name||'')+' crypto memecoin')}&tbm=nws" target="_blank" rel="noopener" title="Google News">🔍 Web</a>`;
      hdr.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px"><span>${coinTok.sym} ${gBadge(coinTok.grade.g)} · <a href="#" id="clearCoinFilter">show all news</a></span><span class="coinlinks">${links}</span></div>${matchType==='narrative'?'<div class="hint" style="margin-top:6px">No major outlet covers '+coinTok.sym+' directly — that\'s normal for a memecoin. Memecoin news breaks on X and Telegram first (tap Social above). Below is broader market news that can still move it.</div>':''}`;
    } else hdr.innerHTML = 'All crypto news';
  }
  el.innerHTML = items.length ? items.map(n=>`<a class="newscard" href="${n.link}" target="_blank" rel="noopener"><span class="news-src">${n.src}</span><div class="newstitle">${n.title}</div><time>${new Date(n.ts).toLocaleString()}</time></a>`).join('') : `<div class="empty">No headlines match. ${newsCoinFilter?'<a href="#" id="clearCoinFilter">Show all news</a>':''}</div>`;
  const cc=$('clearCoinFilter'); if(cc) cc.onclick=(e)=>{ e.preventDefault(); newsCoinFilter=null; if($('newsFilter'))$('newsFilter').value=''; renderNews(); };
  const fi=$('newsFilter'); if(fi && !fi._bound){ fi._bound=1; fi.addEventListener('input', ()=>{ newsCoinFilter=null; renderNews(); }); }
}

// ---------- dashboard ----------
let mktData = { mcap:null, mcapChg:null, fng:null, fngLabel:'', btc:null, sol:null, eth:null };
async function loadMarket(){
  // SOL from DexScreener (already have it) as an instant baseline
  try { if(solUsd){ mktData.sol=mktData.sol||{usd:solUsd,usd_24h_change:0}; if(!mktData.sol.usd) mktData.sol.usd=solUsd; } } catch {}
  // Everything else via OUR backend proxy (no browser CORS/geo blocks). Falls back gracefully.
  try {
    const d = await backend.market();
    if(d.btc) mktData.btc=d.btc; if(d.eth) mktData.eth=d.eth; if(d.sol) mktData.sol=d.sol;
    if(d.mcap) mktData.mcap=d.mcap; if(d.mcapChg!=null) mktData.mcapChg=d.mcapChg;
  } catch {}
  // Fear & Greed (alternative.me allows browser CORS directly)
  try { const f=await (await fetch('https://api.alternative.me/fng/?limit=1')).json(); mktData.fng=+f.data?.[0]?.value; mktData.fngLabel=f.data?.[0]?.value_classification||''; } catch {}
  if ($('v-dash')?.classList.contains('on')) renderDash();
}
let dashFeatured = null;
function renderDash(){
  const el=$('dashgrid'); if(!el) return;
  const eq=equity(), pnl=eq-baseline();
  const byLiq=[...tokens].sort((a,b)=>b.liq-a.liq);
  if(!dashFeatured || !tokens.find(t=>t.addr===dashFeatured)) dashFeatured = byLiq[0]?.addr;
  const feat = tokens.find(t=>t.addr===dashFeatured) || byLiq[0];
  const movers=[...tokens].sort((a,b)=>Math.abs(b.ch1)-Math.abs(a.ch1)).slice(0,8);
  const fngColor = mktData.fng==null?'var(--t3)': mktData.fng<25?'#EF5350': mktData.fng<45?'#F58B42': mktData.fng<55?'#F5C542': mktData.fng<75?'#7FD858':'#26A69A';
  const irow=(t)=>`<div class="irow" data-a="${t.addr}"><div class="iico" style="background:var(--${t.grade.g})">${t.grade.g}</div><div class="iname"><b>${t.sym}</b><span class="ibadge">${(t.name||'').slice(0,16)}</span></div><div class="ival"><div class="num">${fmtP(t.price)}</div><div class="num ${t.ch1>=0?'up':'dn'}" style="font-size:12px">${pct(t.ch1)}</div></div></div>`;
  el.innerHTML = `
    <button type="button" class="dash-head" id="dashMore" aria-label="Open the trading terminal">Market summary ›</button>
    <div class="dash-2col">
      <div class="card feat">
        <div class="feat-hd"><div class="iico big" style="background:var(--${feat?.grade.g||'C'})">${feat?.grade.g||'—'}</div><div><div class="feat-name">${feat?.sym||'—'} <span class="ibadge">${feat?.name||''}</span></div><div class="feat-price num">${feat?fmtP(feat.price):'—'} <span class="num ${(feat?.ch1||0)>=0?'up':'dn'}" style="font-size:15px">${feat?pct(feat.ch1):''} 1h</span></div></div><a class="feat-open" id="featOpen">Open in terminal →</a></div>
        <div id="featChart" class="feat-chart"></div>
        <div class="feat-stats"><div><span class="hint">Liquidity</span><b class="num">${feat?fmtK(feat.liq):'—'}</b></div><div><span class="hint">Market cap</span><b class="num">${feat?fmtK(feat.mcap):'—'}</b></div><div><span class="hint">24h vol</span><b class="num">${feat?fmtK(feat.vol24):'—'}</b></div><div><span class="hint">Safety</span><b>${feat?gBadge(feat.grade.g):'—'}</b></div></div>
      </div>
      <div class="card rail">
        <div class="rail-hd">Top memecoins</div>
        ${movers.map(irow).join('')||'<div class="hint">Loading…</div>'}
        <a class="rail-more" id="railMore">See all in terminal ›</a>
      </div>
    </div>
    <div class="dash-strip">
      <div class="scard"><span class="dlabel">Crypto market cap</span><b class="dbig num">${mktData.mcap?('$'+(mktData.mcap/1e12).toFixed(2)+'T'):'—'}</b><span class="num ${(mktData.mcapChg||0)>=0?'up':'dn'}">${mktData.mcapChg!=null?pct(mktData.mcapChg):''}</span></div>
      <div class="scard"><span class="dlabel">Fear &amp; Greed</span><b class="dbig num" style="color:${fngColor}">${mktData.fng??'—'}</b><span class="hint">${mktData.fngLabel}</span></div>
      <div class="scard"><span class="dlabel">Bitcoin</span><b class="dbig num">${mktData.btc?('$'+mktData.btc.usd.toLocaleString()):'—'}</b><span class="num ${(mktData.btc?.usd_24h_change||0)>=0?'up':'dn'}">${mktData.btc?pct(mktData.btc.usd_24h_change):''}</span></div>
      <div class="scard"><span class="dlabel">Solana</span><b class="dbig num">${mktData.sol?('$'+mktData.sol.usd.toFixed(2)):'—'}</b><span class="num ${(mktData.sol?.usd_24h_change||0)>=0?'up':'dn'}">${mktData.sol?pct(mktData.sol.usd_24h_change):''}</span></div>
      <div class="scard"><span class="dlabel">Your equity · ${activeAcct}</span><b class="dbig num">${fmt(eq)}</b><span class="num ${pnl>=0?'up':'dn'}">${fmt(pnl)} (${pct(pnl/baseline()*100)})</span></div>
    </div>
    <div class="dash-2col">
      <div class="card"><div class="dlabel">Fresh clean launches (B+)</div>${[...tokens].filter(t=>GRADES.indexOf(t.grade.g)>=3).sort((a,b)=>b.created-a.created).slice(0,6).map(irow).join('')||'<div class="hint">None yet.</div>'}</div>
      <div class="card"><div class="dlabel">Latest crypto news</div>${(globalNews||[]).slice(0,6).map(n=>`<a class="news" href="${n.link}" target="_blank" rel="noopener"><span class="news-src">${n.src}</span>${n.title}</a>`).join('')||'<div class="hint">Loading headlines…</div>'}</div>
    </div>`;
  const fo=$('featOpen'); if(fo) fo.onclick=()=>{ selected=feat; show('trade'); }; const dm=$('dashMore'); if(dm) dm.onclick=()=>{ if(feat) selected=feat; show('trade'); };
  const rm=$('railMore'); if(rm) rm.onclick=()=>show('trade');
  el.querySelectorAll('.irow').forEach(r=>r.onclick=()=>{ dashFeatured=r.dataset.a; renderDash(); });
  drawFeatChart(feat);
}
let featChartObj=null, featChartToken=null;
function cleanSeries(candles){ if(!candles||!candles.length) return []; const seen=new Set(); const out=[]; for(const k of candles){ const t=Math.floor(k.t); const v=+k.c; if(!isFinite(t)||!isFinite(v)||v<=0||seen.has(t)) continue; seen.add(t); out.push({time:t,value:v}); } return out.sort((a,b)=>a.time-b.time); }
function drawFeatChart(t){
  const host=$('featChart'); if(!host||!t) return;
  const cc=chartCache[t.addr+'5m'];
  const paint=(candles)=>{ const data=cleanSeries(candles); if(!data.length){ if(!cc) loadChart(t).then(()=>{ const c2=chartCache[t.addr+'5m']; if(c2&&selected!==undefined) paint(c2.candles); }).catch(()=>{}); return; }
    const c=document.createElement('canvas'); const W=host.clientWidth||600,H=220,dpr=devicePixelRatio||1; c.width=W*dpr;c.height=H*dpr;c.style.width=W+'px';c.style.height=H+'px'; host.innerHTML=''; host.appendChild(c);
    const ctx=c.getContext('2d'); ctx.scale(dpr,dpr); const vals=data.map(d=>d.value); const min=Math.min(...vals),max=Math.max(...vals),r=(max-min)||max*.01||1; const x=i=>i/(data.length-1)*(W-8)+4, y=v=>10+(max-v)/r*(H-30);
    // area gradient
    const g=ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'rgba(59,130,246,.35)'); g.addColorStop(1,'rgba(59,130,246,0)');
    ctx.beginPath(); data.forEach((d,i)=>{ const px=x(i),py=y(d.value); i?ctx.lineTo(px,py):ctx.moveTo(px,py); }); ctx.lineTo(x(data.length-1),H); ctx.lineTo(x(0),H); ctx.closePath(); ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); data.forEach((d,i)=>{ const px=x(i),py=y(d.value); i?ctx.lineTo(px,py):ctx.moveTo(px,py); }); ctx.strokeStyle=vals[vals.length-1]>=vals[0]?'#26A69A':'#EF5350'; ctx.lineWidth=2; ctx.stroke();
  };
  if(cc?.candles) paint(cc.candles); else loadChart(t).then(()=>{ const c2=chartCache[t.addr+'5m']; if(c2) paint(c2.candles); }).catch(()=>{});
}

// ---------- render ----------
function render(){
  updateLive();
  const fq = ($('q').value||'').toLowerCase(), fg = GRADES.indexOf($('fg').value), fl = +$('fl').value, fa = +$('fa').value, fs = $('fs').value, fw = $('fw').checked;
  const shown = tokens.filter(t => (!fq || t.sym.toLowerCase().includes(fq) || t.name.toLowerCase().includes(fq)) && GRADES.indexOf(t.grade.g) >= fg && t.liq >= fl && (!fa || (Date.now()-t.created)/60000 <= fa) && (!fw || watch.has(t.addr))).sort((a,b) => fs==='score' ? b.grade.score-a.grade.score : fs==='created' ? b.created-a.created : b[fs]-a[fs]);
  $('count').textContent = shown.length + ' of ' + tokens.length;
  const rugWord = g => ({A:'Safe',B:'Low',C:'Caution',D:'High',F:'Rug risk'}[g]||'—');
  $('rows').innerHTML = shown.map(t => `<tr class="tok ${selected && selected.addr===t.addr?'sel':''}" data-a="${t.addr}"><td><span class="star ${watch.has(t.addr)?'on':''}" data-w="${t.addr}" title="Watch">★</span><span class="sym">${t.sym}</span><span class="name">${t.name}</span></td><td><span class="rugcell">${gBadge(t.grade.g)}<span class="rugword rug-${t.grade.g}">${rugWord(t.grade.g)}</span></span></td><td class="num pr">${fmtK(liveMcap(t))}</td><td class="num ${t.ch1>=0?'up':'dn'}">${pct(t.ch1)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing passes these filters. Loosen one.</td></tr>';
  document.querySelectorAll('tr.tok').forEach(r => r.onclick = e => { if (e.target.dataset.w) return; selected = tokens.find(t => t.addr === r.dataset.a); render(); syncStream(); });
  document.querySelectorAll('.star').forEach(s => s.onclick = e => { e.stopPropagation(); const a = s.dataset.w; const onw = !watch.has(a); onw ? watch.add(a) : watch.delete(a); save(); render(); syncStream(); markDirty('prefs'); toast(onw ? 'Watching — alerts on' : 'Unwatched'); });
  renderDetail(); renderPositions();
}
// ---------- paper trading accounts ----------
function acctKey(a){ return 'ms_acct_' + userKey() + '_' + a; }
function loadAccounts(){
  const uk = userKey();
  accounts = store.get('ms_accts_'+uk) || [{ id:'main', size:10000 }];
  accounts = accounts.map(a => typeof a === 'string' ? { id:a, size:10000 } : a);   // migrate old string-array format
  if (!accounts.find(a=>a.id==='main')) accounts.unshift({ id:'main', size:10000 });
  activeAcct = store.get('ms_active_'+uk) || accounts[0]?.id || 'main';
  if(!accounts.find(a=>a.id===activeAcct)) activeAcct = accounts[0].id;
}
function saveAccounts(){ const uk = userKey(); store.set('ms_accts_'+uk, accounts); store.set('ms_active_'+uk, activeAcct); }
function acctObj(id){ return accounts.find(a=>a.id===(id||activeAcct)) || accounts[0] || { id:'main', size:START }; }
function acctSize(){ return acctObj().size || 10000; }
function baseline(){ return acctSize(); }

function renderAccountUI(){
  const sel = $('acctSel');
  if (sel){ sel.innerHTML = accounts.map(a=>`<option value="${esc(a.id)}" ${a.id===activeAcct?'selected':''}>${esc(a.id)} · ${fmt(a.size).replace('.00','')}</option>`).join(''); sel.onchange = () => switchAccount(sel.value); }
  const rb=$('reset'); if(rb) rb.textContent='Reset "'+activeAcct+'" to '+fmt(acctSize()).replace('.00','');
  const mgr = $('acctMgr');
  if (mgr){
    mgr.innerHTML = accounts.map(a=>{ const st = a.id===activeAcct ? null : store.get(acctKey(a.id)); const open = a.id===activeAcct ? positions.length : (st?.positions||[]).length; return `<div class="row acctrow"><span><b>${esc(a.id)}</b>${a.id===activeAcct?' <span class="ok">(active)</span>':''}${a.id==='main'?' <span class="hint">· competes on the leaderboard</span>':''}<div class="hint">start ${fmt(a.size).replace('.00','')} · ${open} open position${open===1?'':'s'}</div></span><span class="acctbtns">${a.id!=='main'?`<button class="mini" data-del="${esc(a.id)}">Delete</button>`:''}${a.id!==activeAcct?`<button class="mini primary" data-sw="${esc(a.id)}">Switch</button>`:''}</span></div>`; }).join('')
      + `<div class="acctnew"><input id="newAcct" placeholder="Account name" maxlength="16"><input id="newAcctSize" type="number" min="1" inputmode="decimal" placeholder="Start $ (10000)"><button class="mini primary" id="addAcct">Create</button></div><div class="hint" style="margin-top:4px">${signedIn() ? 'Accounts are saved to your login and follow you to any device.' : 'Guest accounts are saved in this browser only — create a login to keep them.'}</div>`;
    const add=$('addAcct'); if(add) add.onclick=async ()=>{
      const n=($('newAcct').value||'').trim().slice(0,16);
      const sz=Math.max(1, Math.min(1e9, +$('newAcctSize').value || 10000));
      if(!n) return toast('Name the account');
      if(!/^[\w .\-]+$/.test(n)) return toast('Use letters, numbers, spaces, . or -');
      if(accounts.find(a=>a.id.toLowerCase()===n.toLowerCase())) return toast('That name is taken');
      if(accounts.length>=25) return toast('Account limit reached (25)');
      accounts.push({ id:n, size:sz }); saveAccounts(); announce('accounts'); await switchAccount(n, { fresh:true }); toast('Created '+n+' with '+fmt(sz).replace('.00',''));
    };
    mgr.querySelectorAll('[data-del]').forEach(b=>b.onclick=async ()=>{ const a=b.dataset.del; if(!confirm('Delete paper account "'+a+'"? Its trades are erased.')) return; store.set(acctKey(a), null); accounts=accounts.filter(x=>x.id!==a); saveAccounts(); announce('accounts'); if (signedIn()) backend.deleteAccount(a).catch(()=>toast('Could not delete on the server — will retry next sync')); if(activeAcct===a){ activeAcct='__gone'; await switchAccount('main'); } else renderAccountUI(); toast('Deleted '+a); });
    mgr.querySelectorAll('[data-sw]').forEach(b=>b.onclick=()=>switchAccount(b.dataset.sw));
  }
}
const esc = x => String(x).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function switchAccount(a, { fresh = false } = {}){
  if(a===activeAcct){ renderAccountUI(); return; }
  if (accounts.find(x=>x.id===activeAcct)) { saveActiveState(); if (dirtyAcct) await flushCloud(); }   // park the account we're leaving
  activeAcct=a; saveAccounts();
  loadActiveState();               // the target account's state (or a fresh one at its starting size)
  relinkTokens();
  if (fresh) { dirtyAcct = true; }
  markDirty(fresh ? 'both' : 'prefs');   // remember the active account across devices (+ create the new one in the cloud)
  renderAccountUI(); render(); if ($('v-dash')?.classList.contains('on')) renderDash(); if ($('v-portfolio')?.classList.contains('on')) renderPortfolio();
  try { KC._drawSig=null; applyDrawings(true); } catch {}
  toast('Switched to '+a);
}
function snapshot(){ return { cash, trades: trades.slice(-400), positions: positions.map(p=>({addr:p.addr,side:p.side,received:p.received,entry:p.entry,qty:p.qty,cost:p.cost,grade:p.grade,opened:p.opened,tp:p.tp,sl:p.sl,sym:p.token.sym,name:p.token.name,price:p.token.price,liq:p.token.liq,mcap:p.token.mcap,pair:p.token.pair})), orders, equityLog: equityLog.slice(-720), weekId, weekStartEq, resetAt }; }
function saveActiveState(){ store.set(acctKey(activeAcct), snapshot()); }
function loadActiveState(){
  const s=store.get(acctKey(activeAcct));
  const startBal = acctSize();
  if(!s){ cash=startBal; trades=[]; positions=[]; orders=[]; equityLog=[]; weekStartEq=startBal; weekId=isoWeek(); resetAt=Date.now(); return; }
  cash=isFinite(+s.cash)?+s.cash:startBal; trades=s.trades||[]; orders=s.orders||[]; equityLog=s.equityLog||[]; weekStartEq=s.weekStartEq||startBal; weekId=s.weekId||isoWeek(); resetAt=s.resetAt||Date.now();
  positions=(s.positions||[]).map(p=>({...p,token:{addr:p.addr,sym:p.sym,name:p.name,price:p.price,liq:p.liq,mcap:p.mcap,pair:p.pair,grade:{g:p.grade,score:0,flags:[]}}}));
}

function renderDetail(){
  const t = selected, d = $('detail'); if (!t) return; const q = quoteBuy(t, sizeUsd), qs = quoteShort(t, sizeUsd);
  // the chart, its drawings and the toolbar survive re-renders (this runs every few seconds); so does whatever you've typed in the ticket
  const keepKc = KC ? document.getElementById('kc') : null, keepRail = $('drawrail'); if (keepKc) keepKc.remove(); if (keepRail) keepRail.remove();
  const wasFull = d.classList.contains('chart-full');
  const form = {}; ['useTP','useSL'].forEach(id => { const e=$(id); if (e) form[id] = e.checked; }); ['rewardAmt','riskAmt','trigPrice','customAmt'].forEach(id => { const e=$(id); if (e) form[id] = e.value; }); const focusId = document.activeElement?.id; const sameTok = d.dataset.addr === t.addr && d.dataset.ord === ordType; d.dataset.addr = t.addr; d.dataset.ord = ordType;
  d.innerHTML = `
    <div class="hdr"><span class="star ${watch.has(t.addr)?'on':''}" id="dstar">★</span><span class="sym">${t.sym}</span><span class="name" style="max-width:none">${t.name}</span>${gBadge(t.grade.g)}<span style="font-size:12px;color:var(--t3)">safety ${t.grade.score}/100</span></div>
    <div class="price num">${fmtP(t.price)} <span style="font-size:14px" class="${t.ch1>=0?'up':'dn'}">${pct(t.ch1)} 1h</span></div>
    <div class="mcapline">Market cap <b class="num">${fmtK(liveMcap(t))}</b> · Liquidity <b class="num">${fmtK(t.liq)}</b> · <span class="rugword rug-${t.grade.g}">${({A:'Safe',B:'Low risk',C:'Caution',D:'High risk',F:'Likely rug'}[t.grade.g]||'')}</span></div>
    <div class="chartbar">
      ${['1m','5m','15m','1h'].map(x=>`<button class="tfbtn ${x===tf?'on':''}" data-tf="${x}">${x}</button>`).join('')}
      <div class="indi-wrap"><button class="indibtn" id="indiBtn">⚙ Indicators</button>
        <div class="indi-menu" id="indiMenu" style="display:none">
          ${[['ma20','MA 20'],['ma50','MA 50'],['ema20','EMA 20'],['bb','Bollinger Bands'],['rsi','RSI (14)']].map(([k,l])=>`<label><input type="checkbox" data-ind="${k}" ${indi[k]?'checked':''}> ${l}</label>`).join('')}
        </div></div>
      <button class="tfbtn" id="chartFull" title="Full-screen chart" aria-label="Full-screen chart">⛶</button>
      <span class="src" id="csrc"></span>
    </div>
    <div class="chartrow">
      <div class="drawrail" id="drawrail"></div>
      <div id="chartwrap"></div>
    </div>
    <div class="ohlc" id="ohlc"></div><div class="ohlc num" id="lasttrade" style="color:var(--t3)">${live ? 'waiting for the next trade…' : ''}</div>
    <div class="stats"><div>Liquidity<b class="num">${fmtK(t.liq)}</b></div><div>Market cap<b class="num">${fmtK(t.mcap)}</b></div><div>24h volume<b class="num">${fmtK(t.vol24)}</b></div><div>Buys / sells (1h)<b class="num">${t.buys} / ${t.sells}</b></div><div>Pair age<b class="num">${age(t.created)}</b></div><div>Vol ÷ liq<b class="num">${(t.vol24/Math.max(t.liq,1)).toFixed(1)}×</b></div></div>
    ${t.grade.flags.length ? `<div class="flags">Bears say:<ul style="margin:4px 0 0;padding-left:18px">${t.grade.flags.map(f=>`<li>${f}</li>`).join('')}</ul></div>` : `<div class="flags">No red flags on this pool right now.</div>`}
`;
  const op = $('orderpanel'); if (op) op.innerHTML = `
    <div class="ticket">
      <div class="ordtabs"><button class="ordtab ${ordType==='market'?'on':''}" data-ot="market">Market</button><button class="ordtab ${ordType==='limit'?'on':''}" data-ot="limit">Limit</button><button class="ordtab ${ordType==='stop'?'on':''}" data-ot="stop">Stop</button></div>
      <div class="ordlabel">Amount <span style="color:var(--t3)">· ${solUsd?('◎'+(sizeUsd/solUsd).toFixed(2)+' SOL'):('$'+sizeUsd)}</span></div>
      <div class="presets">${[0.5,1,2,5,10].map(sol=>{ const usd=Math.round(sol*(solUsd||150)); return `<button class="sol ${Math.abs(usd-sizeUsd)<1?'on':''}" data-usd="${usd}">◎${sol}</button>`; }).join('')}</div>
      <div class="presets pctrow">${[10,25,50,100].map(p=>`<button class="pct" data-pct="${p}">${p}%</button>`).join('')}<input class="ordinput sm num" id="customAmt" placeholder="Custom $" style="flex:1;margin-left:6px"></div>
      ${ordType!=='market' ? `<div class="ordlabel">${ordType==='limit'?'Limit price':'Stop price'}</div><input class="ordinput num" id="trigPrice" value="${(t.price).toPrecision(4)}">` : ''}
      <div class="exits">
        <div class="exitrow"><label class="exitchk"><input type="checkbox" id="useTP"> Take profit</label><div class="exitfield tp"><span>+$</span><input class="num" id="rewardAmt" type="number" min="0" inputmode="decimal" placeholder="100" aria-label="Take profit in dollars" disabled></div></div>
        <div class="exitrow"><label class="exitchk"><input type="checkbox" id="useSL"> Stop loss</label><div class="exitfield sl"><span>−$</span><input class="num" id="riskAmt" type="number" min="0" inputmode="decimal" placeholder="50" aria-label="Stop loss in dollars" disabled></div></div>
        <div class="exitpreview" id="exitPreview"></div>
      </div>
      <div class="row"><span>Impact / fees</span><b class="num">${(q.impact*100).toFixed(2)}% · ${fmt(q.fees)}</b></div>
      <div class="row"><span>Long fills</span><b class="num">${q.qty.toLocaleString(undefined,{maximumFractionDigits:0})} ${t.sym}</b></div>
      <div class="two"><button class="primary" id="long" ${sizeUsd>cash?'disabled':''}>${ordType==='market'?'Long':'Place '+ordType} ${solUsd?('◎'+(sizeUsd/solUsd).toFixed(2)+' · '):''}${fmt(sizeUsd)}</button><button class="danger" id="short" ${sizeUsd>cash?'disabled':''}>${ordType==='market'?'Short':'Place short'} ${solUsd?('◎'+(sizeUsd/solUsd).toFixed(2)+' · '):''}${fmt(sizeUsd)}</button></div>
      ${orders.filter(o=>o.addr===t.addr).length ? `<div class="ordlabel" style="margin-top:10px">Open orders</div>${orders.filter(o=>o.addr===t.addr).map(o=>`<div class="row"><span>${o.kind} ${o.dir} @ ${fmtP(o.trigger)}</span><button class="mini" data-cancel="${o.id}">Cancel</button></div>`).join('')}` : ''}
    </div>`;
  document.querySelectorAll('.presets button[data-usd]').forEach(b => b.onclick = () => { sizeUsd = +b.dataset.usd; renderDetail(); });
  document.querySelectorAll('.presets button[data-pct]').forEach(b => b.onclick = () => { sizeUsd = Math.max(1, Math.round(cash * (+b.dataset.pct/100))); renderDetail(); });
  const ca=$('customAmt'); if(ca) ca.onchange=()=>{ const v=+ca.value; if(v>0){ sizeUsd=v; renderDetail(); } };
  d.querySelectorAll('.tfbtn').forEach(b => b.onclick = () => { tf = b.dataset.tf; renderDetail(); });
  // indicators menu
  $('indiBtn').onclick = () => { const m = $('indiMenu'); m.style.display = m.style.display==='none'?'block':'none'; };
  d.querySelectorAll('[data-ind]').forEach(cb => cb.onchange = () => { indi[cb.dataset.ind] = cb.checked; applyIndicators(); save('prefs'); });
  // drawing tools
  if (keepKc) $('chartwrap').appendChild(keepKc);
  if (keepRail) $('drawrail').replaceWith(keepRail); else DT.mount($('drawrail'));
  const setFull = on => { d.classList.toggle('chart-full', on); document.documentElement.classList.toggle('has-chart-full', on); $('chartFull').textContent = on ? '✕' : '⛶'; $('chartFull').title = on ? 'Exit full screen' : 'Full-screen chart'; setTimeout(()=>{ try { KC?.resize(); } catch {} }, 60); };
  setFull(wasFull); $('chartFull').onclick = () => setFull(!d.classList.contains('chart-full'));
  document.querySelectorAll('.ordtab').forEach(b => b.onclick = () => { ordType = b.dataset.ot; renderDetail(); });
  const useTP=$('useTP'), useSL=$('useSL');
  // TP/SL are entered as dollars of profit / risk and converted to a trigger price for the side being traded.
  // long: profit when price rises; short: profit when price falls. Limit/stop orders measure from the trigger price.
  const exitPrices=(side)=>{
    const t=selected; if(!t) return { tp:null, sl:null };
    const trig = ordType!=='market' ? +($('trigPrice')?.value) : 0;
    const q = side==='long' ? quoteBuy(t, sizeUsd) : quoteShort(t, sizeUsd);
    const entry = trig>0 ? trig : q.fill;
    const qty = trig>0 ? (side==='long' ? Math.max(0,sizeUsd-q.fees)/trig : sizeUsd/trig) : q.qty;
    if(!(qty>0)) return { tp:null, sl:null };
    const rw = $('useTP')?.checked ? +$('rewardAmt').value : 0, rk = $('useSL')?.checked ? +$('riskAmt').value : 0;
    const dir = side==='long' ? 1 : -1;
    let tp = rw>0 ? entry + dir*rw/qty : null, sl = rk>0 ? entry - dir*rk/qty : null;
    if(tp!=null && tp<=0) tp=null; if(sl!=null && sl<=0) sl=null;   // a short can't take profit below $0 / a long can't stop below $0
    return { tp, sl, rw, rk };
  };
  const updateExitPreview=()=>{
    const pv=$('exitPreview'); if(!pv||!selected) return;
    const L=exitPrices('long'), S=exitPrices('short');
    const line=(name,x)=>{ const parts=[]; if(x.rw>0) parts.push('<span class="up">TP '+(x.tp!=null?fmtP(x.tp):'n/a')+'</span>'); if(x.rk>0) parts.push('<span class="dn">SL '+(x.sl!=null?fmtP(x.sl):'n/a')+'</span>'); return parts.length?`<div><b>${name}</b> ${parts.join(' · ')}</div>`:''; };
    let html=line('Long',L)+line('Short',S);
    if(L.rw>0&&L.rk>0) html+=`<div>Reward : risk ${(L.rw/L.rk).toFixed(1)} : 1</div>`;
    pv.innerHTML=html;
  };
  if(useTP) useTP.onchange=()=>{ $('rewardAmt').disabled=!useTP.checked; if(useTP.checked) $('rewardAmt').focus(); updateExitPreview(); };
  if(useSL) useSL.onchange=()=>{ $('riskAmt').disabled=!useSL.checked; if(useSL.checked) $('riskAmt').focus(); updateExitPreview(); };
  const ra=$('rewardAmt'), rk=$('riskAmt'); if(ra) ra.oninput=updateExitPreview; if(rk) rk.oninput=updateExitPreview; const tpi=$('trigPrice'); if(tpi) tpi.oninput=updateExitPreview;
  document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{ orders=orders.filter(o=>o.id!==b.dataset.cancel); save(); renderDetail(); toast('Order cancelled'); });
  function fire(side){ const ex=exitPrices(side); if (ordType==='market'){ openTrade(side, { tp:ex.tp, sl:ex.sl }); } else { const trig=+$('trigPrice').value; if(!trig) return toast('Enter a price'); placeOrder(side, ordType, trig, ex.tp, ex.sl); } }
  $('long').onclick = () => fire('long'); $('short').onclick = () => fire('short');
  $('dstar').onclick = () => { const onw = !watch.has(t.addr); onw ? watch.add(t.addr) : watch.delete(t.addr); save(); render(); syncStream(); markDirty('prefs'); };
  if (sameTok) { ['useTP','useSL'].forEach(id => { const e=$(id); if (e && form[id]) { e.checked = true; e.onchange(); } }); ['rewardAmt','riskAmt','trigPrice','customAmt'].forEach(id => { const e=$(id); if (e && form[id] != null && form[id] !== '') e.value = form[id]; }); updateExitPreview(); if (focusId && $(focusId) && focusId !== document.activeElement?.id && /rewardAmt|riskAmt|trigPrice|customAmt/.test(focusId)) { const e=$(focusId); e.focus(); try { e.setSelectionRange(e.value.length, e.value.length); } catch {} } }
  loadChart(t);
}
let bottomTab = 'positions';
function renderPositions(){
  const el = $('bottomPanel'); if (!el) return; el.scrollTop = el.scrollTop;
  if (bottomTab === 'orders'){
    el.innerHTML = orders.length ? `<table class="btbl"><thead><tr><th>Token</th><th>Type</th><th>Side</th><th>Trigger</th><th>Amount</th><th></th></tr></thead><tbody>${orders.map(o=>`<tr><td class="sym">${o.sym}</td><td>${o.kind}</td><td><span class="side ${o.dir}">${o.dir.toUpperCase()}</span></td><td class="num">${fmtP(o.trigger)}</td><td class="num">${fmt(o.usd)}</td><td><button class="mini" data-cancel="${o.id}">Cancel</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No open orders. Use the Limit or Stop tabs to place one.</div>';
    el.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{ orders=orders.filter(o=>o.id!==b.dataset.cancel); save(); renderPositions(); if(selected) renderDetail(); toast('Order cancelled'); });
    return;
  }
  if (bottomTab === 'history'){
    el.innerHTML = trades.length ? `<table class="btbl"><thead><tr><th>Time</th><th>Token</th><th>Action</th><th>Price</th><th>Amount</th><th>P&L</th></tr></thead><tbody>${trades.slice().reverse().slice(0,60).map(t=>`<tr><td class="num">${new Date(t.ts).toLocaleTimeString()}</td><td class="sym">${t.sym}</td><td><span class="side ${t.dir}">${t.open?'OPEN':'CLOSE'} ${t.dir.toUpperCase()}</span></td><td class="num">${fmtP(t.price)}</td><td class="num">${fmt(t.usd)}</td><td class="num ${(t.pnl||0)>=0?'up':'dn'}">${t.pnl!=null?fmt(t.pnl):'—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No trades yet.</div>';
    return;
  }
  // positions (default)
  const valid = positions.filter(p=>p.token && p.token.sym && p.token.sym!=='?' && isFinite(p.token.price) && p.token.price>0 && p.qty>0 && isFinite(p.entry) && p.entry>0); if (!valid.length) { el.innerHTML = '<div class="empty">No open positions. Long if you think it goes up, short if you think it rugs.</div>'; return; }
  el.innerHTML = `<div style="padding:6px 12px;text-align:right"><button class="mini danger" id="closeAllBtn">Close all (${valid.length})</button></div><table class="btbl"><thead><tr><th>Token</th><th>Side</th><th>Qty</th><th>Entry</th><th>Now</th><th>Value</th><th>P&L</th><th>TP/SL</th><th></th></tr></thead><tbody>` + valid.map(p => { const v = posValue(p); const pnl = v - p.cost; const chg = p.side==='short' ? (p.entry-p.token.price)/p.entry : (p.token.price-p.entry)/p.entry; return `
    <tr class="pos" data-a="${p.addr}" data-s="${p.side}"><td><span class="sym">${p.token.sym}</span> ${gBadge(p.grade)}</td><td><span class="side ${p.side}">${p.side.toUpperCase()}</span></td><td class="num" data-l="Qty">${p.qty.toLocaleString(undefined,{maximumFractionDigits:0})}</td><td class="num" data-l="Entry">${fmtP(p.entry)}</td><td class="num now" data-l="Now">${fmtP(p.token.price)} <span class="${chg>=0?'up':'dn'}">${pct(chg*100)}</span></td><td class="num val" data-l="Value">${fmt(v)}</td><td class="num ${pnl>=0?'up':'dn'} pnlcell">${fmt(pnl)} (${pct(pnl/p.cost*100)})</td><td class="num tpsl" style="font-size:11px;color:var(--t3)">${p.tp?'TP '+fmtP(p.tp):''}${p.sl?' SL '+fmtP(p.sl):''}${!p.tp&&!p.sl?'—':''}</td>
    <td class="acts"><button data-a="${p.addr}" data-s="${p.side}" data-p="25">25%</button><button data-a="${p.addr}" data-s="${p.side}" data-p="50">50%</button><button class="danger" data-a="${p.addr}" data-s="${p.side}" data-p="100">Close</button></td></tr>`; }).join('') + '</tbody></table>';
  el.querySelectorAll('.acts button').forEach(b => b.onclick = () => closeTrade(b.dataset.a, b.dataset.s, +b.dataset.p));
  const ca=$('closeAllBtn'); if(ca) ca.onclick=closeAllPositions;
}

// ---------- navigation ----------
function show(v){ document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'v-'+v)); document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); if (v === 'portfolio') renderPortfolio(); if (v === 'comp') renderComp(); if (v === 'settings') { unread = 0; $('abadge').style.display = 'none'; notifState(); renderAlerts(); renderAccountUI(); } if (v === 'trade') render(); if (v === 'dash'){ renderDash(); if(!globalNews.length) loadGlobalNews(); } if (v === 'news'){ renderNews(); if(!globalNews.length) loadGlobalNews(); } if (v === 'screen') SCR.render(); if (v === 'legal') renderLegal(); }
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => show(b.dataset.v));
$('reset').onclick = () => { const RB=baseline(); if (confirm('Reset "'+activeAcct+'" to '+fmt(RB)+' and close all positions?'+(activeAcct==='main'?' Your all-time competition return restarts.':''))) { cash = RB; positions = []; trades = []; orders = []; equityLog = []; resetAt = Date.now(); weekStartEq = RB; save(); render(); syncLeaderboard(); toast('Account reset'); } };

['q','fg','fl','fa','fs','fw'].forEach(id => $(id).addEventListener('input', render));

// ---------- landing page ----------
const onPhone = () => document.documentElement.classList.contains('mobile');
// phones open straight on the sign-in screen (that IS the app's landing page there); desktop gets the marketing page
function showLanding(){ if (onPhone()) return showAuth(); const l=$('landing'); if(l) l.style.display='block'; $('auth').style.display='none'; $('app').style.display='none'; }
function landingToAuth(mode){ const l=$('landing'); if(l) l.style.display='none'; showAuth(); setMode(mode==='reg'?'reg':'login'); }
function enterGuest(){ const l=$('landing'); if(l) l.style.display='none'; guest = true; TOKEN = null; localStorage.setItem('ms_guest','1'); enterApp(); }
(function wireLanding(){
  const bind=(id,fn)=>{ const e=$(id); if(e) e.onclick=fn; };
  bind('landing-login', ()=>landingToAuth('login'));
  ['landing-start','landing-start2','landing-start3'].forEach(id=>bind(id, ()=>landingToAuth('reg')));
  bind('landing-demo', enterGuest);
  bind('auth-back', ()=>showLanding());
  // decorative candles for the landing mock + login art (seeded so it looks the same every load)
  const candles=(id,n,W,H)=>{ const el=$(id); if(!el) return; let seed=7, r=()=>(seed=(seed*16807)%2147483647)/2147483647; let p=50; const cs=[]; for(let i=0;i<n;i++){ const o=p, c=Math.max(8,o+(r()-.42)*16), h=Math.max(o,c)+r()*7, l=Math.min(o,c)-r()*7; cs.push([o,h,l,c]); p=c; } const mx=Math.max(...cs.map(c=>c[1])), mn=Math.min(...cs.map(c=>c[2])); const y=v=>8+(mx-v)/(mx-mn)*(H-16), w=W/n;
    el.innerHTML = [0.25,0.5,0.75].map(f=>`<line x1="0" x2="${W}" y1="${H*f}" y2="${H*f}" stroke="rgba(255,255,255,.05)"/>`).join('') + cs.map((c,i)=>{ const up=c[3]>=c[0], col=up?'#26A69A':'#EF5350', x=i*w+w/2; return `<line x1="${x}" x2="${x}" y1="${y(c[1])}" y2="${y(c[2])}" stroke="${col}" stroke-width="1"/><rect x="${x-w*0.32}" y="${y(Math.max(c[0],c[3]))}" width="${w*0.64}" height="${Math.max(1.5,Math.abs(y(c[0])-y(c[3])))}" fill="${col}" rx="1"/>`; }).join('') + `<line x1="0" x2="${W}" y1="${y(cs[n-1][3])}" y2="${y(cs[n-1][3])}" stroke="#26A69A" stroke-dasharray="4 4" stroke-width="1"/>`; };
  candles('heroChart',44,420,220); candles('authChart',52,420,160);
  setInterval(()=>{ const el=$('ls-tokens'); if(el && tokens.length) el.textContent=tokens.length+'+'; }, 2000);
})();

// ---------- auth UI ----------
window.__authMode = window.__authMode || 'login';
function showAuth(){ const l=$('landing'); if(l) l.style.display='none'; $('auth').style.display = 'flex'; $('app').style.display = 'none'; const bk=$('auth-back'); if(bk) bk.style.display = onPhone() ? 'none' : ''; checkServer(); }
function showApp(){ $('auth').style.display = 'none'; $('app').style.display = 'block'; }
function setMode(m){ window.__authMode = m; $('tab-login').classList.toggle('on', m==='login'); $('tab-reg').classList.toggle('on', m==='reg'); $('nick-l').style.display = m==='reg'?'block':'none'; const cl=$('consent-l'); if (cl) cl.style.display = m==='reg'?'flex':'none'; $('authbtn').textContent = m==='reg'?'Create account':'Log in'; $('f-pass').autocomplete = m==='reg'?'new-password':'current-password'; $('autherr').textContent=''; const h=$('auth-h'); if(h) h.textContent = m==='reg' ? 'Create your account' : 'Welcome back'; const sub=$('auth-sub'); if(sub) sub.textContent = m==='reg' ? 'Free while in beta. $10,000 of paper money to start.' : 'Log in to pick up where you left off.'; const sw=$('auth-switch'); if(sw) sw.innerHTML = m==='reg' ? 'Already have an account? <a href="#" data-mode="login">Log in</a>' : 'New here? <a href="#" data-mode="reg">Create an account</a>'; }
document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('#auth-switch a[data-mode]'); if (a) { e.preventDefault(); setMode(a.dataset.mode); } });
{ const pw=$('f-pass'), eye=$('pw-eye'); if (eye) eye.onclick = () => { const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; eye.textContent = show ? 'Hide' : 'Show'; }; }
{ const r=$('f-remember'); if (r) { const pref = localStorage.getItem('ms_remember'); r.checked = pref == null ? true : pref === '1'; r.onchange = () => localStorage.setItem('ms_remember', r.checked ? '1' : '0'); } }
$('authform').onsubmit = async e => {
  e.preventDefault(); $('autherr').textContent=''; const btn=$('authbtn'); btn.disabled = true; const label = btn.textContent; btn.textContent = window.__authMode==='reg' ? 'Creating account…' : 'Logging in…';
  const email = $('f-email').value.trim(), password = $('f-pass').value, nickname = $('f-nick').value.trim(); const remember = $('f-remember') ? $('f-remember').checked : true;
  try {
    if (window.__authMode==='reg' && password.length < 8) throw new Error('Password must be at least 8 characters');
    if (window.__authMode==='reg' && $('f-consent') && !$('f-consent').checked) throw new Error('Please agree to the Terms and Privacy Policy');
    ME = await (window.__authMode==='reg' ? backend.register({ email, password, nickname }, remember) : backend.login({ email, password }, remember));
    TOKEN = session.get()?.token || null; guest = false; localStorage.removeItem('ms_guest'); $('f-pass').value='';
    await enterApp(); if (window.__authMode==='reg') toast('Welcome, '+(ME?.nickname||'trader')+' — your account is ready');
  } catch (err) { $('autherr').textContent = err.message; } finally { btn.disabled = false; btn.textContent = label; }
};
$('guest').onclick = enterGuest;
function logout(){ const was = signedIn(); clearTimeout(syncTimer); WAL.disconnect(false); dirtyAcct = dirtyProfile = false; if (was) backend.logout().catch(()=>{}); else session.clear(); TOKEN = null; ME = null; guest = false; localStorage.removeItem('ms_guest'); positions=[]; trades=[]; orders=[]; selected=null; announce('logout'); notifyHost({ type:'ms-signed-out' }); showLanding(); setMode('login'); }
$('logout').onclick = logout;
// ---------- broker picker ----------
const BROKERS = [
  { name:'Paper Trading', desc:'Simulator by MemeScreen', paper:true, rating:'' },
  { name:'Phantom', desc:'Solana wallet', rating:'4.6' }, { name:'Coinbase', desc:'Exchange', rating:'4.3' },
  { name:'Kraken', desc:'Exchange', rating:'4.2' }, { name:'OKX', desc:'Exchange', rating:'4.5' },
  { name:'Jupiter', desc:'Solana DEX', rating:'4.5' }, { name:'Axiom', desc:'Solana terminal', rating:'4.4' },
  { name:'Photon', desc:'Solana terminal', rating:'4.3' }, { name:'GMGN', desc:'Analytics + trade', rating:'4.2' },
  { name:'BullX', desc:'Multi-chain terminal', rating:'4.1' }, { name:'Birdeye', desc:'Analytics', rating:'4.1' },
  { name:'Crypto.com', desc:'Exchange', rating:'4.0' },
];
// Real brokers are listed but not live yet: they render greyed out, and a connection attempt runs and then fails cleanly.
const brokerState = {};   // name → 'connecting' | 'failed'
function openBrokerModal(){ const g=$('brokerGrid'); if(!g) return;
  const draw=()=>{ g.innerHTML = BROKERS.map(b=>{ const st=brokerState[b.name]; const ph = b.name==='Phantom' ? WAL.brokerCard() : null; const live = b.paper || !!ph; return `<button type="button" class="brokercard ${b.paper||ph?.state==='connected'?'active':live?'ready':'soon'} ${st||''}" data-b="${b.name}" ${st==='connecting'?'disabled':''}>
    <div class="brokericon">${b.paper||ph?.state==='connected'?'<span class="bdot ok"></span>':(b.name[0])}</div><b>${b.name}</b><div class="hint">${ph ? 'Solana wallet · read-only' : b.desc}</div>
    ${b.paper?'<div class="bstat ok">Connected</div>': st==='connecting'?'<div class="bstat"><span class="spin"></span> Connecting…</div>': st==='failed'?'<div class="bstat bad">Connection failed</div>': ph ? `<div class="bstat ${ph.state==='connected'?'ok':''}">${ph.label}</div>` : `<div class="bstat">★ ${b.rating} · Connect</div>`}</button>`; }).join('');
    g.querySelectorAll('.brokercard').forEach(c=>c.onclick=async ()=>{ const n=c.dataset.b; if(c.classList.contains('active')){ toast('Paper trading is already connected'); return; }
      if(n==='Phantom'){ brokerState[n]='connecting'; draw(); $('brokerMsg').textContent='Waiting for Phantom…'; try { const msg = await WAL.brokerClick(); brokerState[n]=null; draw(); $('brokerMsg').textContent=msg; if (WAL.connected()) { show('portfolio'); $('brokerModal').style.display='none'; } } catch(e){ brokerState[n]=null; draw(); $('brokerMsg').innerHTML='<span class="warn">'+esc(e.message||'Phantom refused the connection')+'</span>'; } return; }
      brokerState[n]='connecting'; draw(); $('brokerMsg').textContent='Contacting '+n+'…';
      setTimeout(()=>{ brokerState[n]='failed'; draw(); $('brokerMsg').innerHTML='<span class="warn">Couldn\'t connect to '+n+'.</span> Live broker connections aren\'t available yet — MemeScreen is paper trading only for now. Your paper account is unaffected.'; }, 1600); }); };
  draw(); $('brokerMsg').textContent='Pick a broker to connect. Paper Trading is always available.'; $('brokerModal').style.display='flex';
}
const bb=$('brokerBtn'); if(bb) bb.onclick=openBrokerModal;
const bc=$('brokerClose'); if(bc) bc.onclick=()=>{ $('brokerModal').style.display='none'; };
const cb=$('connectBroker'); if(cb) cb.onclick=openBrokerModal;
const bm=$('brokerModal'); if(bm) bm.onclick=e=>{ if(e.target===bm) bm.style.display='none'; };
// ---------- backend picker (Settings → Server, and the link under the login form) ----------
function openBackendModal(){
  const cfg = backendSettings(); const m=$('backendModal'); if(!m) return;
  m.querySelector('[name=bk][value='+cfg.kind+']').checked = true; $('bk-url').value = cfg.expressUrl; $('bk-app').value = cfg.back4app.appId||''; $('bk-key').value = cfg.back4app.jsKey||''; $('bk-srv').value = cfg.back4app.serverUrl||'';
  const sync=()=>{ const k=m.querySelector('[name=bk]:checked').value; $('bk-express').style.display = k==='express'?'block':'none'; $('bk-b4a').style.display = k==='back4app'?'block':'none'; }; m.querySelectorAll('[name=bk]').forEach(r=>r.onchange=sync); sync();
  $('bk-err').textContent=''; m.style.display='flex';
}
{ const m=$('backendModal'); if(m){ m.onclick=e=>{ if(e.target===m) m.style.display='none'; }; $('bk-close').onclick=()=>m.style.display='none'; const rs=$('bk-reset'); if(rs) rs.onclick=()=>{ resetBackendSettings(); try { localStorage.removeItem('ms_api'); } catch {} session.clear(); location.reload(); };
  $('bk-save').onclick=()=>{ const k=m.querySelector('[name=bk]:checked').value; if(k==='back4app' && (!$('bk-app').value.trim() || !$('bk-key').value.trim())){ $('bk-err').textContent='Paste both the Application ID and the JavaScript key.'; return; }
    saveBackendSettings({ backend:k, expressUrl:$('bk-url').value.trim().replace(/\/$/,''), back4app:{ appId:$('bk-app').value.trim(), jsKey:$('bk-key').value.trim(), serverUrl:($('bk-srv').value.trim()||'https://parseapi.back4app.com') } }); try { localStorage.removeItem('ms_api'); } catch {} session.clear(); location.reload(); }; } }
$('setapi').onclick = openBackendModal; { const l=$('auth-server'); if(l) l.onclick=e=>{ e.preventDefault(); openBackendModal(); }; }

async function checkServer(){ const el=$('srvstate'); if(!el) return false; const ok = await backend.health(); el.innerHTML = ok ? `<span class="srv ok">●</span> ${esc(backend.label)} · online` : `<span class="srv bad">●</span> ${esc(backend.label)} · not reachable — start it, change it, or browse as guest`; return ok; }

async function enterApp(){
  showApp(); const l=$('landing'); if(l) l.style.display='none';
  if (signedIn()) {
    let online = false;
    for (let attempt=0; attempt<2 && !online; attempt++){
      try { ME = await backend.me(); online = true; }
      catch (err) { if (isAuthError(err)) { toast('Session expired — sign in again'); return logout(); } await new Promise(r=>setTimeout(r, 800)); }
    }
    ME = ME || session.get()?.user || { email:'(offline)', nickname:'you' };
    loadPrefs(); loadAccounts();
    if (online) { try { await pullCloud(); } catch (e) { if (isAuthError(e)) return logout(); loadActiveState(); setSync('offline — using this browser\'s copy'); } }
    else { loadActiveState(); setSync('offline — using this browser\'s copy'); }
  } else {
    loadPrefs(); loadAccounts(); loadActiveState();     // guest: everything lives in this browser
  }
  renderAccountUI(); $('whoami').textContent = guest ? 'guest' : (ME?.nickname || '');
  $('acct').innerHTML = guest ? 'Browsing as guest. Your trades are saved only in this browser. Log out to create an account.' : `Signed in as <b>${esc(ME?.email||'')}</b> (${esc(ME?.nickname||'')})${session.get()?.remember ? ' · staying signed in on this device' : ' · signed in for this browser session only'}. Passwords are stored only as a bcrypt hash.`;
  $('apiurl').textContent = backend.label;
  notifyHost({ type:'ms-signed-in', user: guest ? 'guest' : (ME?.nickname||'') });
  renderAlerts(); fetchSol(); loadMarket();
  await refresh(); rollWeek(); syncStream(); bindBottomTabs(); show('dash');
  if (!window._ms_timers){ window._ms_timers = 1;
    setInterval(pollPrices, 2000); setInterval(refresh, 60000); setInterval(fetchSol, 60000); setInterval(render, 15000); setInterval(tick, 250); setInterval(evalAlerts, 5000);
    setInterval(() => { if ($('app').style.display==='none') return; equityLog.push([Date.now(), equity()]); if (equityLog.length>720) equityLog.shift(); rollWeek(); saveLocal(); if ($('v-portfolio').classList.contains('on')) drawEquity(); }, 5000);
    setInterval(syncLeaderboard, 60000); setInterval(pollCloud, 30000); loadGlobalNews(); setInterval(loadGlobalNews, 120000); loadMarket(); setInterval(()=>{ if($('v-dash')?.classList.contains('on')) loadMarket(); }, 300000);
    setInterval(() => { if ($('v-comp').classList.contains('on')) renderComp(); }, 10000);
  }
}

function bindBottomTabs(){
  document.querySelectorAll('.tbt').forEach(b => { b.onclick = () => { bottomTab = b.dataset.bt; document.querySelectorAll('.tbt').forEach(x=>x.classList.toggle('on', x.dataset.bt===bottomTab)); renderPositions(); }; });
  const bc=$('bottomCollapse'); if(bc && !bc._bound){ bc._bound=1; bc.onclick=()=>{ const tb=$('tBottom'); if(!tb) return; const collapsed=tb.classList.toggle('collapsed'); bc.textContent=collapsed?'▴':'▾'; }; }
}
// bottom panel resize
(function(){ let dragging=false, startY=0, startH=200;
  document.addEventListener('mousedown', e=>{ if(e.target && e.target.id==='bottomResizer'){ dragging=true; startY=e.clientY; startH=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--bottomH'))||200; e.preventDefault(); } });
  document.addEventListener('mousemove', e=>{ if(!dragging) return; const dy=startY-e.clientY; const h=Math.max(120,Math.min(500,startH+dy)); document.documentElement.style.setProperty('--bottomH', h+'px'); try{ if(KC&&KC.resize) KC.resize(); }catch{} });
  document.addEventListener('mouseup', ()=>{ dragging=false; });
})();

// ---------- boot ----------
load(); loadPrefs(); renderAlerts(); setMode('login');
if (signedIn()) {
  showApp(); enterApp().catch(err => { console.error('enterApp failed', err); });       // saved session → straight into the app
} else if (localStorage.getItem('ms_guest')) {
  guest = true; showApp(); enterApp().catch(err => console.error('enterApp failed', err));
} else {
  showLanding();
}
