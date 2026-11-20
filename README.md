# Timeless Shopper

[![test](https://github.com/sethryder/timeless-shopper/actions/workflows/test.yml/badge.svg)](https://github.com/sethryder/timeless-shopper/actions/workflows/test.yml)

Live at https://timeless.washclof.com

Find Path of Exile timeless jewel seeds by outcome ("Slum Lord within 4 points of my tree, with Supreme Ostentation"),
then open trade searches or check live prices.

    npm run build   # downloads pinned GGG tree + Path of Building jewel tables into web/
    npm run dev     # http://127.0.0.1:8417 (static site + relay)
    npm test

`serve.mjs` serves `web/` and relays the calls browsers can't make themselves: trade prices, public characters by
account name, and build links (pobb.in etc.). Without it the site still works for pasted PoB codes and trade links.

## Deploying

Run `serve.mjs` behind a TLS reverse proxy. It needs Node 20+ and no dependencies.

| Env | |
|---|---|
| `PORT`, `HOST` | default `8417`, `127.0.0.1` |
| `CONTACT` | an email or URL; sent in the User-Agent, as GGG asks API clients to |
| `TRUST_PROXY=1` | take the client IP from `X-Forwarded-For` (set it behind a proxy, or every visitor shares one limit) |

Every visitor shares this server's GGG rate limit, so the API also limits each client (30 calls a minute, 30
character loads an hour). When GGG says wait, price checks fall back to trade links.

Caddy:

    timeless.washclof.com {
        reverse_proxy 127.0.0.1:8417
    }

systemd (`/etc/systemd/system/timeless-shopper.service`):

    [Service]
    WorkingDirectory=/srv/timeless-shopper
    ExecStart=/usr/bin/node serve.mjs
    Environment=CONTACT=you@example.com TRUST_PROXY=1
    Restart=always
    User=www-data
    [Install]
    WantedBy=multi-user.target

## Keeping the data current

`build.mjs` pins exact commits of GGG's tree export and Path of Building. The `update-data` workflow checks both
daily and, when a file the build reads has changed, bumps the pins, rebuilds, tests, and opens a PR. Merge it and
redeploy (`git pull && npm run build`, then restart). To check by hand: `node scripts/update-pins.mjs`.
