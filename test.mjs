// node test.mjs — checks the LUT reader, search, import and relay helpers against the real built data. No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { seedsOf, inRadius, distances, pathCost, rank, tradeLinks, parseJewel, similarSeeds } from './web/search.js';
import { inflate, lookup } from './web/lut.js';
import { decodeTreeUrl, parseTree, rawBuildUrl } from './web/importer.js';
import { parseLua } from './build.mjs';
import { waitFromHeaders, listingSummary, cached, prices, limiter } from './serve.mjs';

const data = JSON.parse(readFileSync('web/data.json', 'utf8'));
const byId = new Map(data.nodes.map((n) => [n.id, n]));
const hubris = data.jewels.find((j) => j.name === 'Elegant Hubris');
assert.equal(hubris.conquerors.Caspiro.keystone, 'Supreme Ostentation');

// parseLua on the shapes PoB's data files use.
assert.deepEqual(parseLua('-- c\nreturn { ["a"] = { [1] = "x\\"y", [2] = -3.5 }, b = true, "z", }'), { a: { 1: 'x"y', 2: -3.5 }, b: true, 1: 'z' });

// BFS + shared-path cost on a tiny graph:  1 - 2 - 3, and 2 - 4.
const g = new Map([[1, { edges: [2] }], [2, { edges: [1, 3, 4] }], [3, { edges: [2] }], [4, { edges: [2] }]]);
assert.deepEqual([...distances(g, [1])], [[1, 0], [2, 1], [3, 2], [4, 2]]);
assert.equal(pathCost(g, [1], [3, 4]), 3); // 2 is shared: summing distances would say 4
assert.equal(pathCost(g, [1], [2, 3]), 2); // 2 is on the way to 3

// Elegant Hubris LUT: spot values cross-checked against vilsol's calculator while migrating.
const lut = await inflate(readFileSync('web/' + hubris.lut));
assert.equal(lut.length, 454 * hubris.seedSize);
const seeds = seedsOf(hubris);
assert.equal(seeds.length, hubris.seedSize);

let found = 0;
for (const socket of data.nodes.filter((n) => n.kind === 'j')) {
  const nodes = inRadius(data.nodes, socket, data.radius).filter((n) => n.lut !== undefined);
  const raw = lookup(hubris, lut, nodes.map((n) => n.lut));
  assert.ok(raw.every((g) => g >= data.additions), 'Elegant Hubris replaces every notable');
  const dist = distances(byId, [socket.id]);
  const results = rank({ raw, seeds, nodes, alts: data.names, wanted: [{ name: 'Slum Lord', weight: 1, must: true }], acceptable: (id) => dist.get(id) <= 4, dist, costOf: (ids) => pathCost(byId, [socket.id], ids) });
  for (const r of results) {
    assert.ok(r.hits.every((h) => h.name === 'Slum Lord' && h.cost <= 4));
    assert.ok(r.cost <= r.hits.reduce((a, h) => a + h.cost, 0), 'shared cost never exceeds the sum');
  }
  found += results.length;
}
console.log(`Elegant Hubris: ${found} Slum Lord hits within 4 pts across all sockets`);
// Per-notable max: acceptable() gets the wanted entry, so each notable can have its own limit.
{
  const nodes = [{ id: 1 }, { id: 2 }], d = new Map([[1, 2], [2, 6]]), alts = ['A', 'B'];
  const wanted = [{ name: 'A', weight: 1, max: 3 }, { name: 'B', weight: 1, max: 5 }];
  const r = rank({ raw: Int32Array.from([0, 1]), seeds: [7], nodes, alts, wanted, dist: d, acceptable: (id, w) => d.get(id) <= w.max });
  assert.deepEqual(r[0].hits.map((h) => h.name), ['A'], 'B at 6 pts is over its own max of 5');
}
assert.ok(found > 0);

// Glorious Vanity (variable-length format) decodes to a name for every notable.
const gv = data.jewels.find((j) => j.name === 'Glorious Vanity');
const gvRaw = lookup(gv, await inflate(readFileSync('web/' + gv.lut)), [0, 1, 200, 453]);
assert.ok(gvRaw.every((g) => data.names[g]), 'every GV notable/seed decodes');

// Lethal Pride adds stats instead of replacing.
const lp = data.jewels.find((j) => j.name === 'Lethal Pride');
const lpRaw = lookup(lp, await inflate(readFileSync('web/' + lp.lut)), [0]);
assert.ok(lpRaw.every((g) => g < data.additions));

// Trade links: 45 seeds per link.
const links = tradeLinks(hubris.conquerors.Caspiro.trade, seeds.slice(0, 100), 'Standard');
assert.equal(links.length, 3);
assert.equal(JSON.parse(decodeURIComponent(links[0].split('?q=')[1])).query.stats[0].filters.length, 45);

// Pasted jewels: full item text, short form, other jewel by conqueror, and bad seeds.
{
  const item = 'Item Class: Jewels\nRarity: Unique\nElegant Hubris\nTimeless Jewel\n--------\nLimited to: 1 Historic\nRadius: Large\n--------\nItem Level: 84\n--------\nCommissioned 52540 coins to commemorate Caspiro\nPassives in radius are Conquered by the Eternal Empire\nHistoric';
  const p = (t) => { const r = parseJewel(t, data.jewels, hubris, 'Chitus'); return [r.jewel.name, r.conq, r.seed]; };
  assert.deepEqual(p(item), ['Elegant Hubris', 'Caspiro', 52540]);
  assert.deepEqual(p(item.replace(/\n/g, ' ')), ['Elegant Hubris', 'Caspiro', 52540], 'newlines stripped by a text input');
  assert.deepEqual(p('52540 caspiro'), ['Elegant Hubris', 'Caspiro', 52540]);
  assert.deepEqual(p('52540'), ['Elegant Hubris', 'Chitus', 52540], 'bare seed keeps the current conqueror');
  assert.deepEqual(p('Commanded leadership over 10500 warriors under Kaom'), ['Lethal Pride', 'Kaom', 10500]);
  assert.deepEqual(p('Bathed in the blood of 4321 sacrificed in the name of Mazcotl'), ['Glorious Vanity', 'Ahuana', 4321]);
  assert.throws(() => p('52541 Caspiro'), /steps of 20/);
}

// Similar seeds: same notable at least as many times, each no further than the pasted seed's furthest copy.
{
  const nodes = [{ id: 1 }, { id: 2 }, { id: 3 }], d = new Map([[1, 2], [2, 4], [3, 9]]), alts = ['A', 'B', 'C'];
  // seeds 10..13, rows = what nodes 1,2,3 become
  const raw = Int32Array.from([0, 0, 1, /*11*/ 0, 1, 0, /*12*/ 1, 0, 0, /*13*/ 2, 2, 0]);
  const sim = similarSeeds({ raw, seeds: [10, 11, 12, 13], nodes, alts, dist: d }, 10, new Set(['A']));
  // 10 has A twice (2 and 4 pts). 11 has A at 2 and 9 -> too far. 12 has A at 4 and 9 -> too far. 13 has A once.
  assert.deepEqual(sim.map((r) => r.seed), []);
  const sim2 = similarSeeds({ raw, seeds: [10, 11, 12, 13], nodes, alts, dist: d }, 11, new Set(['A']));
  assert.deepEqual(sim2.map((r) => r.seed), [10, 12], 'two As within 9 pts; cheapest first');
}

// Import: official tree link (v6: ver, class 3, ascendancy 1, 2 nodes, 0 clusters, 0 masteries) and a PoB code.
const bytes = [0, 0, 0, 6, 3, 1, 2, 0x00, 0x06, 0xff, 0x01, 0, 0];
const url = 'https://www.pathofexile.com/passive-skill-tree/' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
assert.deepEqual(decodeTreeUrl(url), { classId: 3, nodes: [6, 65281] });
const xml = '<PathOfBuilding><Tree activeSpec="2"><Spec classId="1" nodes="1,2"/><Spec treeVersion="3_30" classId="4" nodes="6,529,544"/></Tree></PathOfBuilding>';
const pob = deflateSync(xml).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
assert.deepEqual(await parseTree(pob, inflate), { classId: 4, nodes: [6, 529, 544] });

// Build-site links map to fixed raw URLs; anything else is rejected.
assert.equal(rawBuildUrl('https://pobb.in/gEq-VXhE80r7'), 'https://pobb.in/pob/gEq-VXhE80r7');
assert.equal(rawBuildUrl('https://maxroll.gg/poe/pob/ab12cd'), 'https://maxroll.gg/poe/api/pob/ab12cd');
assert.equal(rawBuildUrl('https://poe.ninja/poe1/pob/1a2b'), 'https://poe.ninja/poe1/pob/raw/1a2b');
assert.equal(rawBuildUrl('https://evil.com/pobb.in/x'), null);
assert.equal(rawBuildUrl(pob), null);

// Relay helpers.
assert.equal(waitFromHeaders('5:10:60,15:60:300', '1:10:0,2:60:0'), 0);
assert.equal(waitFromHeaders('5:10:60,15:60:300', '5:10:0,2:60:0'), 10);
assert.equal(waitFromHeaders('5:10:60', '6:10:60'), 60); // already penalised
assert.equal(listingSummary({ item: { explicitMods: [{ description: 'Commissioned 39680 coins to commemorate Caspiro\nPassives…' }] }, listing: { price: { amount: 2, currency: 'divine' } } }).seed, 39680);
// Cache: 100 identical requests while one is in flight -> one upstream call; failures aren't cached.
let calls = 0;
const slow = () => { calls++; return new Promise((ok) => setTimeout(() => ok('listings'), 20)); };
const all = await Promise.all(Array.from({ length: 100 }, () => cached('same', 60_000, slow)));
assert.equal(calls, 1);
assert.ok(all.every((v) => v === 'listings'));
await cached('same', 60_000, slow);
assert.equal(calls, 1, 'served from cache after completing');
await assert.rejects(cached('bad', 60_000, () => Promise.reject(new Error('429'))));
assert.equal(await cached('bad', 60_000, async () => 'retried'), 'retried');
// Per-seed price cache: overlapping and concurrent batches only send uncached seeds upstream.
const asked = [];
const fakeSearch = async (league, statId, seeds) => {
  asked.push([...seeds]);
  await new Promise((ok) => setTimeout(ok, 20));
  return new Map(seeds.map((s) => [s, { status: s % 2 ? 'listed' : 'none', cheapest: s % 2 ? { seed: s, price: { amount: s, currency: 'chaos' } } : null, count: s % 2 }]));
};
const req = (seeds) => prices({ league: 'T', statId: 'explicit.pseudo_timeless_jewel_test', seeds }, fakeSearch);
const a = await req([1, 2, 3]);
assert.deepEqual(asked, [[1, 2, 3]]);
assert.equal(a.results[1].cheapest.price.amount, 1);
assert.equal(a.results[2].status, 'none');
const b = await req([2, 3, 4]);
assert.deepEqual(asked.at(-1), [4]);
assert.equal(b.fromCache, 2);
await Promise.all([req([5, 6]), req([6, 7])]); // 6 is in flight for the first, shared by the second
assert.deepEqual(asked.slice(-2), [[5, 6], [7]]);
assert.equal((await req([1, 2, 3, 4, 5, 6, 7])).fromCache, 7);
assert.equal(asked.length, 4, 'fully cached request makes no upstream call');
await assert.rejects(prices({ league: 'T', statId: 'explicit.pseudo_timeless_jewel_test', seeds: [8] }, async () => { throw new Error('429'); }));
await req([8]);
assert.deepEqual(asked.at(-1), [8], 'failed seeds are retried, not cached');
// Per-client limiter: 2 per window, then a wait; other clients unaffected.
{
  const lim = limiter(2, 60_000);
  assert.equal(lim('a'), 0); assert.equal(lim('a'), 0);
  assert.ok(lim('a') > 0, 'third call waits');
  assert.equal(lim('b'), 0);
}
console.log('ok');
