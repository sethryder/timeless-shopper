import { seedsOf, inRadius, distances, pathCost, rank, tradeLinks, parseJewel, similarSeeds } from './search.js';
import { inflate, lookup } from './lut.js';
import { parseTree, ACCOUNT } from './importer.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return parent ? parent.appendChild(e) : e;
};
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

const data = await fetch('data.json').then((r) => r.json());
const byId = new Map(data.nodes.map((n) => [n.id, n]));
const jewels = data.jewels;
const luts = new Map(); // jewel type -> Promise<Uint8Array>, loaded on first use
const lutFor = (j) => {
  if (!luts.has(j.type)) {
    const p = fetch(j.lut).then((r) => { if (!r.ok) throw new Error(`server answered ${r.status}`); return r.arrayBuffer(); }).then(inflate);
    p.catch(() => luts.delete(j.type)); // a failed download is retried on the next socket click
    luts.set(j.type, p);
  }
  return luts.get(j.type);
};

const s = {
  jewel: jewels.find((j) => j.name === 'Elegant Hubris'),
  conq: 'Caspiro',
  socket: null,
  own: new Set(), // imported tree: allocated node ids (incl. class start)
  marks: new Map(), // node id -> 'taken' | 'accept'
  wanted: [],
  search: null, // { nodes, keystones, raw, seeds } for current jewel + socket
  results: [],
  selected: null,
  pinned: null, // a seed the user pasted in to look at, shown on the tree even if it doesn't match
  keys: null, // Set of the pinned seed's notables that make it valuable (for 'similar'); null = default to wanted
  similar: [],
  prices: new Map(), // `${statId}|${league}|${seed}` -> { text, whisper, account } | { none } | { unknown }
};
const priceKey = (seed) => `${s.jewel.conquerors[s.conq].trade}|${$('league').value}|${seed}`;


// --- tree ---
const svg = $('tree');
const xs = data.nodes.map((n) => n.x), ys = data.nodes.map((n) => n.y);
const overview = `${Math.min(...xs) - 300} ${Math.min(...ys) - 300} ${Math.max(...xs) - Math.min(...xs) + 600} ${Math.max(...ys) - Math.min(...ys) + 600}`;
svg.setAttribute('viewBox', overview);
const full = overview.split(' ').map(Number);
let browse = full; // where the whole-tree view is panned/zoomed to; restored when leaving a socket
const setView = (v) => svg.setAttribute('viewBox', v.join(' '));
const zoomedIn = () => browse[2] < full[2] * 0.99;
const toTree = (e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
const edgeLayer = el('g', {}, svg), circleLayer = el('g', {}, svg), nodeLayer = el('g', {}, svg), labelLayer = el('g', {}, svg);
const edgeEls = [];
for (const n of data.nodes) for (const e of n.edges) if (n.id < e) {
  const m = byId.get(e);
  edgeEls.push([n.id, e, el('line', { class: 'edge', x1: n.x, y1: n.y, x2: m.x, y2: m.y }, edgeLayer)]);
}
const nodeEls = new Map();
const size = { s: 26, n: 44, k: 60, j: 110, c: 60 };
for (const n of data.nodes) {
  const c = el('circle', { class: `node ${n.kind}`, cx: n.x, cy: n.y, r: size[n.kind], 'data-id': n.id }, nodeLayer);
  nodeEls.set(n.id, c);
}

const renderOwn = () => {
  for (const [id, c] of nodeEls) c.classList.toggle('own', s.own.has(id));
  for (const [a, b, line] of edgeEls) line.classList.toggle('own', s.own.has(a) && s.own.has(b));
};

// Whole-tree view: wheel zooms toward the cursor, drag pans. Locked once a socket is picked.
svg.addEventListener('wheel', (e) => {
  if (svg.classList.contains('zoomed')) return;
  e.preventDefault();
  const p = toTree(e), [x, y, w, h] = browse;
  const w2 = Math.min(full[2], Math.max(full[2] / 12, w * Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0015))));
  const k = w2 / w;
  browse = [p.x - (p.x - x) * k, p.y - (p.y - y) * k, w2, h * k];
  if (!zoomedIn()) browse = full;
  setView(browse);
  $('back').hidden = !zoomedIn();
}, { passive: false });
// One finger / mouse pans, two fingers pinch-zoom (and pan with their midpoint). Re-anchored whenever a finger
// lands or lifts. With the view's aspect fixed, screen->tree is linear, so the point under the fingers stays put:
// newOrigin = T0(startMid) - k * (T0(mid) - origin0), k = startSpread / spread.
const pointers = new Map(); // pointerId -> { x, y }
let gesture = null, dragged = false;
const centroid = () => { const ps = [...pointers.values()]; return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length }; };
const spread = () => { const [a, b] = [...pointers.values()]; return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
const anchor = () => {
  gesture = pointers.size ? { view: browse, inv: svg.getScreenCTM().inverse(), mid: centroid(), spread: spread(), moved: false } : null;
};
const T0 = (p) => new DOMPoint(p.x, p.y).matrixTransform(gesture.inv);
svg.addEventListener('pointerdown', (e) => {
  if (svg.classList.contains('zoomed') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) dragged = false;
  anchor();
});
svg.addEventListener('pointermove', (e) => {
  if (!gesture || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const mid = centroid(), pinching = pointers.size > 1 && gesture.spread > 0;
  if (!gesture.moved) {
    if (!pinching && (Math.hypot(mid.x - gesture.mid.x, mid.y - gesture.mid.y) < 5 || !zoomedIn())) return; // a click, or nothing to pan
    gesture.moved = dragged = true;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  }
  const [x0, y0, w0, h0] = gesture.view;
  const w = pinching ? Math.min(full[2], Math.max(full[2] / 12, (w0 * gesture.spread) / spread())) : w0;
  const k = w / w0, start = T0(gesture.mid), now = T0(mid);
  browse = [start.x - k * (now.x - x0), start.y - k * (now.y - y0), w, h0 * k];
  setView(browse);
  $('back').hidden = !zoomedIn();
});
const lift = (e) => {
  if (!pointers.delete(e.pointerId)) return;
  if (!pointers.size) { svg.classList.remove('panning'); if (!zoomedIn()) setView(browse = full); }
  anchor();
};
svg.addEventListener('pointerup', lift);
svg.addEventListener('pointercancel', lift);

svg.addEventListener('click', (ev) => {
  if (dragged) { dragged = false; return; } // end of a pan, not a click
  const n = byId.get(Number(ev.target.dataset?.id));
  if (!n) return;
  if (n.kind === 'j') return pickSocket(n);
  if (!s.socket || !s.inRadius.has(n.id)) return;
  const next = { undefined: 'taken', taken: 'accept', accept: undefined }[s.marks.get(n.id)];
  next ? s.marks.set(n.id, next) : s.marks.delete(n.id);
  update();
});
$('back').onclick = () => {
  // From a socket: back to where you were browsing. From a zoomed whole tree: all the way out.
  if (svg.classList.contains('zoomed')) leaveSocket();
  else browse = full;
  setView(browse);
  $('back').hidden = !zoomedIn();
  $('back').textContent = 'Whole tree';
};

function leaveSocket() {
  svg.classList.remove('zoomed');
  s.socket = s.search = null;
  s.inRadius = new Set();
  s.marks.clear();
  s.selected = null;
  s.results = s.similar = [];
  circleLayer.replaceChildren();
  labelLayer.replaceChildren();
  for (const c of nodeEls.values()) c.classList.remove('sel', 'in', 'taken', 'accept', 'hit');
  for (const [, , line] of edgeEls) line.classList.remove('in');
  $('legend').hidden = true;
  $('emptyTree').hidden = false;
  $('results').replaceChildren();
  $('links').replaceChildren();
  $('priceBtn').hidden = true;
  update();
}

function pickSocket(n) {
  s.socket = n;
  s.marks.clear();
  s.keys = null; // picked from the old ring's notables
  const R = data.radius * 1.1;
  svg.setAttribute('viewBox', `${n.x - R} ${n.y - R} ${2 * R} ${2 * R}`);
  $('back').hidden = false;
  $('back').textContent = 'Pick another socket';
  $('emptyTree').hidden = true;
  $('legend').hidden = false;
  svg.classList.add('zoomed');
  // The jewel's reach, drawn as an astrolabe ring: inner edge is the real radius, ticks every 3°.
  circleLayer.replaceChildren();
  const r = data.radius, ticks = [];
  for (let i = 0; i < 120; i++) {
    const a = (i * Math.PI) / 60, len = i % 10 ? 28 : 70;
    ticks.push(`M${n.x + Math.sin(a) * (r + 16)} ${n.y - Math.cos(a) * (r + 16)}L${n.x + Math.sin(a) * (r + 16 + len)} ${n.y - Math.cos(a) * (r + 16 + len)}`);
  }
  el('circle', { class: 'ring', cx: n.x, cy: n.y, r }, circleLayer);
  el('path', { class: 'ticks', d: ticks.join('') }, circleLayer);
  el('circle', { class: 'ring-outer', cx: n.x, cy: n.y, r: r + 86 }, circleLayer);
  runSearch();
}

// --- tree import: PoB code / build link / tree link, or a public character by account name ---
const api = async (url) => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.retryAfter ? `${body.error}. Try again in ${body.retryAfter}s` : body.error ?? `server answered ${res.status}`);
  return body;
};
function setOwn(classId, nodes, msg) {
  const start = data.nodes.find((n) => n.kind === 'c' && n.cls === classId);
  s.own = new Set([...nodes.filter((id) => byId.has(id)), ...(start ? [start.id] : [])]);
  $('importStatus').textContent = `${msg}: ${s.own.size} nodes. Distances now count from your tree.`;
  $('clearImport').hidden = false;
  renderOwn();
  update();
}
async function importTree(text) {
  text = text.trim();
  if (ACCOUNT.test(text)) return listCharacters(text);
  $('charSel').hidden = true;
  try {
    const { classId, nodes } = await parseTree(text, inflate);
    store('tree', text);
    store('char', '');
    setOwn(classId, nodes, 'Imported');
  } catch (e) {
    $('importStatus').textContent = `Couldn't read that: ${e.message}`;
  }
}
async function listCharacters(account, pick) {
  $('importStatus').textContent = `Looking up ${account}…`;
  try {
    const chars = await api(`api/characters?account=${encodeURIComponent(account)}`);
    if (!chars.length) throw new Error('no characters on that account');
    const sel = $('charSel');
    sel.replaceChildren(new Option('Pick a character', ''), ...chars.map((c) => new Option(`${c.name} (level ${c.level} ${c.class}, ${c.league})`, c.name)));
    sel.dataset.account = account;
    sel.hidden = false;
    if (pick && chars.some((c) => c.name === pick)) { sel.value = pick; return loadCharacter(account, pick); }
    $('importStatus').textContent = `${chars.length} characters. Pick one to use its tree.`;
    sel.focus();
  } catch (e) {
    $('charSel').hidden = true;
    $('importStatus').textContent = /private/.test(e.message)
      ? `${e.message}. Make your Characters tab public in your pathofexile.com privacy settings, or paste a PoB code instead.`
      : `Couldn't look up ${account}: ${e.message}`;
  }
}
async function loadCharacter(account, name) {
  $('importStatus').textContent = `Loading ${name}…`;
  try {
    const { classId, nodes } = await api(`api/character?account=${encodeURIComponent(account)}&name=${encodeURIComponent(name)}`);
    store('char', JSON.stringify({ account, name }));
    store('tree', '');
    setOwn(classId, nodes, name);
  } catch (e) {
    $('importStatus').textContent = `Couldn't load ${name}: ${e.message}`;
  }
}
$('charSel').onchange = () => $('charSel').value && loadCharacter($('charSel').dataset.account, $('charSel').value);
$('importBtn').onclick = () => $('tree-in').value.trim() && importTree($('tree-in').value);
$('tree-in').onkeydown = (e) => { if (e.key === 'Enter' && $('tree-in').value.trim()) importTree($('tree-in').value); };
$('clearImport').onclick = () => {
  s.own = new Set();
  $('tree-in').value = $('importStatus').textContent = '';
  $('clearImport').hidden = $('charSel').hidden = true;
  store('tree', '');
  store('char', '');
  renderOwn();
  update();
};

// --- controls ---
function fillJewel() {
  $('conq').replaceChildren(...Object.entries(s.jewel.conquerors).map(([c, { keystone }]) => new Option(`${c} — ${keystone}`, c, false, c === s.conq)));
  s.conq = $('conq').value;
  s.picks = s.jewel.notables.map((name) => {
    const st = data.stats?.[data.names.indexOf(name)]?.join(' / ') ?? '';
    return { name, stats: st === name ? '' : st, hay: `${name} ${st}`.toLowerCase() };
  });
}
$('jewel').replaceChildren(...jewels.map((j) => new Option(j.name, j.name, false, j === s.jewel)));
$('jewel').onchange = () => { s.jewel = jewels.find((j) => j.name === $('jewel').value); s.wanted = []; s.pinned = null; fillJewel(); renderWanted(); runSearch(); };
$('conq').onchange = () => { s.conq = $('conq').value; update(); }; // conqueror only changes the keystone, not notables
// ponytail: typing re-ranks after a pause (rank() can take ~0.4 s); make rank cheaper if clicks start to feel slow too.
let updateTimer;
const updateSoon = () => { clearTimeout(updateTimer); updateTimer = setTimeout(update, 200); };
$('maxDist').oninput = () => { renderWanted(); updateSoon(); };
$('league').onchange = () => { store('league', $('league').value); update(); };

// Check one specific jewel: switch to its jewel/conqueror and show that seed.
const showJewel = () => {
  const text = $('jewelIn').value.trim();
  if (!text) return;
  let found;
  try { found = parseJewel(text, jewels, s.jewel, s.conq); } catch (e) { $('jewelStatus').textContent = `Couldn't find a seed: ${e.message}.`; return; }
  const switched = found.jewel !== s.jewel;
  if (switched) { s.jewel = found.jewel; $('jewel').value = found.jewel.name; s.wanted = []; fillJewel(); renderWanted(); }
  s.conq = found.conq;
  $('conq').value = found.conq;
  s.pinned = found.seed;
  s.keys = null;
  $('jewelStatus').textContent = '';
  $('jewelIn').value = '';
  switched ? runSearch() : (s.selected = null, update());
};
$('jewelBtn').onclick = showJewel;
$('jewelIn').onkeydown = (e) => { if (e.key === 'Enter') showJewel(); };

// Own suggestion list (not <datalist>): matches anywhere in name or stats, and works in every browser.
let hl = 0;
const matches = () => {
  const words = $('add').value.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? s.picks.filter((p) => !s.wanted.some((w) => w.name === p.name) && words.every((w) => p.hay.includes(w))).slice(0, 40) : [];
};
const renderSuggest = () => {
  const m = matches();
  hl = Math.min(hl, Math.max(0, m.length - 1));
  $('suggest').replaceChildren(...m.map((p, i) => {
    const d = document.createElement('div');
    d.className = i === hl ? 'hl' : '';
    d.setAttribute('role', 'option');
    d.innerHTML = '<b></b><span></span>';
    d.firstChild.textContent = p.name;
    d.lastChild.textContent = p.stats;
    d.onmousedown = (e) => { e.preventDefault(); addWanted(p.name); };
    return d;
  }));
  $('suggest').hidden = !m.length;
  $('add').setAttribute('aria-expanded', String(!!m.length));
};
const addWanted = (name = matches()[hl]?.name) => {
  if (!name || !s.jewel.notables.includes(name) || s.wanted.some((w) => w.name === name)) return;
  s.wanted.push({ name, weight: 1, max: null, must: s.wanted.length === 0 });
  $('add').value = '';
  hl = 0;
  renderSuggest();
  renderWanted();
  update();
};
$('addBtn').onclick = () => addWanted();
$('add').oninput = () => { hl = 0; renderSuggest(); };
$('add').onfocus = renderSuggest;
$('add').onblur = () => ($('suggest').hidden = true);
$('add').onkeydown = (e) => { // don't return false from here: that swallows every keypress
  if (e.key === 'Enter') addWanted();
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    hl = Math.max(0, Math.min(matches().length - 1, hl + (e.key === 'ArrowDown' ? 1 : -1)));
    renderSuggest();
    $('suggest').querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Escape') $('suggest').hidden = true;
};

function renderWanted() {
  const fallback = $('maxDist').value;
  $('wanted').replaceChildren(...s.wanted.map((w) => {
    const card = document.createElement('div');
    card.className = 'want';
    card.innerHTML = `<div class="want-head"><span class="want-name"></span><button class="icon-btn" title="Remove">×</button></div>
      <div class="want-stats"></div>
      <div class="want-opts">
        <label title="How much a hit counts toward the score">Weight <input type="number" min="0" step="1"></label>
        <label title="Furthest this notable can be. Blank uses the max below.">Max pts <input type="number" min="0" step="1"></label>
        <label><input type="checkbox"> Must have</label>
      </div>`;
    card.querySelector('.want-name').textContent = w.name;
    card.querySelector('.want-stats').textContent = s.picks.find((p) => p.name === w.name)?.stats ?? '';
    const del = card.querySelector('button');
    del.setAttribute('aria-label', `Remove ${w.name}`);
    del.onclick = () => { s.wanted.splice(s.wanted.indexOf(w), 1); renderWanted(); update(); };
    const [weight, maxIn, must] = card.querySelectorAll('input');
    weight.value = w.weight;
    weight.oninput = () => { w.weight = Number(weight.value) || 0; updateSoon(); };
    maxIn.value = w.max ?? '';
    maxIn.placeholder = fallback || 'any';
    maxIn.oninput = () => { w.max = maxIn.value === '' ? null : Number(maxIn.value); updateSoon(); };
    must.checked = w.must;
    must.onchange = () => { w.must = must.checked; update(); };
    return card;
  }));
}

// --- search ---
async function runSearch() {
  s.selected = null;
  if (!s.socket) return update();
  const radiusNodes = inRadius(data.nodes, s.socket, data.radius);
  s.inRadius = new Set(radiusNodes.map((n) => n.id));
  for (const [a, b, line] of edgeEls) line.classList.toggle('in', s.inRadius.has(a) && s.inRadius.has(b));
  const nodes = radiusNodes.filter((n) => n.lut !== undefined);
  const jewel = s.jewel, socket = s.socket;
  s.search = null; // the old one belongs to another jewel or socket
  if (!luts.has(jewel.type)) $('status').textContent = `Loading ${jewel.name} data…`;
  let lut;
  try { lut = await lutFor(jewel); } catch (e) {
    if (jewel === s.jewel && socket === s.socket) $('status').textContent = `Couldn't load ${jewel.name} data (${e.message}). Click the socket to try again.`;
    return;
  }
  if (jewel !== s.jewel || socket !== s.socket) return; // user moved on while loading
  s.search = { nodes, keystones: radiusNodes.filter((n) => n.kind === 'k'), seeds: seedsOf(jewel), raw: lookup(jewel, lut, nodes.map((n) => n.lut)) };
  update();
}

const tradeLink = (seed, text) => {
  const a = Object.assign(document.createElement('a'), {
    className: 'r-trade', href: tradeLinks(s.jewel.conquerors[s.conq].trade, [seed], $('league').value)[0],
    target: '_blank', rel: 'noopener', textContent: text, title: `Open seed ${seed} on the trade site`,
  });
  a.onclick = (e) => e.stopPropagation(); // don't also select the row
  return a;
};
const hitsInto = (el, hits) => {
  const groups = new Map();
  for (const h of hits) groups.set(h.name, [...(groups.get(h.name) ?? []), h.cost]);
  [...groups].forEach(([name, costs], i) => {
    if (i) el.append(', ');
    const b = document.createElement('b');
    b.textContent = costs.length > 1 ? `${name} ×${costs.length}` : name;
    el.append(b, ` ${costs.sort((x, y) => x - y).join(', ')} pts`);
  });
};

function resultRow(r) {
  const li = document.createElement('li');
  li.className = r.seed === s.selected ? 'sel' : '';
  li.tabIndex = 0;
  li.innerHTML = '<div class="r-top"><span class="r-seed"></span><span class="r-pts"></span><span class="r-score"></span><span class="r-price"></span></div><div class="r-hits"></div>';
  li.querySelector('.r-seed').textContent = r.seed;
  li.querySelector('.r-pts').textContent = `${r.cost} pts`;
  li.querySelector('.r-score').textContent = s.wanted.some((w) => w.weight !== 1) ? `score ${r.score}` : '';
  priceCell(li.querySelector('.r-price'), s.prices.get(priceKey(r.seed)));
  li.querySelector('.r-top').append(tradeLink(r.seed, 'Trade'));
  hitsInto(li.querySelector('.r-hits'), r.hits); // grouped: "Slum Lord ×2 5, 6 pts"
  const pick = () => { s.selected = s.selected === r.seed ? null : r.seed; update(); };
  li.onclick = pick;
  li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
  return li;
}

function renderPinned() {
  const card = $('pinned');
  card.hidden = !s.pinned;
  if (!s.pinned) return;
  const r = s.results.find((x) => x.seed === s.pinned);
  card.className = s.search && s.selected === null ? 'sel' : '';
  card.innerHTML = '<div class="r-top"><span class="p-title"></span><span class="r-price"></span><button class="icon-btn" aria-label="Stop showing this jewel" title="Stop showing this jewel">×</button></div><div class="r-hits"></div>';
  card.querySelector('.p-title').append(`${s.jewel.name} ${s.pinned}`, Object.assign(document.createElement('small'), { textContent: s.conq }));
  priceCell(card.querySelector('.r-price'), s.prices.get(priceKey(s.pinned)));
  card.querySelector('.r-top').insertBefore(tradeLink(s.pinned, 'Trade'), card.querySelector('.icon-btn'));
  card.querySelector('.icon-btn').onclick = (e) => { e.stopPropagation(); s.pinned = null; update(); };
  const hits = card.querySelector('.r-hits');
  if (!s.search) hits.textContent = 'Click a jewel socket to see what it does there.';
  else if (r) { hits.append(`${r.cost} pts: `); hitsInto(hits, r.hits); }
  else hits.textContent = s.wanted.length ? 'None of your notables within your limits here. Hover the ring to see what it gives.' : 'Hover the ring to see what it gives.';
  card.onclick = () => { s.selected = null; update(); };
  s.similar = [];
  if (!s.search) return;

  // What this seed puts in the ring, closest first; the user picks which ones make it worth something.
  const { nodes, seeds, raw } = s.search, p = seeds.indexOf(s.pinned), dist = s.lastDist;
  const mine = new Map(); // name -> distances
  nodes.forEach((n, i) => { const name = data.names[raw[p * nodes.length + i]]; mine.set(name, [...(mine.get(name) ?? []), dist.get(n.id) ?? Infinity]); });
  s.keys ??= new Set(s.wanted.map((w) => w.name).filter((name) => mine.has(name)));
  const chips = document.createElement('div');
  chips.className = 'chips';
  chips.append(Object.assign(document.createElement('p'), { className: 'note', textContent: 'Which of these make it valuable? Pick them to find similar jewels.' }));
  for (const [name, ds] of [...mine].sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]))) {
    const c = Object.assign(document.createElement('button'), { className: `chip${s.keys.has(name) ? ' on' : ''}`, title: `${ds.sort((x, y) => x - y).join(', ')} pts away` });
    c.setAttribute('aria-pressed', String(s.keys.has(name)));
    c.append(ds.length > 1 ? `${name} ×${ds.length} ` : `${name} `, Object.assign(document.createElement('small'), { textContent: `${Math.min(...ds)} pts` }));
    c.onclick = (e) => { e.stopPropagation(); s.keys.has(name) ? s.keys.delete(name) : s.keys.add(name); update(); };
    chips.append(c);
  }
  card.append(chips);
  if (!s.keys.size) return;

  s.similar = similarSeeds({ ...s.search, alts: data.names, dist, costOf: s.costOf }, s.pinned, s.keys);
  const sim = document.createElement('div');
  sim.className = 'similar';
  sim.onclick = (e) => e.stopPropagation(); // picking a similar seed shouldn't fall through to the card
  const head = document.createElement('div');
  head.className = 'sim-head';
  const what = [...s.keys].map((k) => (mine.get(k).length > 1 ? `${k} ×${mine.get(k).length}` : k)).join(' and ');
  head.append(s.similar.length
    ? `${s.similar.length.toLocaleString()} seeds give ${what} at least as close. `
    : `No other seed gives ${what} this close, so this one is rare here. `);
  const seedsList = s.similar.map((x) => x.seed);
  if (seedsList.length) {
    head.append(Object.assign(document.createElement('a'), { href: tradeLinks(s.jewel.conquerors[s.conq].trade, seedsList, $('league').value)[0], target: '_blank', rel: 'noopener', textContent: seedsList.length > 45 ? 'Open the closest 45 on trade' : 'Open them on trade', onclick: (e) => e.stopPropagation() }));
    const unpriced = seedsList.filter((x) => !s.prices.has(priceKey(x)));
    if (relayOk && unpriced.length) {
      const btn = Object.assign(document.createElement('button'), { className: 'btn', textContent: `Check prices for ${Math.min(32, unpriced.length)}` });
      btn.onclick = (e) => { e.stopPropagation(); priceSeeds(unpriced.slice(0, 32), btn, $('simStatus')); };
      head.append(' ', btn);
    }
  }
  const status = Object.assign(document.createElement('p'), { className: 'note', id: 'simStatus' });
  const list = document.createElement('ol');
  list.className = 'sim-list';
  list.replaceChildren(...s.similar.slice(0, 8).map(resultRow));
  sim.append(head, status, list);
  if (s.similar.length > 8) sim.append(Object.assign(document.createElement('p'), { className: 'note', textContent: `and ${s.similar.length - 8} more on trade.` }));
  card.append(sim);
}

function update() {
  if (!s.search) {
    renderPinned();
    $('status').textContent = '';
    $('emptyResults').textContent = 'Click a blue jewel socket on the tree to start.';
    return;
  }
  const sources = [s.socket.id, ...s.own, ...[...s.marks].filter(([, m]) => m === 'taken').map(([id]) => id)];
  const dist = distances(byId, sources);
  const maxRaw = $('maxDist').value;
  const max = maxRaw === '' ? null : Number(maxRaw);
  const anyAccept = [...s.marks.values()].includes('accept');
  const acceptable = (id, w) => {
    const limit = w.max ?? max; // per-notable max, else the default
    return s.marks.get(id) === 'accept' || (limit === null ? !anyAccept : (dist.get(id) ?? Infinity) <= limit);
  };
  const costOf = (ids) => pathCost(byId, sources, ids);
  s.costOf = costOf;
  s.lastDist = dist;

  s.results = s.wanted.length ? rank({ ...s.search, alts: data.names, wanted: s.wanted, acceptable, dist, costOf }) : [];
  if (s.selected && ![...s.results, ...s.similar].some((r) => r.seed === s.selected)) s.selected = null;
  renderPinned();

  const n = s.results.length;
  $('status').textContent = s.wanted.length ? `${n.toLocaleString()} of ${s.search.seeds.length.toLocaleString()} match` : '';
  $('emptyResults').textContent = !s.wanted.length ? 'Add a notable you want to see which seeds give it here.'
    : !n ? 'No seed puts that within reach of this socket. Try a higher max, or untick Must have.' : '';
  renderLinks();
  const unpriced = s.results.filter((r) => !s.prices.has(priceKey(r.seed))).length;
  $('priceBtn').hidden = !relayOk || !unpriced;
  $('priceBtn').textContent = `Check prices for ${Math.min(32, unpriced)} seeds`;
  $('results').replaceChildren(...s.results.slice(0, 200).map(resultRow));
  renderTree(dist);
}

function renderLinks() {
  const links = tradeLinks(s.jewel.conquerors[s.conq].trade, s.results.map((r) => r.seed), $('league').value || 'Standard').slice(0, 5);
  $('links').replaceChildren(...links.map((href, i) => {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${i ? '' : 'Open on trade: '}seeds ${i * 45 + 1}–${Math.min((i + 1) * 45, s.results.length)}`;
    return a;
  }));
}

function renderTree(dist) {
  s.lastDist = dist;
  const { nodes, seeds, raw } = s.search;
  const shown = s.selected ?? s.pinned; // a picked row wins over the pasted jewel
  const hitIds = new Set([...s.results, ...s.similar].find((r) => r.seed === shown)?.hits.map((h) => h.node.id));
  const seedIdx = shown === null ? -1 : seeds.indexOf(shown);
  for (const [id, c] of nodeEls) {
    c.classList.toggle('sel', id === s.socket.id);
    c.classList.toggle('in', s.inRadius.has(id));
    c.classList.toggle('taken', s.marks.get(id) === 'taken');
    c.classList.toggle('accept', s.marks.get(id) === 'accept');
    c.classList.toggle('hit', hitIds.has(id));
  }
  labelLayer.replaceChildren();
  s.alt = new Map(); // node id -> global id it becomes under the selected seed (or 'ks' for the conqueror keystone)
  const label = (n, name) => {
    el('text', { class: `label${hitIds.has(n.id) ? ' hit' : ''}`, x: n.x, y: n.y - 72 }, labelLayer).textContent = name;
    el('text', { class: 'label dist', x: n.x, y: n.y + 105 }, labelLayer).textContent = `${dist.get(n.id) ?? '∞'} pts`;
  };
  nodes.forEach((n, i) => {
    const alt = seedIdx >= 0 ? raw[seedIdx * nodes.length + i] : -1;
    if (alt >= 0) s.alt.set(n.id, alt);
    // Additions keep the original notable and add a stat; replacements take over the name.
    label(n, alt < 0 ? n.name : alt < data.additions ? `${n.name} + ${data.names[alt]}` : data.names[alt]);
  });
  for (const k of s.search.keystones) { label(k, s.jewel.conquerors[s.conq].keystone); s.alt.set(k.id, 'ks'); }
}

// --- hover tooltip: what a node is, and what the selected seed turns it into ---
const tip = $('tip');
const tipHtml = (n) => {
  const esc = (t) => t.replace(/[&<>]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt' }[c]};`);
  const lines = (arr, cls = '') => arr.flatMap((x) => x.split('\n')).map((x) => `<div class="${cls}">${esc(x)}</div>`).join('');
  let alt = s.alt?.get(n.id);
  if (alt === 'ks') alt = data.names.indexOf(s.jewel.conquerors[s.conq].keystone);
  const d = s.lastDist?.get(n.id);
  const pts = d === undefined ? '' : `<div class="pts">${d} pts away</div>`;
  if (alt === undefined || alt < 0) return `<b>${esc(n.name)}</b>${lines(n.stats)}${pts}`;
  if (alt < data.additions) return `<b>${esc(n.name)}</b>${lines(n.stats)}${lines(data.stats[alt], 'add')}${pts}`;
  return `<b class="new">${esc(data.names[alt])}</b>${lines(data.stats[alt])}<div class="was">replaces ${esc(n.name)}</div>${pts}`;
};
nodeLayer.addEventListener('mousemove', (e) => {
  const n = byId.get(Number(e.target.dataset?.id));
  if (!n) return (tip.hidden = true);
  tip.innerHTML = tipHtml(n);
  tip.hidden = false;
  const r = tip.parentElement.getBoundingClientRect();
  const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 4), y = e.clientY - r.top + 14;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${y + tip.offsetHeight > r.height ? e.clientY - r.top - tip.offsetHeight - 10 : y}px`;
});
nodeLayer.addEventListener('mouseleave', () => (tip.hidden = true));

// --- live prices (needs serve.mjs; hidden on a plain static host) ---
let relayOk = false;
const loadLeagues = (tries = 5) => fetch('api/leagues').then(async (r) => {
  if (r.status === 404) return; // plain static host: no relay
  if (!r.ok) throw new Error(`relay answered ${r.status}`);
  const leagues = await r.json();
  relayOk = true;
  $('priceStatus').textContent = '';
  if (!leagues.length) return;
  $('league').replaceChildren(...leagues.map((l) => new Option(l)));
  $('league').value = leagues.includes(load('league')) ? load('league') : leagues[0]; // current challenge league first
  update();
}).catch(() => {
  // Relay there but GGG's league list didn't come through: links would quietly point at Standard, so say so and retry.
  $('priceStatus').textContent = `Couldn't load the league list${tries > 1 ? ', retrying' : ''}. Trade links use the league picked above.`;
  if (tries > 1) setTimeout(() => loadLeagues(tries - 1), 30_000);
});
loadLeagues();

function priceCell(el, p) {
  if (!p) return;
  if (p.none) { el.innerHTML = '<span class="none">not listed</span>'; return; }
  if (p.unknown) { el.innerHTML = '<span class="none" title="More listings than were fetched. Open the trade search to see them.">maybe listed</span>'; return; }
  el.textContent = p.text;
  el.title = `${p.account}${p.online ? ' (online)' : ''}`;
  if (p.whisper) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = 'Copy whisper';
    b.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(p.whisper); b.textContent = 'Copied'; };
    el.append(b);
  }
}

// Price a batch of seeds through the relay; on failure, hand the same batch to the trade site instead.
async function priceSeeds(batch, btn, statusEl) {
  const statId = s.jewel.conquerors[s.conq].trade, league = $('league').value;
  const keyOf = (seed) => `${statId}|${league}|${seed}`; // fixed now; the user may change conqueror/league while this runs
  const link = (text) => Object.assign(document.createElement('a'), { href: tradeLinks(statId, batch, league)[0], target: '_blank', rel: 'noopener', textContent: text });
  btn.disabled = true;
  statusEl.textContent = `Checking ${batch.length} seeds on trade…`;
  try {
    const res = await fetch('api/prices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ league, statId, seeds: batch }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.retryAfter ? `${body.error} — try again in ${body.retryAfter}s` : body.error);
    let listed = 0;
    for (const seed of batch) {
      const r = body.results[seed];
      if (r?.status === 'listed') {
        listed++;
        const l = r.cheapest;
        s.prices.set(keyOf(seed), { text: l.price ? `${l.price.amount} ${l.price.currency}` : 'no price', ...l });
      } else s.prices.set(keyOf(seed), r?.status === 'none' ? { none: true } : { unknown: true });
    }
    s.priceMsg = [statusEl.id, link(`${listed} of ${batch.length} seeds are listed`), body.fromCache ? `, ${body.fromCache} from the last two minutes.` : '.'];
  } catch (e) {
    s.priceMsg = [statusEl.id, `Couldn't check prices: ${e.message}. `, link(`Open these ${batch.length} seeds on the trade site`)];
  }
  btn.disabled = false;
  update();
  // update() may have rebuilt the status element (the similar list lives in the re-rendered card)
  const [id, ...msg] = s.priceMsg;
  $(id)?.replaceChildren(...msg);
}
$('priceBtn').onclick = () => priceSeeds(s.results.map((r) => r.seed).filter((seed) => !s.prices.has(priceKey(seed))).slice(0, 32), $('priceBtn'), $('priceStatus'));

fillJewel();
const savedChar = (() => { try { return JSON.parse(load('char') || 'null'); } catch { return null; } })();
if (savedChar) { $('tree-in').value = savedChar.account; listCharacters(savedChar.account, savedChar.name); }
else if (load('tree')) { $('tree-in').value = load('tree'); importTree(load('tree')); }
update();
