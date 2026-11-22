// node serve.mjs — serves web/ and relays GGG/build-site calls (browsers can't call them cross-origin).
// Env: PORT, HOST (default 127.0.0.1; put a TLS reverse proxy in front), CONTACT (an email or URL GGG can reach you at;
// sent in the User-Agent as GGG asks of API clients), TRUST_PROXY=1 (take the client IP from X-Forwarded-For).
// Every visitor shares this server's IP rate limit with GGG, so the API has per-client limits too.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawBuildUrl, ACCOUNT } from './web/importer.js';

const root = fileURLToPath(new URL('./web/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.zip': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
const port = Number(process.env.PORT) || 8417;
const host = process.env.HOST || '127.0.0.1';
const POE = 'https://www.pathofexile.com';
const UA = `timeless-shopper/0.1${process.env.CONTACT ? ` (contact: ${process.env.CONTACT})` : ''}`;
const trustProxy = process.env.TRUST_PROXY === '1';
export const MAX_SEEDS = 32; // anonymous searches reject ~45 filters as "too complex"; 32 works

// --- GGG rate limits: one request at a time, and pause whenever the reported state hits a rule's max. ---
let queue = Promise.resolve();
let readyAt = 0;
export const waitFromHeaders = (rules, state) => {
  // rules "max:period:timeout,...", state "hits:period:penaltyRemaining,..." (same order)
  const r = (rules ?? '').split(',').filter(Boolean).map((x) => x.split(':').map(Number));
  const s = (state ?? '').split(',').filter(Boolean).map((x) => x.split(':').map(Number));
  return Math.max(0, ...s.map(([hits, period, penalty], i) => (penalty > 0 ? penalty : hits >= (r[i]?.[0] ?? Infinity) ? period : 0)));
};
const poe = (path, init = {}) => {
  const run = queue.then(async () => {
    const waitMs = readyAt - Date.now();
    if (waitMs > 30_000) throw Object.assign(new Error('Rate limited by the trade API'), { status: 429, retryAfter: Math.ceil(waitMs / 1000) });
    await new Promise((ok) => setTimeout(ok, Math.max(0, waitMs)));
    // One stalled answer holds up every visitor's queued call, so don't wait out undici's 5-minute default.
    const res = await fetch(POE + path, { signal: AbortSignal.timeout(15_000), ...init, headers: { 'user-agent': UA, 'content-type': 'application/json', ...init.headers } });
    const wait = res.status === 429 ? Number(res.headers.get('retry-after')) || 60 : waitFromHeaders(res.headers.get('x-rate-limit-ip'), res.headers.get('x-rate-limit-ip-state'));
    readyAt = Date.now() + wait * 1000;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `GGG answered ${res.status}`), { status: res.status, retryAfter: wait });
    return body;
  });
  queue = run.catch(() => {});
  return run;
};

// Caches the promise, so identical requests arriving while the first is in flight share one upstream call.
// Failures are dropped so the next request retries.
const cache = new Map(); // key -> { at, value: Promise }
export const cached = (key, ttlMs, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const entry = { at: Date.now(), value: fn() };
  entry.value.catch(() => cache.get(key) === entry && cache.delete(key));
  cache.set(key, entry);
  if (cache.size > 20_000) cache.delete(cache.keys().next().value); // oldest first; entries are small
  return entry.value;
};

// Per-client sliding windows. Returns 0 (and records the hit) or the seconds to wait.
export const limiter = (max, windowMs) => {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    hits.delete(key);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.delete(hits.keys().next().value); // forget the stalest client
    if (recent.length >= max) return Math.ceil((recent[0] + windowMs - now) / 1000);
    recent.push(now);
    return 0;
  };
};
// ponytail: counts cache hits too; fine at these sizes, count only upstream misses if real users hit it.
const apiPerMinute = limiter(30, 60_000); // prices, builds, characters
const charactersPerHour = limiter(30, 3600_000); // GGG allows the whole site ~180 character calls per 2 h
const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',').at(-1)?.trim()) || req.socket.remoteAddress || '?';

// First stat line of a timeless jewel names the seed, e.g. "Commissioned 39680 coins to commemorate Caspiro".
export const listingSummary = (x) => {
  const mod = x.item?.explicitMods?.[0];
  const text = typeof mod === 'string' ? mod : mod?.description ?? '';
  return {
    seed: Number(/\d+/.exec(text)?.[0]),
    price: x.listing?.price ?? null,
    account: x.listing?.account?.name ?? '',
    online: !!x.listing?.account?.online,
    whisper: x.listing?.whisper ?? null,
    indexed: x.listing?.indexed ?? null,
  };
};

// One upstream search for these seeds -> Map seed -> { status: 'listed' | 'none' | 'unknown', cheapest, count }.
// Listings come back cheapest first, so a seed's first fetched listing is its cheapest. If there are more listings
// than we fetch, seeds without a fetched listing are 'unknown' (listed pricier, or not at all).
async function searchSeeds(league, statId, seeds) {
  const query = {
    query: { status: { option: 'any' }, stats: [{ type: 'count', value: { min: 1 }, filters: seeds.map((s) => ({ id: statId, value: { min: s, max: s } })) }] },
    sort: { price: 'asc' },
  };
  const search = await poe(`/api/trade/search/${encodeURIComponent(league)}`, { method: 'POST', body: JSON.stringify(query) });
  const listings = [];
  for (let i = 0; i < Math.min(search.result.length, 40); i += 10) { // fetch takes 10 ids per call
    const page = await poe(`/api/trade/fetch/${search.result.slice(i, i + 10).join(',')}?query=${search.id}`);
    listings.push(...page.result.filter(Boolean).map(listingSummary));
  }
  const complete = search.total <= listings.length;
  return new Map(seeds.map((seed) => {
    const mine = listings.filter((l) => l.seed === seed);
    return [seed, { status: mine.length ? 'listed' : complete ? 'none' : 'unknown', cheapest: mine[0] ?? null, count: mine.length }];
  }));
}

// Per-seed cache: only seeds nobody asked about in the last PRICE_TTL go upstream, in one search.
// cached() runs each miss's fn synchronously inside the map below, so `misses` is complete before the
// microtask that starts the search; concurrent requests for the same seed share its in-flight promise.
const PRICE_TTL = 120_000;
export async function prices({ league, statId, seeds }, search = searchSeeds) {
  const misses = [];
  let batch = null;
  const results = await Promise.all(seeds.map((seed) => cached(JSON.stringify([league, statId, seed]), PRICE_TTL, () => {
    misses.push(seed);
    batch ??= Promise.resolve().then(() => search(league, statId, misses));
    return batch.then((m) => m.get(seed));
  })));
  return { results: Object.fromEntries(seeds.map((seed, i) => [seed, results[i]])), fromCache: seeds.length - misses.length };
}

const readJson = (req) => new Promise((ok, fail) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10_000) { fail(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } });
  req.on('end', () => { try { ok(JSON.parse(body)); } catch { fail(Object.assign(new Error('body is not JSON'), { status: 400 })); } });
});

const PRIVATE = Object.assign(new Error("That account's characters are private, or it doesn't exist"), { status: 404 });
const send = (res, status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));

async function api(req, res, path) {
  try {
    if (path !== '/api/leagues') {
      const ip = clientIp(req);
      const wait = apiPerMinute(ip) || (path.startsWith('/api/character') ? charactersPerHour(ip) : 0);
      if (wait) return send(res, 429, { error: 'Too many requests from you', retryAfter: wait });
    }
    if (path === '/api/leagues' && req.method === 'GET') {
      // /api/trade/data/leagues sometimes comes back empty; this one lists everything. SSF can't trade, so drop it.
      // Challenge leagues first, so the default is the current one.
      const leagues = await cached('leagues', 3600_000, async () => {
        const all = (await poe('/api/leagues?type=main&realm=pc')).filter((l) => !l.rules?.some((r) => r.id === 'NoParties'));
        if (!all.length) throw new Error('no leagues listed');
        return [...all.filter((l) => l.category?.id !== 'Standard'), ...all.filter((l) => l.category?.id === 'Standard')].map((l) => l.id);
      });
      return send(res, 200, leagues);
    }
    if (path === '/api/build' && req.method === 'GET') {
      // Only fixed hosts: rawBuildUrl rebuilds the URL from a matched id, and redirects are refused, so this can't be pointed elsewhere.
      const raw = rawBuildUrl(new URL(req.url, 'http://x').searchParams.get('url') ?? '');
      if (!raw) return send(res, 400, { error: 'unsupported build link' });
      const code = await cached(raw, 600_000, async () => {
        const r = await fetch(raw, { headers: { 'user-agent': UA }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const text = (await r.text()).trim();
        if (!r.ok || !/^[\w=-]{20,}$/.test(text)) throw Object.assign(new Error(`couldn't get a build code from that link (${r.status})`), { status: 404 });
        return text;
      });
      return res.writeHead(200, { 'content-type': 'text/plain' }).end(code);
    }
    // Public character profiles (same endpoints aris uses). They share the poe() queue with trade, so one pause covers both.
    // ponytail: one readyAt for trade and character limits; split per endpoint if character loads start stalling price checks.
    if ((path === '/api/characters' || path === '/api/character') && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams, account = q.get('account') ?? '', name = q.get('name') ?? '';
      if (!ACCOUNT.test(account)) return send(res, 400, { error: 'Account names look like Name#1234' });
      if (path === '/api/character' && (!name || name.length > 64)) return send(res, 400, { error: 'bad character name' });
      const params = `accountName=${encodeURIComponent(account)}&realm=pc${path === '/api/character' ? `&character=${encodeURIComponent(name)}` : ''}`;
      const endpoint = path === '/api/characters' ? 'get-characters' : 'get-passive-skills';
      const body = await cached(`${endpoint}|${account}|${name}`, 600_000, async () => {
        // GGG answers private and missing profiles alike: a 403/404 page, or the JSON `false`.
        const b = await poe(`/character-window/${endpoint}?${params}`).catch((e) => { throw e.status === 403 || e.status === 404 ? PRIVATE : e; });
        if (!b || typeof b !== 'object') throw PRIVATE;
        return b;
      });
      if (path === '/api/characters') {
        return send(res, 200, body.filter((c) => c.realm === 'pc').sort((a, b) => (b.lastLoginTime ?? 0) - (a.lastLoginTime ?? 0))
          .map(({ name, class: cls, league, level }) => ({ name, class: cls, league, level })));
      }
      return send(res, 200, { classId: body.character, nodes: body.hashes ?? [] });
    }
    if (path === '/api/prices' && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch (e) { return send(res, e.status, { error: e.message }); }
      const { league, statId, seeds } = body ?? {}; // non-objects fall through to the 400s below
      if (typeof league !== 'string' || !/^[\w '-]{1,64}$/.test(league)) return send(res, 400, { error: 'bad league' });
      if (typeof statId !== 'string' || !/^explicit\.pseudo_timeless_jewel_[a-z]+$/.test(statId)) return send(res, 400, { error: 'bad statId' });
      if (!Array.isArray(seeds) || !seeds.length || seeds.length > MAX_SEEDS || !seeds.every((s) => Number.isInteger(s) && s > 0 && s < 1e6)) {
        return send(res, 400, { error: `seeds: 1-${MAX_SEEDS} positive integers` });
      }
      return send(res, 200, await prices({ league, statId, seeds: [...new Set(seeds)] }));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status === 429 || e.status === 404 ? e.status : 502, { error: e.message, retryAfter: e.retryAfter });
  }
}

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const gz = new Map(); // etag -> gzipped body, for text files (data.json is 420 KB raw, ~60 KB gzipped)

const server = createServer(async (req, res) => {
  let path;
  try { path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, ''); }
  catch { return res.writeHead(400).end('bad request'); } // e.g. "/%E0"; an uncaught throw here would kill the process
  if (path.startsWith('/api/')) return api(req, res, path);
  try {
    const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    // Revalidate every time (data.json and app.js must stay in step), but answer 304 when nothing changed.
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const type = types[extname(file)] ?? 'application/octet-stream';
    const headers = { ...SECURITY, 'content-type': type, 'cache-control': 'no-cache', etag, vary: 'accept-encoding' };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    let body = await readFile(file);
    if (/text|json|javascript|svg|xml/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      if (!gz.has(etag)) gz.set(etag, gzipSync(body));
      body = gz.get(etag);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { ...SECURITY, 'content-type': 'text/plain' }).end('not found');
  }
});

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.CONTACT) console.warn('CONTACT is not set: GGG asks API clients to include a contact in the User-Agent.');
  server.listen(port, host, () => console.log(`http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
