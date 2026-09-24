// ============================================================
// MemeScreen — TradingView-style drawing tools for KLineChart v9.
//   • a toolbar grouped like TradingView's left rail (cursors, lines, fib/gann, shapes, notes, patterns, measure)
//   • custom overlays for everything KLineChart doesn't ship (fib retracement/extension, pitchforks, gann box,
//     shapes, callouts, XABCD / Elliott / head-and-shoulders, long/short position planners, range measures)
//   • magnet, lock, hide, eraser, delete-selected, clear
//   • drawings are saved per token (as prices + timestamps, so they survive reloads and timeframe changes)
// Works with a mouse and with touch (each tap places a point).
// ============================================================
const BLUE = '#2962FF', BLUE_FILL = 'rgba(41,98,255,.12)', GREEN = '#26A69A', RED = '#EF5350', GREY = '#9AA3B2', AMBER = '#F5C542';
const FONT = 'system-ui,-apple-system,Segoe UI,sans-serif';
const GROUP = 'user';

let H = null;                       // host hooks: { chart(), token(), supply(), fmtP(), toast(), onChange() }
let active = null, progressId = null, selectedId = null, eraser = false, magnet = false, lockedAll = false, hiddenAll = false, cursor = 'cross';
let ids = new Set(), saveT = null, restoring = false, mounted = null, lastByCat = {};

// ---------- figure helpers ----------
const line = (a, b, st = {}) => ({ type:'line', attrs:{ coordinates:[a, b] }, styles:{ color:BLUE, size:1.5, ...st } });
const dashed = (a, b, st = {}) => line(a, b, { style:'dashed', dashedValue:[4,4], size:1, ...st });
const poly = (pts, st = {}) => ({ type:'polygon', attrs:{ coordinates:pts }, styles:{ style:'fill', color:BLUE_FILL, ...st } });
const path = (pts, st = {}) => ({ type:'line', attrs:{ coordinates:pts }, styles:{ color:BLUE, size:1.5, ...st } });
const label = (x, y, text, st = {}, align = 'left', baseline = 'middle') => ({ type:'text', attrs:{ x, y, text, align, baseline }, styles:{ style:'fill', color:'#fff', size:11, family:FONT, weight:'600', backgroundColor:BLUE, borderRadius:3, paddingLeft:5, paddingRight:5, paddingTop:3, paddingBottom:3, ...st }, ignoreEvent:true });
const plain = (x, y, text, st = {}, align = 'center', baseline = 'bottom') => ({ type:'text', attrs:{ x, y, text, align, baseline }, styles:{ style:'fill', color:BLUE, size:12, family:FONT, weight:'700', backgroundColor:'transparent', paddingLeft:0, paddingRight:0, paddingTop:0, paddingBottom:0, ...st }, ignoreEvent:true });
const extend = (a, b, W, Hh) => { const dx = b.x - a.x, dy = b.y - a.y; if (!dx && !dy) return b; const k = (Math.max(W, Hh) * 4) / Math.hypot(dx, dy); return { x: b.x + dx * k, y: b.y + dy * k }; };
const mid = (a, b) => ({ x:(a.x + b.x) / 2, y:(a.y + b.y) / 2 });
const pctTxt = (from, to) => { if (!from) return ''; const c = (to - from) / from * 100; return (c >= 0 ? '+' : '') + c.toFixed(Math.abs(c) < 10 ? 2 : 1) + '%'; };
const price = v => { const s = H.supply() || 1; return H.fmtP(v / s); };
const dur = ms => { const m = Math.round(Math.abs(ms) / 60000); return m < 60 ? m + 'm' : m < 1440 ? (m / 60).toFixed(m % 60 ? 1 : 0) + 'h' : (m / 1440).toFixed(1) + 'd'; };
const barsOf = ms => Math.round(Math.abs(ms) / (H.barMs?.() || 60000));
const val = (o, i) => +o.points[i]?.value;
const ratio = (a, b) => (b ? Math.abs(a / b) : 0).toFixed(3);

// ---------- custom overlay templates ----------
const T = [];
const def = (name, totalStep, create, extra = {}) => T.push({ name, totalStep, needDefaultPointFigure:true, needDefaultXAxisFigure:true, needDefaultYAxisFigure:true, createPointFigures:create, ...extra });

def('ms_arrow', 3, ({ coordinates:c }) => { if (c.length < 2) return []; const [a, b] = c, ang = Math.atan2(b.y - a.y, b.x - a.x), L = 11, w = 0.45;
  return [line(a, b), poly([b, { x:b.x - L * Math.cos(ang - w), y:b.y - L * Math.sin(ang - w) }, { x:b.x - L * Math.cos(ang + w), y:b.y - L * Math.sin(ang + w) }], { color:BLUE })]; });

def('ms_infoLine', 3, ({ coordinates:c, overlay:o }) => { if (c.length < 2) return []; const [a, b] = c, m = mid(a, b); const t = Math.abs((o.points[1].timestamp || 0) - (o.points[0].timestamp || 0)), bars = barsOf(t);
  return [line(a, b), label(m.x + 8, m.y - 14, `${pctTxt(val(o,0), val(o,1))} · ${bars} bars${t ? ' · ' + dur(t) : ''}`)]; });

const FIB = [[0, GREY], [0.236, RED], [0.382, AMBER], [0.5, GREEN], [0.618, '#22B8CF'], [0.786, BLUE], [1, GREY], [1.618, '#9C6ADE']];
def('ms_fib', 3, ({ coordinates:c, overlay:o, bounding:bd }) => { if (c.length < 2) return []; const [a, b] = c, x0 = Math.min(a.x, b.x), x1 = bd.width, out = [dashed(a, b, { color:GREY })]; const v1 = val(o,0), v2 = val(o,1);
  let prevY = null, prevCol = null;
  for (const [L, col] of FIB) { const y = b.y + (a.y - b.y) * L; if (prevY != null && L <= 1) out.push({ ...poly([{ x:x0, y:prevY }, { x:x1, y:prevY }, { x:x1, y }, { x:x0, y }], { color: prevCol + '1A' }), ignoreEvent:true }); out.push(line({ x:x0, y }, { x:x1, y }, { color:col, size:1 })); out.push(plain(x0 + 4, y - 2, `${L}  ${price(v2 + (v1 - v2) * L)}`, { color:col, size:11, weight:'500' }, 'left', 'bottom')); prevY = y; prevCol = col; }
  return out; });

const FIBX = [[0, GREY], [0.618, AMBER], [1, GREEN], [1.272, '#22B8CF'], [1.618, BLUE], [2.618, '#9C6ADE']];
def('ms_fibExt', 4, ({ coordinates:c, overlay:o, bounding:bd, yAxis }) => { if (c.length < 2) return []; const out = [dashed(c[0], c[1], { color:GREY })]; if (c.length < 3) return out; out.push(dashed(c[1], c[2], { color:GREY }));
  const v1 = val(o,0), v2 = val(o,1), v3 = val(o,2), x0 = c[2].x;
  for (const [L, col] of FIBX) { const v = v3 + (v2 - v1) * L; const y = yAxis ? yAxis.convertToPixel(v) : c[2].y + (c[1].y - c[0].y) * L; out.push(line({ x:x0, y }, { x:bd.width, y }, { color:col, size:1 })); out.push(plain(x0 + 4, y - 2, `${L}  ${price(v)}`, { color:col, size:11, weight:'500' }, 'left', 'bottom')); }
  return out; });

def('ms_gannBox', 3, ({ coordinates:c }) => { if (c.length < 2) return []; const [a, b] = c, out = [poly([a, { x:b.x, y:a.y }, b, { x:a.x, y:b.y }], { color:'rgba(41,98,255,.06)' })]; const F = [0, .25, .382, .5, .618, .75, 1];
  for (const f of F) { const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f, edge = f === 0 || f === 1; out.push(line({ x, y:a.y }, { x, y:b.y }, { size:edge ? 1.5 : 1, color:edge ? BLUE : 'rgba(41,98,255,.45)' })); out.push(line({ x:a.x, y }, { x:b.x, y }, { size:edge ? 1.5 : 1, color:edge ? BLUE : 'rgba(41,98,255,.45)' })); if (!edge) out.push(plain(a.x - 4, y, String(f), { size:10, weight:'500' }, 'right', 'middle')); }
  out.push(dashed(a, b), dashed({ x:a.x, y:b.y }, { x:b.x, y:a.y })); return out; });

const fork = schiff => ({ coordinates:c, bounding:bd }) => { if (c.length < 2) return []; if (c.length < 3) return [dashed(c[0], c[1], { color:GREY })]; const [p1, p2, p3] = c, m = mid(p2, p3), o = schiff ? mid(p1, p2) : p1, d = { x:m.x - o.x, y:m.y - o.y }, W = bd.width, Hh = bd.height;
  const far = extend(o, m, W, Hh), f2 = extend(p2, { x:p2.x + d.x, y:p2.y + d.y }, W, Hh), f3 = extend(p3, { x:p3.x + d.x, y:p3.y + d.y }, W, Hh);
  return [{ ...poly([p2, f2, f3, p3], { color:'rgba(41,98,255,.07)' }), ignoreEvent:true }, dashed(p1, p2, { color:GREY }), line(p2, p3, { color:GREY, size:1 }), line(o, far, { color:RED }), line(p2, f2), line(p3, f3)]; };
def('ms_pitchfork', 4, fork(false)); def('ms_schiff', 4, fork(true));

def('ms_rect', 3, ({ coordinates:c }) => { if (c.length < 2) return []; const [a, b] = c, pts = [a, { x:b.x, y:a.y }, b, { x:a.x, y:b.y }]; return [poly(pts), path([...pts, a])]; });
def('ms_circle', 3, ({ coordinates:c }) => { if (c.length < 2) return []; const r = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y); return [{ type:'circle', attrs:{ ...c[0], r }, styles:{ style:'stroke_fill', color:BLUE_FILL, borderColor:BLUE, borderSize:1.5 } }]; });
def('ms_triangle', 4, ({ coordinates:c }) => c.length < 2 ? [] : c.length < 3 ? [line(c[0], c[1])] : [poly(c), path([...c, c[0]])]);
def('ms_parallelogram', 4, ({ coordinates:c }) => { if (c.length < 2) return []; if (c.length < 3) return [line(c[0], c[1])]; const p4 = { x:c[0].x + (c[2].x - c[1].x), y:c[0].y + (c[2].y - c[1].y) }, pts = [c[0], c[1], c[2], p4]; return [poly(pts), path([...pts, c[0]])]; });

def('ms_text', 2, ({ coordinates:c, overlay:o }) => c.length ? [{ ...plain(c[0].x, c[0].y, o.extendData?.text || 'Text', { color:'#E4E6EB', size:14, weight:'500' }, 'left', 'middle'), ignoreEvent:false }] : [], { needDefaultXAxisFigure:false, needDefaultYAxisFigure:false });
def('ms_callout', 3, ({ coordinates:c, overlay:o }) => { if (!c.length) return []; if (c.length < 2) return []; const [a, b] = c; return [line(a, b, { size:1 }), { type:'circle', attrs:{ ...a, r:3 }, styles:{ style:'fill', color:BLUE } }, { ...label(b.x, b.y, o.extendData?.text || 'Note', { size:12, weight:'500', paddingLeft:8, paddingRight:8, paddingTop:6, paddingBottom:6, borderRadius:6 }, b.x >= a.x ? 'left' : 'right'), ignoreEvent:false }]; }, { needDefaultXAxisFigure:false, needDefaultYAxisFigure:false });
def('ms_priceNote', 2, ({ coordinates:c, overlay:o }) => c.length ? [line({ x:c[0].x - 10, y:c[0].y }, { x:c[0].x + 10, y:c[0].y }), { ...label(c[0].x + 14, c[0].y, price(val(o,0)) + (o.extendData?.text ? '  ' + o.extendData.text : '')), ignoreEvent:false }] : [], { needDefaultXAxisFigure:false });
const marker = up => ({ coordinates:c, overlay:o }) => { if (!c.length) return []; const { x, y } = c[0], s = up ? 1 : -1, col = up ? GREEN : RED; const t = o.extendData?.text;
  return [poly([{ x, y:y + 4 * s }, { x:x - 8, y:y + 16 * s }, { x:x - 3, y:y + 16 * s }, { x:x - 3, y:y + 28 * s }, { x:x + 3, y:y + 28 * s }, { x:x + 3, y:y + 16 * s }, { x:x + 8, y:y + 16 * s }], { color:col }), ...(t ? [plain(x, y + (up ? 44 : -32), t, { color:col, size:11 }, 'center', 'middle')] : [])]; };
def('ms_arrowUp', 2, marker(true), { needDefaultXAxisFigure:false, needDefaultYAxisFigure:false }); def('ms_arrowDown', 2, marker(false), { needDefaultXAxisFigure:false, needDefaultYAxisFigure:false });
def('ms_flag', 2, ({ coordinates:c }) => { if (!c.length) return []; const { x, y } = c[0]; return [line({ x, y }, { x, y:y - 30 }, { color:AMBER, size:2 }), poly([{ x, y:y - 30 }, { x:x + 20, y:y - 24 }, { x, y:y - 17 }], { color:AMBER })]; }, { needDefaultXAxisFigure:false, needDefaultYAxisFigure:false });

const wave = (labels, opt = {}) => ({ coordinates:c, overlay:o, bounding:bd }) => { if (!c.length) return []; const out = [];
  if (opt.fills && c.length >= 3) out.push({ ...poly([c[0], c[1], c[2]]), ignoreEvent:true }); if (opt.fills && c.length >= 5) out.push({ ...poly([c[2], c[3], c[4]]), ignoreEvent:true });
  if (c.length > 1) out.push(path(c, { size:2 }));
  if (opt.xabcd) { const R = (i, j, k, l) => ratio(val(o,k) - val(o,l), val(o,i) - val(o,j)); if (c.length >= 3) { out.push(dashed(c[0], c[2])); out.push(label(mid(c[0], c[2]).x, mid(c[0], c[2]).y, R(1,0,2,1), { size:10 }, 'center')); } if (c.length >= 4) { out.push(dashed(c[1], c[3])); out.push(label(mid(c[1], c[3]).x, mid(c[1], c[3]).y, R(2,1,3,2), { size:10 }, 'center')); } if (c.length >= 5) { out.push(dashed(c[2], c[4])); out.push(label(mid(c[2], c[4]).x, mid(c[2], c[4]).y, R(3,2,4,3), { size:10 }, 'center')); out.push(dashed(c[0], c[4])); out.push(label(mid(c[0], c[4]).x, mid(c[0], c[4]).y, R(1,0,4,1), { size:10 }, 'center')); } }
  if (opt.neck && c.length >= 5) { const a = c[2], b = c[4]; out.push(dashed(extend(b, a, bd.width, bd.height), extend(a, b, bd.width, bd.height), { color:RED })); }
  if (opt.converge && c.length >= 3) out.push(dashed(c[0], extend(c[0], c[2], bd.width, bd.height), { color:GREY })); if (opt.converge && c.length >= 4) out.push(dashed(c[1], extend(c[1], c[3], bd.width, bd.height), { color:GREY }));
  c.forEach((p, i) => { const t = labels[i]; if (!t) return; const prev = c[i - 1] || c[i + 1]; const up = prev ? p.y <= prev.y : true; out.push(plain(p.x, p.y + (up ? -8 : 20), t, {}, 'center', 'bottom')); });
  return out; };
def('ms_xabcd', 6, wave(['X','A','B','C','D'], { fills:true, xabcd:true }));
def('ms_elliott', 7, wave(['(0)','(1)','(2)','(3)','(4)','(5)']));
def('ms_abc', 5, wave(['(0)','(A)','(B)','(C)']));
def('ms_hs', 8, wave(['','LS','','Head','','RS',''], { neck:true }));
def('ms_trianglePattern', 5, wave(['A','B','C','D'], { converge:true }));

const position = long => ({ coordinates:c, overlay:o }) => { if (!c.length) return []; const e = c[0]; if (c.length < 2) return []; const tgt = c[1], stp = c[2]; const x0 = e.x, x1 = Math.max(e.x + 140, tgt.x, stp ? stp.x : 0); const ve = val(o,0), vt = val(o,1), vs = stp ? val(o,2) : null; const out = [];
  out.push(poly([{ x:x0, y:e.y }, { x:x1, y:e.y }, { x:x1, y:tgt.y }, { x:x0, y:tgt.y }], { color:'rgba(38,166,154,.18)' })); out.push(line({ x:x0, y:tgt.y }, { x:x1, y:tgt.y }, { color:GREEN, size:1 }));
  if (stp) { out.push(poly([{ x:x0, y:e.y }, { x:x1, y:e.y }, { x:x1, y:stp.y }, { x:x0, y:stp.y }], { color:'rgba(239,83,80,.18)' })); out.push(line({ x:x0, y:stp.y }, { x:x1, y:stp.y }, { color:RED, size:1 })); }
  out.push(line({ x:x0, y:e.y }, { x:x1, y:e.y }, { color:GREY, size:1 }));
  const gain = Math.abs(vt - ve) / ve * 100, risk = vs != null ? Math.abs(vs - ve) / ve * 100 : 0; const wrong = long ? vt < ve : vt > ve;
  out.push(label((x0 + x1) / 2, tgt.y + (tgt.y < e.y ? -12 : 12), `Target ${price(vt)}  ${wrong ? '⚠ ' : ''}${long ? '+' : '+'}${gain.toFixed(1)}%`, { backgroundColor:GREEN, color:'#04140E' }, 'center'));
  if (stp) out.push(label((x0 + x1) / 2, stp.y + (stp.y > e.y ? 12 : -12), `Stop ${price(vs)}  −${risk.toFixed(1)}%`, { backgroundColor:RED }, 'center'));
  out.push(label((x0 + x1) / 2, e.y, `${long ? 'LONG' : 'SHORT'} ${price(ve)}${risk ? '  ·  R:R ' + (gain / risk).toFixed(2) : ''}`, { backgroundColor:'#2A2E39' }, 'center')); return out; };
def('ms_long', 4, position(true)); def('ms_short', 4, position(false));

const measure = (mode) => ({ coordinates:c, overlay:o }) => { if (c.length < 2) return []; const [a, b] = c, up = val(o,1) >= val(o,0), col = up ? BLUE : RED, fill = up ? 'rgba(41,98,255,.12)' : 'rgba(239,83,80,.12)', out = [];
  out.push(poly([a, { x:b.x, y:a.y }, b, { x:a.x, y:b.y }], { color:fill })); const m = mid(a, b), bits = [];
  if (mode !== 'date') { out.push(line({ x:m.x, y:a.y }, { x:m.x, y:b.y }, { color:col })); const s = b.y < a.y ? 1 : -1; out.push(poly([{ x:m.x, y:b.y }, { x:m.x - 5, y:b.y + 9 * s }, { x:m.x + 5, y:b.y + 9 * s }], { color:col })); bits.push(`${price(val(o,0))} → ${price(val(o,1))}  (${pctTxt(val(o,0), val(o,1))})`); }
  if (mode !== 'price') { out.push(line({ x:a.x, y:m.y }, { x:b.x, y:m.y }, { color:col })); const s = b.x > a.x ? 1 : -1; out.push(poly([{ x:b.x, y:m.y }, { x:b.x - 9 * s, y:m.y - 5 }, { x:b.x - 9 * s, y:m.y + 5 }], { color:col })); const t = Math.abs((o.points[1].timestamp || 0) - (o.points[0].timestamp || 0)), bars = barsOf(t); bits.push(`${bars} bars${t ? ', ' + dur(t) : ''}`); }
  out.push(label(m.x, Math.max(a.y, b.y) + 16, bits.join('  ·  '), { backgroundColor:col }, 'center')); return out; };
def('ms_priceRange', 3, measure('price')); def('ms_dateRange', 3, measure('date')); def('ms_datePrice', 3, measure('both'));

// ---------- catalogue (what the toolbar shows) ----------
const I = p => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.500" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const dot = (x, y) => `<circle cx="${x}" cy="${y}" r="1.700" fill="var(--bg,#0C0E12)"/>`;
export const CATALOG = [
  { id:'cursor', label:'Cursors', tools:[
    { id:'cross', label:'Cross', cursor:true, icon:I('<path d="M10 2v16M2 10h16"/>') },
    { id:'dot', label:'Dot', cursor:true, icon:I('<circle cx="10" cy="10" r="2.500" fill="currentColor"/>') },
    { id:'arrowc', label:'Arrow', cursor:true, icon:I('<path d="M5 3l10 8-5 .800L8 17z" fill="currentColor" stroke="none"/>') },
    { id:'eraser', label:'Eraser', cursor:true, icon:I('<path d="M4 13l7-8 5 4.500-6 7H6.500z"/><path d="M8 9.500l4.500 4.500M3 17h14"/>') } ] },
  { id:'lines', label:'Trend line tools', tools:[
    { id:'segment', label:'Trend line', icon:I(`<path d="M4 15L16 5"/>${dot(4,15)}${dot(16,5)}`) },
    { id:'rayLine', label:'Ray', icon:I(`<path d="M4 15L18 3.500"/>${dot(4,15)}${dot(11,9.250)}`) },
    { id:'ms_infoLine', label:'Info line', icon:I(`<path d="M3 16L13 8"/><path d="M12 4h6v4h-6z"/>${dot(3,16)}`) },
    { id:'straightLine', label:'Extended line', icon:I(`<path d="M2 16.500L18 3.500"/>${dot(7,12.500)}${dot(13,7.500)}`) },
    { id:'ms_arrow', label:'Arrow', icon:I('<path d="M4 15L16 5M10 5h6v6"/>') },
    { id:'horizontalStraightLine', label:'Horizontal line', icon:I(`<path d="M2 10h16"/>${dot(10,10)}`) },
    { id:'horizontalRayLine', label:'Horizontal ray', icon:I(`<path d="M5 10h13"/>${dot(5,10)}`) },
    { id:'verticalStraightLine', label:'Vertical line', icon:I(`<path d="M10 2v16"/>${dot(10,10)}`) },
    { id:'parallelStraightLine', label:'Parallel channel', icon:I('<path d="M3 12L15 3M5 17L17 8"/>') },
    { id:'priceChannelLine', label:'Price channel', icon:I('<path d="M3 11L15 3M4 14.500L16 6.500M5 18L17 10" /><path d="M4 14.500L16 6.500" stroke-dasharray="2 2"/>') } ] },
  { id:'fib', label:'Gann, Fib & pitchfork', tools:[
    { id:'ms_fib', label:'Fib retracement', icon:I('<path d="M3 4h14M3 8h14M3 11h14M3 16h14"/>') },
    { id:'ms_fibExt', label:'Trend-based fib extension', icon:I('<path d="M3 16l4-8 3 4M10 4h8M10 8h8M10 12h8"/>') },
    { id:'ms_pitchfork', label:'Pitchfork', icon:I('<path d="M3 14l6-4M9 6v8M9 6l9-3M9 10l9-3M9 14l9-3"/>') },
    { id:'ms_schiff', label:'Schiff pitchfork', icon:I('<path d="M3 15l4-5M9 6v8M6 12l12-4M9 6l9-3M9 14l9-3"/>') },
    { id:'ms_gannBox', label:'Gann box', icon:I('<path d="M3 3h14v14H3zM3 10h14M10 3v14M3 17L17 3"/>') } ] },
  { id:'shapes', label:'Geometric shapes', tools:[
    { id:'ms_rect', label:'Rectangle', icon:I('<rect x="3" y="5" width="14" height="10" rx="1"/>') },
    { id:'ms_circle', label:'Circle', icon:I('<circle cx="10" cy="10" r="7"/>') },
    { id:'ms_triangle', label:'Triangle', icon:I('<path d="M10 3l7 13H3z"/>') },
    { id:'ms_parallelogram', label:'Parallelogram', icon:I('<path d="M6 5h12l-4 10H2z"/>') } ] },
  { id:'notes', label:'Annotation tools', tools:[
    { id:'ms_text', label:'Text', ask:'Text', icon:I('<path d="M4 5h12M10 5v11"/>') },
    { id:'ms_callout', label:'Callout', ask:'Note', icon:I('<path d="M6 4h11v8H11l-4 4v-4H6z"/>') },
    { id:'ms_priceNote', label:'Price note', ask:'Label (optional)', optional:true, icon:I('<path d="M3 10h4M8 6h9v8H8z"/>') },
    { id:'ms_arrowUp', label:'Arrow marker up', ask:'Label (optional)', optional:true, icon:I('<path d="M10 3l5 6h-3v8H8V9H5z"/>') },
    { id:'ms_arrowDown', label:'Arrow marker down', ask:'Label (optional)', optional:true, icon:I('<path d="M10 17l5-6h-3V3H8v8H5z"/>') },
    { id:'ms_flag', label:'Flag', icon:I('<path d="M5 17V3l10 3.500L5 10"/>') } ] },
  { id:'patterns', label:'Patterns', tools:[
    { id:'ms_xabcd', label:'XABCD pattern', icon:I('<path d="M2 15l4-10 4 7 3-5 5 8"/>') },
    { id:'ms_hs', label:'Head and shoulders', icon:I('<path d="M2 16l3-6 2 4 3-10 3 10 2-4 3 6"/>') },
    { id:'ms_elliott', label:'Elliott impulse wave (12345)', icon:I('<path d="M2 16l3-7 3 4 4-9 3 5 3-5"/>') },
    { id:'ms_abc', label:'Elliott correction (ABC)', icon:I('<path d="M3 5l5 9 4-5 5 8"/>') },
    { id:'ms_trianglePattern', label:'Triangle pattern', icon:I('<path d="M3 4l4 11 4-8 4 5"/><path d="M3 4l15 6M7 15l11-3" stroke-dasharray="2 2"/>') } ] },
  { id:'measure', label:'Prediction & measurement', tools:[
    { id:'ms_long', label:'Long position', icon:I('<rect x="3" y="3" width="14" height="7" fill="rgba(38,166,154,.35)" stroke="#26A69A"/><rect x="3" y="10" width="14" height="5" fill="rgba(239,83,80,.35)" stroke="#EF5350"/>') },
    { id:'ms_short', label:'Short position', icon:I('<rect x="3" y="3" width="14" height="5" fill="rgba(239,83,80,.35)" stroke="#EF5350"/><rect x="3" y="8" width="14" height="7" fill="rgba(38,166,154,.35)" stroke="#26A69A"/>') },
    { id:'ms_priceRange', label:'Price range', icon:I('<path d="M10 3v14M7 6l3-3 3 3M7 14l3 3 3-3"/>') },
    { id:'ms_dateRange', label:'Date range', icon:I('<path d="M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3"/>') },
    { id:'ms_datePrice', label:'Date & price range', icon:I('<path d="M4 16L16 4M16 9V4h-5M3 3v14h14"/>') } ] },
];
const ALL = Object.fromEntries(CATALOG.flatMap(c => c.tools.map(t => [t.id, { ...t, cat:c.id }])));
const HELP = { 2:'Click the chart to place it', 3:'Click two points', 4:'Click three points' };

// ---------- engine ----------
let registered = false;
function register(){ if (registered || !window.klinecharts) return; registered = true; for (const t of T) { try { window.klinecharts.registerOverlay(t); } catch (e) { console.warn('[draw] register', t.name, e); } } }
const chart = () => H?.chart?.();

function events(){ return {
  onDrawEnd: e => { progressId = null; active = null; ids.add(e.overlay.id); queueSave(); paint(); return false; },
  onPressedMoveEnd: () => { queueSave(); return false; },
  onSelected: e => { selectedId = e.overlay.id; paint(); return false; },
  onDeselected: e => { if (selectedId === e.overlay.id) { selectedId = null; paint(); } return false; },
  onClick: e => { if (eraser) { remove(e.overlay.id); return true; } return false; },
  onDoubleClick: e => { const spec = ALL[e.overlay.name]; if (spec?.ask) { const t = prompt(spec.ask, e.overlay.extendData?.text || ''); if (t != null) { chart().overrideOverlay({ id:e.overlay.id, extendData:{ ...(e.overlay.extendData||{}), text:t } }); queueSave(); } return true; } return false; },
  onRightClick: e => { window.__msSkipChartMenu = Date.now(); remove(e.overlay.id); return true; },
  onRemoved: e => { ids.delete(e.overlay.id); if (selectedId === e.overlay.id) selectedId = null; if (progressId === e.overlay.id) { progressId = null; active = null; } if (!restoring) queueSave(); paint(); return false; },
}; }

export function useTool(id){
  const c = chart(); const spec = ALL[id]; if (!spec) return;
  lastByCat[spec.cat] = id;
  cancelProgress();
  if (spec.cursor) { eraser = id === 'eraser'; if (!eraser) cursor = id; active = null; applyCursor(); paint(); if (eraser) H.toast('Eraser: click a drawing to delete it'); return; }
  if (!c) return; eraser = false; applyCursor();
  let extendData; if (spec.ask) { const t = prompt(spec.ask, ''); if (t == null) return paint(); if (!t && !spec.optional) return paint(); extendData = { text:t }; }
  register();
  const made = c.createOverlay({ name:id, groupId:GROUP, mode: magnet ? 'weak_magnet' : 'normal', modeSensitivity:10, lock:false, extendData, styles: baseStyles(), ...events() });
  progressId = Array.isArray(made) ? made[0] : made; active = id; paint();
  const steps = T.find(t => t.name === id)?.totalStep || ({ segment:3, rayLine:3, straightLine:3, horizontalStraightLine:2, horizontalRayLine:3, verticalStraightLine:2, parallelStraightLine:4, priceChannelLine:4 }[id]) || 3;
  H.toast(spec.label + ' — ' + (HELP[steps] || `click ${steps - 1} points`) + (matchMedia('(pointer:coarse)').matches ? '' : ' · right-click cancels'));
}
function baseStyles(){ return { line:{ color:BLUE, size:1.5 }, point:{ color:BLUE, borderColor:'rgba(41,98,255,.35)', borderSize:1, radius:4.5, activeColor:BLUE, activeBorderColor:'rgba(41,98,255,.35)', activeBorderSize:3, activeRadius:5 }, polygon:{ color:BLUE_FILL }, text:{ color:'#fff', backgroundColor:BLUE } }; }
function cancelProgress(){ const c = chart(); if (c && progressId) { const id = progressId; progressId = null; try { c.removeOverlay(id); } catch {} } active = null; }
function remove(id){ try { chart()?.removeOverlay(id); } catch {} }
function applyCursor(){ const c = chart(); const el = document.getElementById('kc'); if (!c || !el) return; const lines = cursor === 'cross' && !eraser;
  try { c.setStyles({ crosshair:{ horizontal:{ line:{ show:lines } }, vertical:{ line:{ show:lines } } } }); } catch {}
  el.style.cursor = eraser ? 'cell' : cursor === 'cross' ? 'crosshair' : cursor === 'dot' ? "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Ccircle cx='8' cy='8' r='3' fill='%23E4E6EB'/%3E%3C/svg%3E\") 8 8, crosshair" : 'default'; }

// ---------- persistence (per token, in price units so it survives a different market-cap scale) ----------
const key = () => { const t = H.token(); return t ? 'ms_draw_' + t.addr : null; };
function queueSave(){ if (restoring) return; clearTimeout(saveT); saveT = setTimeout(saveNow, 250); }
function saveNow(){ const c = chart(), k = key(); if (!c || !k) return; const s = H.supply() || 1; const list = [];
  for (const id of ids) { const o = c.getOverlayById(id); if (!o) continue; list.push({ name:o.name, points:o.points.map(p => ({ timestamp:p.timestamp, price:p.value / s })), extendData:o.extendData, lock:o.lock }); }
  try { if (list.length) localStorage.setItem(k, JSON.stringify(list)); else localStorage.removeItem(k); } catch {} H.onChange?.(list.length); }
/** call after the chart has data for the current token (token or timeframe changed) */
export function restore(){ const c = chart(), k = key(); if (!c || !k) return; register(); restoring = true; progressId = null; active = null; selectedId = null;
  try { c.removeOverlay({ groupId:GROUP }); } catch {} ids = new Set();
  let list = []; try { list = JSON.parse(localStorage.getItem(k) || '[]'); } catch {}
  const s = H.supply() || 1;
  for (const d of list) { try { const id = c.createOverlay({ name:d.name, groupId:GROUP, points:d.points.map(p => ({ timestamp:p.timestamp, value:p.price * s })), extendData:d.extendData, lock: lockedAll || !!d.lock, visible: !hiddenAll, styles: baseStyles(), ...events() }); if (id) ids.add(Array.isArray(id) ? id[0] : id); } catch (e) { console.warn('[draw] restore', d.name, e); } }
  restoring = false; applyCursor(); paint(); }
export function clearAll(){ const c = chart(); if (!c) return; cancelProgress(); restoring = true; try { c.removeOverlay({ groupId:GROUP }); } catch {} ids = new Set(); restoring = false; selectedId = null; const k = key(); if (k) try { localStorage.removeItem(k); } catch {} paint(); }
export const count = () => ids.size;
if (typeof window !== 'undefined') window.__msDraw = { ids: () => [...ids], progress: () => progressId, chart: () => chart() };

// ---------- toolbar ----------
export function init(hooks){ H = hooks; register(); document.addEventListener('keydown', e => { if (/input|textarea|select/i.test(e.target.tagName)) return; if (e.key === 'Escape') { cancelProgress(); eraser = false; applyCursor(); closeFly(); paint(); } if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { remove(selectedId); } });
  document.addEventListener('pointerdown', e => { if (mounted && !e.target.closest('.dt-cat,.dt-fly')) closeFly(); }); }
let openCat = null;
function closeFly(){ if (openCat) { openCat = null; paint(); } }
export function mount(el){ mounted = el; el.classList.add('dt'); el.onclick = e => {
    const tool = e.target.closest('[data-tool]'); if (tool) { openCat = null; useTool(tool.dataset.tool); return; }
    const more = e.target.closest('[data-more]'); if (more) { openCat = openCat === more.dataset.more ? null : more.dataset.more; paint(); return; }
    const cat = e.target.closest('[data-cat]'); if (cat) { const c = CATALOG.find(x => x.id === cat.dataset.cat); const last = lastByCat[c.id]; if (last && openCat !== c.id && active !== last) { openCat = null; useTool(last); } else { openCat = openCat === c.id ? null : c.id; paint(); } return; }
    const act = e.target.closest('[data-act]'); if (!act) return; const c = chart(); const a = act.dataset.act;
    if (a === 'magnet') { magnet = !magnet; H.toast(magnet ? 'Magnet on — points snap to candle prices' : 'Magnet off'); }
    if (a === 'lock') { lockedAll = !lockedAll; for (const id of ids) try { c.overrideOverlay({ id, lock:lockedAll }); } catch {} H.toast(lockedAll ? 'Drawings locked' : 'Drawings unlocked'); queueSave(); }
    if (a === 'hide') { hiddenAll = !hiddenAll; for (const id of ids) try { c.overrideOverlay({ id, visible:!hiddenAll }); } catch {} H.toast(hiddenAll ? 'Drawings hidden' : 'Drawings shown'); }
    if (a === 'del') { if (selectedId) remove(selectedId); else H.toast('Tap a drawing first, then delete'); }
    if (a === 'clear') { if (!ids.size) H.toast('No drawings on this chart'); else if (confirm('Remove all ' + ids.size + ' drawings from this chart?')) { clearAll(); H.toast('Drawings cleared'); } }
    paint(); }; paint(); }
function paint(){ const el = mounted; if (!el || !el.isConnected) return; const cur = eraser ? 'eraser' : cursor === 'arrow' ? 'arrowc' : cursor;
  el.innerHTML = CATALOG.map(c => { const shownId = c.id === 'cursor' ? (cur === 'arrow' ? 'arrowc' : cur) : (lastByCat[c.id] || c.tools[0].id); const shown = ALL[shownId] || c.tools[0]; const on = c.id === 'cursor' ? (!active) : (active && ALL[active]?.cat === c.id);
    return `<div class="dt-cat ${on ? 'on' : ''} ${openCat === c.id ? 'open' : ''}"><button type="button" class="dt-btn" data-cat="${c.id}" title="${c.label}: ${shown.label}" aria-label="${c.label}">${shown.icon}</button><button type="button" class="dt-more" data-more="${c.id}" aria-label="More ${c.label}" aria-expanded="${openCat === c.id}"></button>
      ${openCat === c.id ? `<div class="dt-fly" role="menu"><div class="dt-fly-h">${c.label}</div>${c.tools.map(t => `<button type="button" role="menuitem" data-tool="${t.id}" class="${(active === t.id || (c.id === 'cursor' && cur === t.id)) ? 'on' : ''}">${t.icon}<span>${t.label}</span></button>`).join('')}</div>` : ''}</div>`; }).join('')
    + `<div class="dt-sep"></div>`
    + [['magnet', 'Magnet — snap to candle prices', magnet, I('<path d="M5 3v7a5 5 0 0 0 10 0V3h-3v7a2 2 0 0 1-4 0V3zM5 6h3M12 6h3"/>')],
       ['lock', lockedAll ? 'Unlock all drawings' : 'Lock all drawings', lockedAll, I('<rect x="4" y="9" width="12" height="8" rx="1.500"/><path d="M7 9V6.500a3 3 0 0 1 6 0V9"/>')],
       ['hide', hiddenAll ? 'Show all drawings' : 'Hide all drawings', hiddenAll, I('<path d="M2 10s3-5.500 8-5.500S18 10 18 10s-3 5.500-8 5.500S2 10 2 10z"/><circle cx="10" cy="10" r="2.200"/>' + (hiddenAll ? '<path d="M3 17L17 3"/>' : ''))],
       ['del', 'Delete selected drawing (Del)', false, I('<path d="M4 6h12M8 6V4h4v2M6 6l.800 11h6.400L14 6"/>'), !selectedId],
       ['clear', 'Remove all drawings', false, I('<path d="M4 6h12M8 6V4h4v2M6 6l.800 11h6.400L14 6M9 9v5M11 9v5"/>') + `<i class="dt-n">${ids.size || ''}</i>`]]
      .map(([a, title, on, icon, dim]) => `<button type="button" class="dt-btn dt-act ${on ? 'on' : ''} ${dim ? 'dim' : ''}" data-act="${a}" title="${title}" aria-label="${title}" aria-pressed="${!!on}">${icon}</button>`).join(''); }
