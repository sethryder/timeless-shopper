// Turns a pathofexile.com tree link or a Path of Building export code into allocated node ids.
// inflate: (Uint8Array) -> Promise<Uint8Array> for zlib data (lut.js has one).

const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')), (c) => c.charCodeAt(0));

// Official tree link format (PoB PassiveSpec:DecodeURL): u32 version, u8 class, u8 ascendancy, [u8 count], u16 node ids.
export const decodeTreeUrl = (url) => {
  const b = b64(url.trim().replace(/[?#].*$/, '').replace(/^.*\//, ''));
  const ver = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
  if (b.length < 6 || ver < 1 || ver > 6) throw new Error('Not a recognised tree link');
  const start = ver >= 4 ? 7 : 6;
  const end = ver >= 5 ? Math.min(7 + b[6] * 2, b.length) : b.length;
  const nodes = [];
  for (let i = start; i + 1 < end; i += 2) nodes.push((b[i] << 8) | b[i + 1]);
  return { classId: b[4], nodes };
};

// PoB export code: base64url of zlib-compressed build XML; uses the active <Spec>.
export const decodePobCode = async (code, inflate) => {
  const xml = new TextDecoder().decode(await inflate(b64(code.trim())));
  const specs = [...xml.matchAll(/<Spec\b[^>]*>/g)].map((m) => m[0]);
  const active = Number(/<Tree\b[^>]*\bactiveSpec="(\d+)"/.exec(xml)?.[1] ?? 1);
  const spec = specs[active - 1] ?? specs[0];
  if (!spec) throw new Error('No passive tree found in that build');
  const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(spec)?.[1];
  return { classId: Number(attr('classId') ?? 0), nodes: (attr('nodes') ?? '').split(',').filter(Boolean).map(Number) };
};

// PoE account names carry a discriminator: Name#1234. Shared with serve.mjs's validation.
export const ACCOUNT = /^[^\s#/]{1,40}#\d{4}$/;

// Build-paste sites -> their raw-code URL (same list as PoB's BuildSiteTools.lua). Fetched via serve.mjs: no CORS.
const SITES = [
  [/^pobb\.in\/(?:pob\/)?([\w-]+)/, (id) => `https://pobb.in/pob/${id}`],
  [/^maxroll\.gg\/poe\/pob\/([\w-]+)/, (id) => `https://maxroll.gg/poe/api/pob/${id}`],
  [/^pob\.codes\/b\/([\w-]+)/, (id) => `https://api.pob.codes/${id}/raw`],
  [/^poe\.ninja\/(?:poe1\/)?pob\/(?:raw\/)?(\w+)/, (id) => `https://poe.ninja/poe1/pob/raw/${id}`],
  [/^pastebin\.com\/(?:raw\/)?(\w+)/, (id) => `https://pastebin.com/raw/${id}`],
  [/^rentry\.co\/(\w+)/, (id) => `https://rentry.co/paste/${id}/raw`],
  [/^poedb\.tw\/pob\/([\w-]+)/, (id) => `https://poedb.tw/pob/${id}/raw`],
];
export const rawBuildUrl = (url) => {
  const rest = url.trim().replace(/^https?:\/\/(www\.)?/, '');
  for (const [re, raw] of SITES) { const m = re.exec(rest); if (m) return raw(m[1]); }
  return null;
};

export const parseTree = async (text, inflate) => {
  if (/passive-skill-tree\/|^AAAA/.test(text.trim())) return decodeTreeUrl(text);
  if (rawBuildUrl(text)) {
    const res = await fetch('api/build?url=' + encodeURIComponent(text.trim()));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `couldn't fetch that build (${res.status})`);
    text = await res.text();
  }
  return decodePobCode(text, inflate);
};
