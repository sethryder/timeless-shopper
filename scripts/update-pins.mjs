// node scripts/update-pins.mjs — bump build.mjs's pins to upstream master, but only when a file the build reads
// changed (GitHub blob shas), so unrelated upstream commits don't cause churn. Writes a PR title/body to
// $GITHUB_OUTPUT when run in Actions. GITHUB_TOKEN is optional (raises the API limit).
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { PINS, POB_DIR, pobFiles, gggFiles } from '../build.mjs';

const SOURCES = [
  { key: 'ggg', repo: 'grindinggear/skilltree-export', dir: '', files: gggFiles },
  { key: 'pob', repo: 'PathOfBuildingCommunity/PathOfBuilding', dir: POB_DIR, files: pobFiles() },
];

const gh = async (path) => {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'timeless-shopper-pin-updater' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
  return res.json();
};
const blobs = async (repo, ref, dir, files) => {
  const list = await gh(`repos/${repo}/contents/${dir}?ref=${ref}`);
  return Object.fromEntries(list.filter((f) => files.includes(f.name)).map((f) => [f.name, f.sha]));
};

let src = await readFile(new URL('../build.mjs', import.meta.url), 'utf8');
const notes = [];
for (const { key, repo, dir, files } of SOURCES) {
  const head = await gh(`repos/${repo}/commits/master`);
  if (head.sha === PINS[key]) continue;
  const [before, after] = await Promise.all([blobs(repo, PINS[key], dir, files), blobs(repo, head.sha, dir, files)]);
  const changed = files.filter((f) => before[f] !== after[f]);
  const missing = files.filter((f) => !after[f]);
  if (missing.length) throw new Error(`${repo}@${head.sha.slice(0, 7)} no longer has ${missing.join(', ')}; build.mjs needs a manual update`);
  if (!changed.length) { console.log(`${repo}: master moved, but none of our files changed`); continue; }
  src = src.replace(PINS[key], head.sha);
  const title = head.commit.message.split('\n')[0];
  notes.push({ repo, from: PINS[key], to: head.sha, title, changed });
  console.log(`${repo}: ${PINS[key].slice(0, 7)} -> ${head.sha.slice(0, 7)} (${title}); changed: ${changed.join(', ')}`);
}

if (!notes.length) console.log('Pins are current.');
else await writeFile(new URL('../build.mjs', import.meta.url), src);

if (process.env.GITHUB_OUTPUT) {
  const what = notes.map((n) => (n.repo.startsWith('grindinggear') ? `tree ${n.title}` : `PoB ${n.title}`)).join(', ');
  const body = notes.map((n) => `- **${n.repo}** [\`${n.from.slice(0, 7)}\`…\`${n.to.slice(0, 7)}\`](https://github.com/${n.repo}/compare/${n.from}...${n.to}) — ${n.title}\n  Changed: ${n.changed.map((f) => `\`${f}\``).join(', ')}`).join('\n');
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${notes.length > 0}\ntitle=Update game data: ${what}\nbody<<EOF\n${body}\n\nBuilt and tested by the update-data workflow.\nEOF\n`);
}
