// node build.mjs — downloads GGG's tree export + Path of Building's timeless jewel tables (both pinned),
// writes web/data.json and web/lut/*.zip. Downloads are cached in .cache/.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Pinned upstream commits. scripts/update-pins.mjs (run daily by .github/workflows/update-data.yml) rewrites these.
export const PINS = {
  ggg: '550fb34ae7fca9ec4d760a2ac845bb2ba1032ec3', // grindinggear/skilltree-export
  pob: '343b054ce6f6d9abab9e101d17cd27e2cf15f8a5', // PathOfBuildingCommunity/PathOfBuilding
};
export const POB_DIR = 'src/Data/TimelessJewelData';
const GGG = `https://raw.githubusercontent.com/grindinggear/skilltree-export/${PINS.ggg}`;
const POB = `https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/${PINS.pob}/${POB_DIR}`;

// From PoB src/Modules/Data.lua + ModParser.lua conquerorList. Trade ids follow the trade site's pseudo stat naming.
const JEWELS = [
  { type: 1, name: 'Glorious Vanity', file: 'GloriousVanity', parts: 5, prefix: 'vaal', seedMin: 100, seedMax: 8000, seedStep: 1,
    conquerors: { Xibaqua: '1', Zerphi: '2', Ahuana: '2_v2', Doryani: '3' } }, // ponytail: Ahuana became Mazcotl in 3.30; switch name + trade id once the trade site renames it
  { type: 2, name: 'Lethal Pride', file: 'LethalPride', prefix: 'karui', seedMin: 10000, seedMax: 18000, seedStep: 1,
    conquerors: { Kaom: '1', Rakiata: '2', Kiloava: '3', Akoya: '3_v2' } },
  { type: 3, name: 'Brutal Restraint', file: 'BrutalRestraint', prefix: 'maraketh', seedMin: 500, seedMax: 8000, seedStep: 1,
    conquerors: { Deshret: '1', Balbala: '1_v2', Asenath: '2', Nasima: '3' } },
  { type: 4, name: 'Militant Faith', file: 'MilitantFaith', prefix: 'templar', seedMin: 2000, seedMax: 10000, seedStep: 1,
    conquerors: { Venarius: '1', Maxarius: '1_v2', Dominus: '2', Avarius: '3' } },
  { type: 5, name: 'Elegant Hubris', file: 'ElegantHubris', prefix: 'eternal', seedMin: 2000, seedMax: 160000, seedStep: 20,
    conquerors: { Cadiro: '1', Victario: '2', Chitus: '3', Caspiro: '3_v2' } },
  { type: 6, name: 'Heroic Tragedy', file: 'HeroicTragedy', prefix: 'kalguur', seedMin: 100, seedMax: 8000, seedStep: 1,
    conquerors: { Vorana: '1', Uhtred: '2', Medved: '3' } },
];
// Every upstream file the build reads; the pin updater only bumps when one of these changes.
export const pobFiles = () => ['LegionPassives.lua', 'NodeIndexMapping.lua',
  ...JEWELS.flatMap((j) => (j.parts ? Array.from({ length: j.parts }, (_, p) => `${j.file}.zip.part${p}`) : [`${j.file}.zip`]))];
export const gggFiles = ['data.json'];

const ADDITIONS = 337; // PoB data.timelessJewelAdditions: ids below this are additions, at/above are replacement nodes
const RADIUS = 1800; // Large radius, as used by PoB and vilsol

// Cached per pinned commit, so bumping a pin never reuses old downloads.
const cached = async (name, url, binary) => {
  const dir = `.cache/${url.includes('skilltree-export') ? PINS.ggg : PINS.pob}`;
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${name}`;
  try { return await readFile(path, binary ? undefined : 'utf8'); } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path, buf);
  return binary ? buf : buf.toString('utf8');
};

// Minimal Lua table-literal parser: enough for PoB's generated data files.
export const parseLua = (src) => {
  let i = src.indexOf('return') + 6;
  const ws = () => {
    for (;;) {
      while (/\s/.test(src[i])) i++;
      if (!src.startsWith('--', i)) return;
      while (i < src.length && src[i] !== '\n') i++;
    }
  };
  const value = () => {
    ws();
    if (src[i] === '{') {
      i++;
      const obj = {};
      for (let n = 1; ;) {
        ws();
        if (src[i] === '}') { i++; return obj; }
        let key;
        const bare = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(src.slice(i, i + 64));
        if (src[i] === '[') { i++; key = value(); ws(); i++; ws(); i++; } // [key] =
        else if (bare) { key = bare[1]; i += bare[0].length; }
        else key = n++;
        obj[key] = value();
        ws();
        if (src[i] === ',' || src[i] === ';') i++;
      }
    }
    if (src[i] === '"') {
      let s = '';
      for (i++; src[i] !== '"'; i++) s += src[i] === '\\' ? ({ n: '\n', t: '\t' }[src[++i]] ?? src[i]) : src[i];
      i++;
      return s;
    }
    const m = /^(true|false|nil|-?[\d.]+(?:e[-+]?\d+)?)/.exec(src.slice(i, i + 32));
    if (!m) throw new Error(`parseLua: unexpected ${JSON.stringify(src.slice(i, i + 20))} at ${i}`);
    i += m[0].length;
    return m[1] === 'true' ? true : m[1] === 'false' ? false : m[1] === 'nil' ? null : Number(m[1]);
  };
  return value();
};

const list = (luaArray) => Object.keys(luaArray).sort((a, b) => a - b).map((k) => luaArray[k]);

const ORBIT16 = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
const ORBIT40 = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180, 190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350];

async function main() {
  await mkdir('.cache', { recursive: true });
  await mkdir('web/lut', { recursive: true });

  const tree = JSON.parse(await cached('tree.json', `${GGG}/data.json`));
  const legion = parseLua(await cached('LegionPassives.lua', `${POB}/LegionPassives.lua`));
  const mapping = await cached('NodeIndexMapping.lua', `${POB}/NodeIndexMapping.lua`);

  const lutIndex = new Map(), lutSize = new Map();
  for (const [, id, idx, size] of mapping.matchAll(/^nodeIDList\[(\d+)\] = \{ index = (\d+), size = (\d+) \}/gm)) {
    lutIndex.set(Number(id), Number(idx));
    lutSize.set(Number(idx), Number(size));
  }
  const nodeCount = Number(/nodeIDList\["size"\] = (\d+)/.exec(mapping)[1]);
  const sizeNotable = Number(/nodeIDList\["sizeNotable"\] = (\d+)/.exec(mapping)[1]);
  const localToGlobal = {};
  for (const [, t, l, g] of mapping.matchAll(/^nodeIDList\["localIdToGlobalId"\]\[(\d+)\]\[(\d+)\] = (\d+)/gm)) {
    (localToGlobal[t] ??= [])[Number(l)] = Number(g);
  }

  // --- tree ---
  const keep = (n) => n?.skill !== undefined && tree.groups[n.group] && !n.isProxy && !n.isBlighted && !n.isMastery && !n.ascendancyName && !n.expansionJewel?.parent;
  const nodes = [];
  for (const n of Object.values(tree.nodes)) {
    if (!keep(n)) continue;
    const g = tree.groups[n.group];
    const r = tree.constants.orbitRadii[n.orbit];
    const per = tree.constants.skillsPerOrbit[n.orbit];
    const deg = per === 16 ? ORBIT16[n.orbitIndex] : per === 40 ? ORBIT40[n.orbitIndex] : (360 / per) * n.orbitIndex;
    const a = (deg * Math.PI) / 180;
    const kind = n.classStartIndex !== undefined ? 'c' : n.isJewelSocket ? 'j' : n.isKeystone ? 'k' : n.isNotable ? 'n' : 's';
    const out = {
      id: n.skill, name: n.name, stats: n.stats ?? [], x: Math.round(g.x + r * Math.sin(a)), y: Math.round(g.y - r * Math.cos(a)), kind,
      edges: [...new Set([...(n.out ?? []), ...(n.in ?? [])])].filter((e) => keep(tree.nodes[e])).map(Number),
    };
    if (kind === 'n' && lutIndex.get(n.skill) < sizeNotable) out.lut = lutIndex.get(n.skill);
    if (kind === 'c') out.cls = n.classStartIndex; // tree-link class id -> its start node
    nodes.push(out);
  }

  // --- names: global id -> display name ---
  const additions = list(legion.additions), legionNodes = list(legion.nodes);
  const names = [...additions.map((a) => list(a.sd).join(' / ')), ...legionNodes.map((n) => n.dn)];
  const stats = [...additions, ...legionNodes].map((n) => list(n.sd ?? {})); // global id -> stat lines

  // --- jewels ---
  const jewels = [];
  for (const j of JEWELS) {
    const files = pobFiles().filter((f) => f.startsWith(`${j.file}.zip`));
    const bufs = [];
    for (const f of files) bufs.push(await cached(f, `${POB}/${f}`, true));
    await writeFile(`web/lut/${j.file}.zip`, Buffer.concat(bufs));

    const seedSize = (j.seedMax - j.seedMin) / j.seedStep + 1;
    const keystone = (id) => legionNodes.find((n) => n.id === `${j.prefix}_keystone_${id}`)?.dn ?? '';
    const isNotable = (id) => id.startsWith(`${j.prefix}_`) && id.includes('notable');
    const out = {
      type: j.type, name: j.name, lut: `lut/${j.file}.zip`, seedMin: j.seedMin, seedMax: j.seedMax, seedStep: j.seedStep, seedSize,
      localToGlobal: localToGlobal[j.type] ?? null,
      conquerors: Object.fromEntries(Object.entries(j.conquerors).map(([c, id]) => [c, { keystone: keystone(id), trade: `explicit.pseudo_timeless_jewel_${c.toLowerCase()}` }])),
      notables: [...new Set([
        ...legionNodes.filter((n) => isNotable(n.id) && n.not && !n.ks).map((n) => n.dn),
        ...additions.map((a, g) => isNotable(a.id) && names[g]).filter(Boolean),
      ])].sort(),
    };
    if (j.parts) {
      // Glorious Vanity: a per-(node, seed) length table, then one variable-length block per node in index order.
      out.gvBlockStart = [];
      let at = nodeCount * seedSize;
      for (let i = 0; i < sizeNotable; i++) { out.gvBlockStart.push(at); at += lutSize.get(i); }
      out.gvMight = names.indexOf('Might of the Vaal');
      out.gvLegacy = names.indexOf('Legacy of the Vaal');
    }
    jewels.push(out);
  }

  await writeFile('web/data.json', JSON.stringify({ radius: RADIUS, additions: ADDITIONS, nodes, names, stats, jewels }));
  console.log(`wrote web/data.json: ${nodes.length} nodes, ${nodes.filter((n) => n.lut !== undefined).length} notables with LUT data, ${names.length} names`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) await main();
