# PositionLayer — GitHub, hosting, and release runbook

Last reviewed: 2026-09-19. This guide matches the current code and does **not** assume that a serverless function can run a continuous background worker. Recheck provider quotas and host terms before release. No deployment or Git push is performed by this file.

## 1. Pick the topology first

**Recommended for the current hackathon build:** one continuously running Node.js 22.14+ process behind HTTPS, with one replica and enough memory for Next.js plus the in-process catalog/price cache. This can be a Node web service, Docker container, or VM. A visitor opens the market route, the shared 300-mint Price V3 worker starts, and six sequential batches of 50 continue while that Node process stays alive. No browser reload starts another worker in that process. It does **not** make a 30-second freshness guarantee under upstream latency, rate limits, process restart, or host sleep.

| Host option | Current app fit | Important trade-off |
| --- | --- | --- |
| Persistent single-instance Node/Docker/VM | **Recommended**; full current functionality | One instance is a scaling ceiling; protect with rate limits, monitor upstream budgets |
| Render Node Web Service | Fits when it remains running as one instance | The Free instance sleeps after 15 idle minutes and can restart; warm prices and six-hour health history reset. Render warns that free services are not for production and may suspend unusually high outbound traffic. |
| Railway Node service | Can fit as one always-running service if the chosen plan actually keeps it running | Verify current plan, spend limits, sleep/restart behavior, and single-instance setting; do not assume free sustained runtime. |
| Vercel Functions | **Preview/limited use only** for this architecture | Function memory/timers/global state are not a durable singleton; each cold or concurrent instance may have a different worker/cache. Long portfolio reads also depend on current function duration/bundle limits. Do not promise full-scale continuously refreshed Stocks there. |
| Static site (`out`, GitHub Pages, static Render) | **Not compatible** | Portfolio, market, health, and quote route handlers require Node. |

Official hosting references: [Next.js self-hosting and multi-instance caching](https://nextjs.org/docs/app/guides/self-hosting), [Render Next.js web service](https://render.com/docs/deploy-nextjs-app), [Render Free restrictions](https://render.com/docs/free), [Railway Next.js guidance](https://docs.railway.com/guides/fullstack-nextjs), [Vercel Function limits](https://vercel.com/docs/functions/limitations), [Vercel environment variables](https://vercel.com/docs/environment-variables). Host limits and costs can change; verify current terms rather than relying on this dated summary.

## 2. Know the hidden state before you scale

The **market worker, prices/last-known-good, provider request queues, issuer/Meteora/Lend caches, quote throttling, and six-hour monitoring are `globalThis`/in-memory state in `src/services/stocks-market.ts` and related services**. The reviewed `issuer-catalog-snapshot.json` is bundled identity data, not a live price store. Next.js's own page/data cache and the 15-second public HTTP `s-maxage` are separate; a CDN hit does not update the worker. A process restart loses warm price and health state, although issuer identities can still load from the snapshot. A second server replica does **not** share the first replica's cache or rate-limit budget and may double requests. A browser refresh only reads the same process cache when it reaches that same living process.

For **true horizontal scaling** in a later authorized project: extract one durable/scheduled price worker, elect/lock exactly one producer, put normalized observations/TTL and provider rate budgets into a shared store, make all web replicas read that store, coordinate catalog and health ownership, and add load/concurrency/failover tests. A Next `cacheHandler` alone does not move this custom `globalThis` worker or its queues. Do not add Redis, paid services, cron polling, or a second worker just by flipping a deployment setting.

## 3. Environment variables

Copy the *names* from `.env.example`; set values in your host's secret/variable UI. **Do not upload `.env.local` or paste it into GitHub.** The checked-in `.gitignore` and `.dockerignore` exclude `.env*` except `.env.example`. No private key, seed phrase, or server wallet is needed. No variable here should be prefixed `NEXT_PUBLIC_`.

| Variable | Required? | Production meaning |
| --- | --- | --- |
| `APP_CLUSTER` | Recommended | Must be `solana:mainnet`; other values are rejected by the current registry. |
| `SOLANA_RPC_URL` | Recommended for reliable Live reads | A private server-side mainnet HTTPS RPC URL with wallet token-account/indexed reads as required by the app. Default public Solana RPC is rate-limited and may fail. Treat embedded tokens as secrets. |
| `JUPITER_API_KEY` | Optional | Server-side Jupiter read/quote key. **Public Stocks Price V3 worker deliberately remains keyless**; a key does not make it a durable background service. |
| `APP_ORIGIN` | Recommended for public HTTPS origin | Exact browser origin such as `https://app.example.com` (no path/trailing slash) for quote-route origin validation. Set to the actual deployed hostname; Preview/custom domains may need separate values. |
| `MARKET_MONITORING_ENABLED` | Optional, default on | `true` keeps sanitized temporary process-local events; `false` disables them. |
| `MARKET_RESOLVER_V2` | Optional, default on | Set `false` only for documented rollback of LKG/freshness compatibility behavior. |
| `METEORA_MARKET_ENABLED` | Optional, default on | Set `false` to disable Meteora comparison if its API becomes problematic; Jupiter pricing remains selected. |
| `MARKET_LIVE_MS`, `MARKET_DELAYED_MS`, `MARKET_STALE_MS` | Optional | Market display freshness thresholds; `.env.example` gives tested defaults. Do not lengthen to disguise stale values. |
| `METEORA_MIN_LIQUIDITY_USD`, `MARKET_DIVERGENCE_THRESHOLD_PCT` | Optional | Informational comparison gates; `.env.example` gives defaults. Neither changes selected Jupiter price. |
| `ADMIN_HEALTH_ENABLED`, `ADMIN_HEALTH_USERNAME`, `ADMIN_HEALTH_PASSWORD` | Optional; all 3 needed together | Keep disabled (`false`) for public demos unless HTTPS and a unique strong password are in place. Unlinked `/admin/health` and `/api/admin/health` return 404 when disabled; when enabled they use Basic auth and private/no-store security headers. Restrict access at the proxy too if available. |
| `PORT` | Host-provided | Next start uses host-supplied `PORT` or 3000. Production script binds `0.0.0.0`; do not hard-code a platform port. |

`PROBE_*`, `PROBE_TRACE`, `PLAYWRIGHT_BASE_URL`, and `PROBE_BASE_URL` are local verification inputs, **not deployment requirements**. Keep probe tracing off in production. Variables are read at runtime/build as used by Next; after changing cloud variables, deploy/restart and verify they took effect. Protect `APP_ORIGIN` and admin settings separately for Preview and Production environments.

## 4. Prepare GitHub without losing local work

1. Run `git status --short` and inspect every modified/untracked file. This workspace may contain legitimate user edits and dated evidence; **do not delete or reset them blindly**. Review exactly what will become public.
2. Confirm the secret file is ignored with `git check-ignore .env.local`; confirm `git ls-files .env.local` prints nothing. Check any already-tracked files, screenshots, logs, and `docs/evidence` for secrets or public addresses you do not want public. `.gitignore` cannot hide a file already tracked; deliberately remove it from the Git index only after verifying its target, and rotate a leaked secret before publishing.
3. Keep source, `package-lock.json`, `public/brand`, reviewed issuer catalog, tests, and only the three allowlisted public docs (`PRODUCT_GUIDE.md`, `METHODOLOGY.md`, `HOSTING_AND_RELEASE.md`). Exclude phase plans, old handoffs, prompts, local maintainer/submission notes, `docs/evidence`, generated `.next`, `node_modules`, test reports, coverage, `.vercel`, env files, and local logs. `.dockerignore` also trims build context and excludes all docs and secrets from container images. No existing evidence or user asset should be silently discarded.
4. Run the five checks below, `git diff --check`, then inspect `git diff --stat`, `git diff`, and `git status --short`. Stage **reviewed paths** (`git add <paths>`), inspect `git diff --cached --stat`, then commit. Create a private GitHub repository first if evidence/privacy review is incomplete; add your own remote URL and push the chosen branch. This runbook does not assume a remote exists or push automatically.
5. Use GitHub branch protection/secrets as needed. Do not use a screenshot with real wallet data without consent. After publishing, clone into a fresh directory and run `npm ci && npm run build` to prove no ignored local file was secretly required.

## 5. Validate locally before choosing a host

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run test:ui
```

Start a production build with `npm run start` (for an isolated smoke test set `PORT=3100` in the process environment first; PowerShell: `$env:PORT='3100'; npm run start`). Open `/` and verify: Live is initially selected and no sample values appear; Sample works only after click; Market analysis is disabled; no-wallet Stocks loads and the worker warms over several batches; Portfolio/Exposure/Protect work with a tested public address; stale/missing provider fields remain explicit; images show issuer logos or initials fallback; both themes and mobile widths work. The upstream market and RPC calls are non-deterministic, so mocked browser tests are not a substitute for these live checks.

## 6. Deploy one persistent Node instance

### Render Node Web Service

1. Connect the reviewed GitHub repository; choose **Web Service**, not Static Site. Select a region with reasonable Solana/Jupiter latency, Node 22.14+ runtime, and **one instance**. Avoid a sleeping Free tier for a live demo with an always-warm market claim.
2. Build command: `npm ci && npm run build`. Start command: `npm run start`. The start script listens on `0.0.0.0`; Render supplies `PORT`.
3. Add the environment variables above under service settings. Set `APP_ORIGIN` to the final HTTPS URL after creating the domain, then redeploy/restart. Enable auto-deploy from the chosen branch only after tests pass.
4. Confirm logs show a successful start. Open Stocks without a wallet; wait through a complete six-batch cycle, checking cached count and source freshness. Test one public-address Live read and quote-only path. Restart the service once and verify transparent warm-up rather than a fake live price.

### Railway Node service

1. Create a project from the reviewed GitHub repo, using one Node service and **one replica**. Verify the selected plan keeps the process running for the demo period and set a spend limit if relevant.
2. Use `npm ci && npm run build` and `npm run start` (or the detected equivalents); expose/generate an HTTPS domain and let Railway supply `PORT`. Do not deploy as a static frontend.
3. Add server variables to that service; set `APP_ORIGIN` to its final HTTPS domain. Deploy, then perform the same warm-up, public-address, restart, and mobile checks as for Render.

### Docker on a VM/container host

The included Dockerfile is a straightforward Node 22 build/run image. It intentionally copies the production build and its dependencies rather than introducing a new Next standalone build mode. It has **not** been given a shared distributed cache. Build and run **one** container; inject secrets at runtime, never via `Dockerfile`, image layers, `--build-arg`, or committed env files.

```bash
docker build -t positionlayer:release .
docker run --rm -p 3000:3000 --env-file /secure/path/positionlayer.env positionlayer:release
```

Put the container behind an HTTPS reverse proxy/load balancer. Configure the domain, secure admin route, host restart policy, memory, and outbound HTTPS to the Solana RPC, Jupiter, xStocks, and Meteora. Run one replica until the shared-worker architecture described in §2 exists. The supplied Dockerfile is optional; the same Node build/start commands work directly on a VM.

## 7. Vercel: honest preview path, not the recommended full-scale path

Vercel can build the Next app and serve route handlers, but the **current process-local interval worker, provider queues, and health history cannot be assumed durable or shared** across Vercel Function instances. Do not fix this by a per-visitor timer, repeated page fetches, or a cron per batch. To experiment, import the repo as a Next.js project, use `npm ci`/`npm run build`, add each server variable in Project Settings → Environment Variables for the appropriate Preview/Production scope, deploy, and test each route's function/bundle/duration limits. `/api/portfolio` and quote reads declare up to 180 seconds; actual availability is bounded by your current Vercel plan/configuration. Set `APP_ORIGIN` to the specific deployment origin and redeploy after variable changes. Keep health disabled on a public preview unless protected. Label market observations as partial/warming as rendered; **do not advertise continuous 300-mint refresh or global keyless request coordination on Vercel**.

For full-equivalence Vercel hosting, a separate authorized implementation must move the price producer to a continuously running service or durable scheduler, store normalized data and provider-budget state in a shared cache, make Vercel routes read that cache, enforce one producer via lease/lock, and verify cost, consistency, failure recovery, and privacy. That is a functional architecture change and is **not included** in this release.

## 8. Post-deployment acceptance and rollback

- Open the HTTPS site in a clean browser: default Live, empty wallet prompt, explicit Sample, public Stocks unaffected by wallet read failure. Check `Market analysis · Soon` cannot be activated.
- Exercise Stocks load/reload/filter/page/detail with one and two browsers. On a single host, page reads should use one worker, not one provider cycle per visitor. Inspect the worker's cached/target counts and 429/backoff states; not every mint is guaranteed an available Jupiter price.
- Test a known public address without signing; compare Overview/Portfolio/Exposure reconciliation and loan meter. Check protection plan and quote-only evidence. Confirm no transaction bytes or submission route are present.
- Test an upstream failure or disable the network in a controlled staging test: existing validated observations preserve their timestamp and eventually become stale/unavailable; Live never turns into Sample.
- Check `GET /admin/health` and `/api/admin/health` are 404 when disabled, 401 without auth when enabled, and private/no-store when authorized. This page must generate **zero** upstream reads.
- Check mobile, keyboard focus, official-logo fallback, image host availability, Next logs, upstream egress, memory, and restart/cold-start behavior. Set the final `APP_ORIGIN`, DNS, TLS, and redirect rules before sharing links.
- If market provider coverage degrades, use the existing `METEORA_MARKET_ENABLED=false` rollback only for Meteora comparison; use `MARKET_RESOLVER_V2=false` only with explicit understanding of its older price-retention semantics. Roll back the Git revision if a broader code regression occurs. Never silently relax freshness thresholds to hide the issue.

## 9. Non-goals and release risks

This runbook does not provision an RPC subscription, guarantee public-provider quotas, deliver 300 live prices, license original-company market caps, keep an idle free host awake, or add shared caching. The user must confirm provider usage rights and hackathon rules. Financial calculations are explainers, not liquidation guarantees. Report any live failures with source/time/status while protecting wallet addresses and credentials.
