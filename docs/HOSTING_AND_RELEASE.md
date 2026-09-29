# PositionLayer — public release and deployment

Updated: 2026-09-29. This guide describes the current application, replacing the older preview-switch and in-memory-worker instructions. Remote deployment acceptance is still pending.

## Development and public repository

`D:\PositionLayer` is the development source of truth. `D:\PositionLayer\.public-release` is a separate Git checkout containing a reviewed export. Work in the main project, validate there, and then refresh the release copy. Preserve the release checkout's own `.git` directory and remote. Do not copy the development `.git` directory or blindly mirror the whole development folder.

Publish source, required public assets and bundled identity data, package.json/package-lock.json, build configuration, tests/fixtures, reviewed product documentation, and placeholder `.env.example`. Exclude `.env.local`, credentials, `.market-data`, `.next`, node_modules, logs, research, recordings, screenshots and generated test reports. Tests are useful source files; generated test results are not. AGENTS.md contains the framework's development guidance, not credentials.

Git ignores do not erase previously committed secrets. Review the pending files and existing history before a public push. The release folder already has an origin remote; verify it points to your intended GitHub repository. No force push or new history is needed for this update.

## Architecture required for live Stocks

```text
Browser -> Vercel Next.js reader -> one persistent Node backend -> providers
                                        |
                                  persistent disk
                              snapshots.sqlite + enrichment.sqlite
```

The same application repository runs on both hosts. The backend owns one paced price worker and the enrichment queues. Vercel reads completed snapshots. Vercel must not own a market worker or a local market database. Keyless provider access does not eliminate the backend requirement or provider rate limits.

Without a reachable populated backend, Vercel can render the site and reviewed catalog, but live Stocks prices/enrichment will be missing. Do not point the reader at itself, another reader, your localhost, or a private development address.

## 1. Push the reviewed release checkout

Run commands from `D:\PositionLayer\.public-release`, not the parent project:

```powershell
git status --short
git remote -v
git branch --show-current
git diff --check
git add -- .
git diff --cached --stat
# Inspect the staged diff before committing.
git diff --cached
git commit -m "Update PositionLayer application and deployment guide"
git push origin HEAD
```

Use the branch reported by `git branch --show-current` as the deployment branch, or choose a branch intentionally. A push may auto-deploy if a host is already connected. GitHub should show `package.json`, `src`, and `public` at repository root, not a parent folder containing `.public-release`.

## 2. Deploy the persistent backend first

Use one continuously running Node web service/container with a persistent disk (for example your chosen Render, Railway or VPS service). Configure **one replica**. The SQLite lock coordinates processes only on the same disk; separate backend replicas/disks would duplicate work.

- Runtime: Node 22.x, at least 22.14.0 (the application uses `node:sqlite`).
- Install: `npm ci`.
- Build: `npm run build` with `MARKET_V2_WRITER_ENABLED=false` during the build.
- Start: `npm run start` with the writer enabled at runtime. The host supplies PORT.
- If a host shares build/runtime environment variables, use a build command that disables the writer for that command only. On a Linux host: `MARKET_V2_WRITER_ENABLED=false npm run build`.
- Mount a persistent disk. `/var/data/positionlayer-market` below is an example; use the directory actually mounted by your host.
- Expose the backend over HTTPS. Its market GET endpoints must be reachable by Vercel without an interactive login; the current reader does not send an authentication token.

| Backend variable | Value |
| --- | --- |
| `MARKET_V2_WRITER_ENABLED` | `true` at runtime |
| `MARKET_SNAPSHOT_DIR` | `/var/data/positionlayer-market` (your actual mounted path) |
| `MARKET_PRICE_PACE_MS` | `2500` |
| `MARKET_REFRESH_INTERVAL_MS` | `60000` |
| `MARKET_PRICE_PAUSED` | `false` |
| `MARKET_ENRICHMENT_ENABLED` | `true` |
| `MARKET_V2_WRITER_ORIGIN` | **Leave unset** |
| `APP_ORIGIN` | Your backend's own bare HTTPS origin |
| `ADMIN_HEALTH_ENABLED` | `false` |

Defaults cover other settings; `.env.example` documents optional controls. Do not add `VERCEL=1` on this backend. If using Docker, build without private env files and inject runtime values through the host; mount the persistent directory into the container.

Open `https://YOUR-BACKEND/api/markets/v2/health`. Wait for a completed price cycle with a nonzero returned-price count. Inspect `prices`, `coverage`, `source`, `localEngine`, and `snapshotAgeMs`. Enrichment fills gradually across cycles; not every catalog identity has a quote. A backend restart should retain completed snapshots from the mounted disk.

## 3. Import the GitHub repository into Vercel

Choose the Next.js preset. Root Directory is the **repository root** (leave the default); do not enter the local Windows path or `.public-release`. Install command is `npm ci`; build command is `npm run build`; keep Next.js's default output settings. Select **Node 22.x** in project settings. The package engine is constrained to `>=22.14.0 <23` so the broad previous range cannot select an untested newer major.

Under Project Settings -> Environment Variables, add:

| Vercel variable | Value | Purpose |
| --- | --- | --- |
| `MARKET_V2_WRITER_ENABLED` | `false` | Reader only |
| `MARKET_V2_WRITER_ORIGIN` | `https://YOUR-BACKEND-HOST` | Required for live Stocks; bare origin, no API path |
| `APP_ORIGIN` | `https://YOUR-VERCEL-DOMAIN` | The website's actual browser-facing origin |
| `ADMIN_HEALTH_ENABLED` | `false` | Keep private admin UI disabled |
| `APP_CLUSTER` | `solana:mainnet` | Optional explicit value; mainnet is the default |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Optional keyless default for portfolio reads |

Set the appropriate Production/Preview scopes. `APP_ORIGIN` must match the URL used to visit that environment, because POST requests validate same-origin. A preview using a different hostname needs its own matching value. The backend URL is shared only if both environments intentionally use that same writer.

Leave `MARKET_SNAPSHOT_DIR` unset on Vercel. Do not add the removed `NEXT_PUBLIC_STOCKS_VIEW` or `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW` flags. `JUPITER_API_KEY` is optional; leave it unset for the existing keyless configuration. No private key, wallet seed phrase, or admin password is needed for this setup. Vercel provides its own VERCEL and PORT values; do not add them manually.

If you do not know the Vercel domain until the first deployment, set APP_ORIGIN once the domain is assigned, then redeploy. Environment variable changes apply to new deployments, not existing ones. A public Solana RPC may throttle or lack the indexed read coverage required for a complete portfolio; a dedicated RPC can be supplied later without changing the app. Keyless does not guarantee unlimited traffic or complete data.

## 4. Verify the deployed application

1. On both hosts, request `/api/markets/v2/stocks?pageSize=1` close together. Compare `prices.snapshotId`, catalog identity, and quote coverage. Allow for a cycle completing between the requests; results should converge.
2. Vercel `/api/markets/v2/health` should report `role: reader` and no running local writer. The backend reports `role: local`; use `localEngine` to verify its writer, not the role string alone.
3. Open Stocks without a wallet. Check Tokenized and Listed, caps, search, filters, columns, pagination, detail views, CSV, watchlist, logos and the Top Stocks ticker. Check both themes and sidebar expansion.
4. Keep two browsers open and reload several times. Provider work should remain owned by the same backend, not increase by one worker per visitor.
5. Verify Portfolio/Exposure/Protect using a public address, and explicit Sample mode separately. No wallet signing is required.
6. Verify `/admin/health` and `/api/admin/health` stay unavailable with admin disabled.
7. Restart the backend once and verify durable snapshots recover; verify fresh cycles resume. Check provider failures/429 backoff without treating unavailable fields as zero.

A successful local build is not proof of remote hosting, quotas, persistent-disk setup, or end-to-end production behavior. Public deployment acceptance remains pending until these checks pass. Roll back to a tested Git revision if required; there is no public Current market/Canonical preview switch now.

## Local release validation

```powershell
npm ci
npm test
npm run lint
npm run build
npm run typecheck
npm run test:ui
```

Use an isolated port and disable the writer during deterministic tests/builds. Do not connect a second writer to the same providers just to run UI tests. Unit/browser fixtures verify behavior; they do not prove provider availability in production.

## Official platform references

- [Vercel environment variables](https://vercel.com/docs/environment-variables): choose environment scopes and redeploy after changes.
- [Vercel Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions): select the tested Node major in project settings.
- [Next.js environment variables](https://nextjs.org/docs/app/guides/environment-variables): keep credentials server-side.
