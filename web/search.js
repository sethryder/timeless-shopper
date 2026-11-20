// Pure search/ranking logic. No DOM, so test.mjs can run it in Node.

export const seedsOf = (j) => {
  const out = [];
  for (let s = j.seedMin; s <= j.seedMax; s += j.seedStep) out.push(s);
  return out;
};

export const inRadius = (nodes, socket, radius) =>
  nodes.filter((n) => n.id !== socket.id && Math.hypot(n.x - socket.x, n.y - socket.y) < radius);

// Points needed to allocate each node, starting from the already-taken set (cost 0).
// ponytail: other classes' start nodes are not traversable; importing a real tree would need its own class start as a source.
export const distances = (byId, sources) => {
  const dist = new Map();
  const queue = [];
  for (const id of sources) {
    dist.set(id, 0);
    queue.push(id);
  }
  for (let i = 0; i < queue.length; i++) {
    const d = dist.get(queue[i]);
    for (const e of byId.get(queue[i]).edges) {
      if (dist.has(e) || byId.get(e).kind === 'c') continue;
      dist.set(e, d + 1);
      queue.push(e);
    }
  }
  return dist;
};

// Points to allocate every target starting from `sources`, sharing paths: repeatedly attach the nearest target.
// ponytail: greedy Steiner approximation, can overshoot optimal by a point or two when paths branch; Dreyfus-Wagner if that matters.
export const pathCost = (byId, sources, targets) => {
  const tree = new Set(sources);
  const left = new Set(targets.filter((t) => !tree.has(t)));
  let cost = 0;
  while (left.size) {
    const prev = new Map([...tree].map((id) => [id, null]));
    const queue = [...tree];
    let found = null;
    for (let i = 0; i < queue.length && found === null; i++) {
      for (const e of byId.get(queue[i]).edges) {
        if (prev.has(e) || byId.get(e).kind === 'c') continue;
        prev.set(e, queue[i]);
        if (left.has(e)) { found = e; break; }
        queue.push(e);
      }
    }
    if (found === null) return Infinity;
    for (let n = found; !tree.has(n); n = prev.get(n)) { tree.add(n); cost++; }
    for (const t of left) if (tree.has(t)) left.delete(t); // targets passed on the way come free
  }
  return cost;
};

// raw: Int32Array from lookup(), laid out [seedIdx * nodes.length + i] = global id | -1; alts maps id -> name.
// wanted: [{ name, weight, must }]. acceptable(nodeId) -> bool. dist: Map from distances().
// costOf(nodeIds) -> combined points for several hits; defaults to summing each hit's own distance.
export const rank = ({ raw, seeds, nodes, alts, wanted, acceptable, dist, costOf }) => {
  const byName = new Map(wanted.map((w) => [w.name, w]));
  const results = [];
  for (let s = 0; s < seeds.length; s++) {
    const hits = [];
    for (let i = 0; i < nodes.length; i++) {
      const alt = raw[s * nodes.length + i];
      if (alt < 0) continue;
      const w = byName.get(alts[alt]);
      if (w && acceptable(nodes[i].id, w)) hits.push({ node: nodes[i], name: w.name, cost: dist.get(nodes[i].id) ?? Infinity });
    }
    if (!hits.length || wanted.some((w) => w.must && !hits.some((h) => h.name === w.name))) continue;
    results.push({
      seed: seeds[s],
      score: hits.reduce((a, h) => a + byName.get(h.name).weight, 0),
      cost: hits.length > 1 && costOf ? costOf(hits.map((h) => h.node.id)) : hits.reduce((a, h) => a + h.cost, 0),
      hits,
    });
  }
  return results.sort((a, b) => b.score - a.score || a.cost - b.cost || a.seed - b.seed);
};

// The trade site takes at most 45 filters in a count group, so one link per 45 seeds (best first).
export const tradeLinks = (statId, seeds, league, perLink = 45) => {
  const links = [];
  for (let i = 0; i < seeds.length; i += perLink) {
    const q = {
      query: {
        status: { option: 'any' },
        stats: [{
          type: 'count',
          value: { min: 1 },
          filters: seeds.slice(i, i + perLink).map((s) => ({
            id: statId,
            value: { min: s, max: s },
          })),
        }],
      },
      sort: { price: 'asc' },
    };
    links.push(`https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(q))}`);
  }
  return links;
};

// A pasted jewel: game/trade item text ("Commissioned 52540 coins to commemorate Caspiro") or just "52540 Caspiro".
// Jewel comes from its name or the conqueror; anything missing falls back to `current` / `currentConq`.
export const parseJewel = (text, jewels, current, currentConq) => {
  const t = text.replace(/\bMazcotl\b/gi, 'Ahuana'); // ponytail: 3.30 rename; drop once data.json says Mazcotl
  const has = (word) => new RegExp(`\\b${word}\\b`, 'i').test(t);
  const jewel = jewels.find((j) => t.toLowerCase().includes(j.name.toLowerCase()))
    ?? jewels.find((j) => Object.keys(j.conquerors).some(has)) ?? current;
  const conq = Object.keys(jewel.conquerors).find(has) ?? (jewel === current ? currentConq : Object.keys(jewel.conquerors)[0]);
  const valid = (n) => n >= jewel.seedMin && n <= jewel.seedMax && (n - jewel.seedMin) % jewel.seedStep === 0;
  // Prefer the number right before the conqueror's name (the mod line), else the first number that is a valid seed.
  const nearConq = new RegExp(`(\\d+)\\D{0,80}?\\b${conq}\\b`, 'i').exec(t)?.[1];
  const seed = [nearConq, ...(t.match(/\d+/g) ?? [])].map(Number).find((n) => n && valid(n));
  if (!seed) throw new Error(`no ${jewel.name} seed in that (they run ${jewel.seedMin}–${jewel.seedMax}${jewel.seedStep > 1 ? `, steps of ${jewel.seedStep}` : ''})`);
  return { jewel, conq, seed };
};

// Seeds at least as good as `seed` on the notables in `keys`: as many copies of each, each no further away than
// this seed's furthest copy. These are what a pasted jewel competes with on trade. Cheapest to path first.
export const similarSeeds = ({ raw, seeds, nodes, alts, dist, costOf }, seed, keys) => {
  const p = seeds.indexOf(seed), N = nodes.length;
  const need = new Map(); // name -> { count, max }
  for (let i = 0; i < N; i++) {
    const name = alts[raw[p * N + i]];
    if (!keys.has(name)) continue;
    const e = need.get(name) ?? { count: 0, max: 0 };
    e.count++;
    e.max = Math.max(e.max, dist.get(nodes[i].id) ?? Infinity);
    need.set(name, e);
  }
  if (!need.size) return [];
  const wanted = [...need.keys()].map((name) => ({ name, weight: 1, must: true }));
  const acceptable = (id, w) => (dist.get(id) ?? Infinity) <= need.get(w.name).max;
  return rank({ raw, seeds, nodes, alts, wanted, acceptable, dist, costOf })
    .filter((r) => r.seed !== seed && [...need].every(([name, { count }]) => r.hits.filter((h) => h.name === name).length >= count))
    .sort((a, b) => a.cost - b.cost || a.seed - b.seed);
};
