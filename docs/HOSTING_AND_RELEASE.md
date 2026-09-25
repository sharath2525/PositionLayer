# PositionLayer — GitHub, hosting, and release runbook

Last reviewed: 2026-09-25. This guide matches the current code and does **not** assume that a serverless function can run a continuous background worker. Recheck provider quotas and host terms before release. No deployment or Git push is performed by this file.

**Release state:** this `.public-release` checkout tracks [`sharath2525/PositionLayer`](https://github.com/sharath2525/PositionLayer) on `main`. The latest local code has been copied here for review, but this update has **not** been committed, pushed, or deployed by Codex. Local Canonical pricing and application checks passed previously; public deployment acceptance has **not**. There is no verified always-on writer URL or Vercel reader URL yet. Do not announce a public live app or set the Canonical preview as the Production default until the host checks below pass. The approved Current market remains the default/rollback meanwhile.

**Current data limitation:** the issuer catalog and price batches can work while Jupiter's separate Tokens V2 stocks-tag enrichment is unavailable. On 2026-09-25, the local catalog had 1,120 exact mints and a completed 23-batch price cycle returned 167 token prices with zero failed batches, but the stocks-tag feed contributed zero records; a direct read-only check of that endpoint returned HTTP 429. Liquidity, 24-hour volume, and separately reported token caps therefore remained unavailable. A browser reload, faster price batching, or Vercel deployment will not fill these metadata fields. The covered Solana cap additionally requires verified Solana-circulating supply, and original company cap requires a qualifying company data source; neither is implemented. Preserve the unavailable labels rather than advertising zero as economic truth.

## Immediate Canonical price check (2026-09-25)

If Canonical preview shows a catalog but **0 token prices**, expand **Full catalog and provider coverage** and inspect `Price targets / attempted / returned` and the footer's cycle state. `921 / 0 / 0` with `idle`, `source: bundled`, and no snapshot means **no canonical price writer has run**; it does not mean Jupiter priced zero assets. In the observed local case, the separate approved Current market already had over 160 valid Price V3 observations. The reviewed 921-mint fallback supplies identities, not prices.

For one **local development process** only, set `MARKET_V2_WRITER_ENABLED=true` in ignored `.env.local`, leave `MARKET_V2_WRITER_ORIGIN` unset, and fully restart `npm run dev -- -p 3010`. The startup instrumentation—not a browser request—starts the writer. Wait for a complete cycle (about 19 serial batches for 921 candidates, plus provider latency/backoff). Check `/api/markets/v2/stocks?pageSize=1`: `prices.cycleState` should progress to `running` then `complete`, `summary.priceAttemptedMintCount` should become positive, and `summary.priceReturnedMintCount` is the number of valid token observations. The UI sorts observed token prices first when available. Never require all 921 mints to have a price: Jupiter may omit illiquid assets or return reference-only stock data. Do not use a browser reload, Sample values, or issuer indicative prices as a substitute.

For public hosting, **do not copy that local setting onto Vercel**. Deploy one continuously running, single-replica Node writer with `MARKET_V2_WRITER_ENABLED=true` and no reader origin. Verify a completed cycle there. On Vercel/web set `MARKET_V2_WRITER_ENABLED=false` and `MARKET_V2_WRITER_ORIGIN=https://<writer-host>`. Verify the website API reports the writer's same `prices.snapshotId`, attempted/returned counts, and a non-bundled source. If it remains `bundled / idle / 0`, the origin is unset, unreachable, or pointing at another reader. Keep `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW=false` until these checks pass. A writer restart or sleeping free host produces an honest cold-start gap; no in-memory-only topology can promise continuous prices through that gap.

Local proof after enabling the ignored `.env.local` flag and restarting port 3010 on 2026-09-25: the reviewed fallback first completed `19/19` batches with `921` attempted and `165` valid Jupiter token prices. After the issuer-schema fix and a clean restart, the live issuer supplied `950` records and the catalog held `1,120` exact mints. The completed price snapshot attempted `1,119` active mints in `23/23` serial batches: `167` valid token prices, `952` provider omissions, `0` failed batches. Two sequential page reads returned the same completed snapshot ID, with no page-triggered price cycle. These are **local** observations, not public-host acceptance or a guarantee of a fixed count. The issuer API omitted `underlying.type` on many exact Solana mints; the adapter retains those as `unknown` class, never upgrading them to calculation-eligible equities. Jupiter-tag enrichment can fail independently, leaving liquidity/reported-cap coverage unavailable while token prices work. `Current market` stayed independent. The price-first UI sorts by availability then name, not by largest raw quote.

Local validation after that fix: 318 unit tests, TypeScript, ESLint, and the production build passed. The 36 ordinary browser tests passed against a production server; the four opt-in Canonical preview browser tests passed against a development server where the comparison switch is available. Browser tests exercised mobile/desktop, failure/recovery, missing logos, keyboard navigation, Sample/Live separation, and read-only routes. These do not replace the required public-host acceptance steps below. A cold restart also reset the approved Current market's in-memory prices; its independent six-batch worker was observed warming again while Canonical continued to read its published snapshot.

## 1. Pick the topology first

**Recommended for the current hackathon build:** one continuously running Node.js 22.14+ process behind HTTPS, with one replica and enough memory for Next.js plus the in-process catalog/price cache. This can be a Node web service, Docker container, or VM. A visitor opens the market route, the shared 300-mint Price V3 worker starts, and six sequential batches of 50 continue while that Node process stays alive. No browser reload starts another worker in that process. It does **not** make a 30-second freshness guarantee under upstream latency, rate limits, process restart, or host sleep.

| Host option | Current app fit | Important trade-off |
| --- | --- | --- |
| Persistent single-instance Node/Docker/VM | **Recommended**; full current functionality | One instance is a scaling ceiling; protect with rate limits, monitor upstream budgets |
| Render Node Web Service | Fits when it remains running as one instance | The Free instance sleeps after 15 idle minutes and can restart; warm prices and six-hour health history reset. Render warns that free services are not for production and may suspend unusually high outbound traffic. |
| Railway Node service | Can fit as one always-running service if the chosen plan actually keeps it running | Verify current plan, spend limits, sleep/restart behavior, and single-instance setting; do not assume free sustained runtime. |
| Vercel Functions | Website/reader only when paired with one proven persistent market host | Function memory/timers/global state are not a durable singleton. Set the fixed writer origin and leave the v2 writer disabled; both Stocks routes read the market host. Portfolio reads still depend on function duration/bundle limits. Do not run either market worker on Vercel. |
| Static site (`out`, GitHub Pages, static Render) | **Not compatible** | Portfolio, market, health, and quote route handlers require Node. |

Official hosting references: [Next.js self-hosting and multi-instance caching](https://nextjs.org/docs/app/guides/self-hosting), [Render Next.js web service](https://render.com/docs/deploy-nextjs-app), [Render Free restrictions](https://render.com/docs/free), [Railway Next.js guidance](https://docs.railway.com/guides/fullstack-nextjs), [Vercel Function limits](https://vercel.com/docs/functions/limitations), [Vercel environment variables](https://vercel.com/docs/environment-variables). Host limits and costs can change; verify current terms rather than relying on this dated summary.

## 2. Know the hidden state before you scale

The **market worker, prices/last-known-good, provider request queues, issuer/Meteora/Lend caches, quote throttling, and six-hour monitoring are `globalThis`/in-memory state in `src/services/stocks-market.ts` and related services**. The reviewed `issuer-catalog-snapshot.json` is bundled identity data, not a live price store. Next.js's own page/data cache and the 15-second public HTTP `s-maxage` are separate; a CDN hit does not update the worker. A process restart loses warm price and health state, although issuer identities can still load from the snapshot. A second server replica does **not** share the first replica's cache or rate-limit budget and may double requests. A browser refresh only reads the same process cache when it reaches that same living process.

For **true horizontal scaling** in a later authorized project: extract one durable/scheduled price worker, elect/lock exactly one producer, put normalized observations/TTL and provider rate budgets into a shared store, make all web replicas read that store, coordinate catalog and health ownership, and add load/concurrency/failover tests. A Next `cacheHandler` alone does not move this custom `globalThis` worker or its queues. Do not add Redis, paid services, cron polling, or a second worker just by flipping a deployment setting.

## Phase 6 versioned market preview

The new `/api/markets/v2/stocks` and `/api/markets/v2/assets/{canonicalAssetId}` endpoints are additive. The existing Stocks UI and `/api/markets/stocks` remain the rollback path. On a cold writer process it serves the dated reviewed catalog with explicit unavailable prices. Set `MARKET_V2_WRITER_ENABLED=true` **only** for a tested single persistent Node process to start one process-local issuer refresh and paced Price V3 writer at server initialization. The flag defaults to `false`; leave it false on Vercel Functions and multi-replica hosts. A larger catalog does not guarantee more live Jupiter prices: Price V3 can omit illiquid mints and provider outages are shown as degraded rather than replaced with Sample data.

The v2 writer targets active, conflict-free, issuer-confirmed exact Solana mints for **display-only** price observations, even when security class is unknown. Strict equity/ETF eligibility remains separately gated. It batches at most 50 exact mints with at least 2.1 seconds between request starts. The v2 API returns canonical and mint counts separately, failed/omitted prices, actual cycle completion, and capped server-side pages. Solana-only circulating supply and approved company-cap evidence are not available; those cap fields remain explicitly unavailable. Do not describe the dated reviewed catalog's unclassified mints as verified U.S. stocks.

Price V3 can return a record containing `stockData` without a valid token `usdPrice`/`blockId`. The adapter now omits **that mint only** and keeps other validated prices in the same batch; it never substitutes `stockData.price` for a token-market observation. A live local smoke check on 2026-09-25 published 19 serial batches for 914 active exact mints with 158 valid token prices and 756 individually unavailable observations. These counts vary with issuer inventory and Jupiter market coverage; they are not a production-host SLA or proof that all 914 are classified U.S. stocks.

### Phase 2 split deployment — one market host, website readers

The server-only `MARKET_V2_WRITER_ORIGIN` connects a website deployment to **one** persistent Node market host. On the market host, leave this origin unset and set `MARKET_V2_WRITER_ENABLED=true`. It owns the completed canonical price snapshots and the approved legacy Stocks cache. During a new v2 cycle, the last *completed* snapshot remains readable. Both the v2 writer and legacy 300-mint worker use the same keyless Jupiter gateway queue **within that one process**. Keep exactly one Node replica: the process-local lease cannot elect a writer across replicas.

On a Vercel/web reader, set `MARKET_V2_WRITER_ORIGIN=https://<persistent-market-host>` and `MARKET_V2_WRITER_ENABLED=false`. Both legacy and canonical Stocks routes read their matching fixed API paths from the market host. The bridge validates the normalized response with Zod, enforces a byte cap and 15-second timeout, rejects redirects, and deduplicates equal concurrent requests for five seconds within a website instance. It cannot proxy arbitrary URLs. Browser reload/filter/page/detail requests do not start either market worker on the website instance. Wallet and portfolio routes are not sent through the market host. On market-host failure, **both** Stocks views fall back to searchable dated reviewed identities with unavailable live prices/intelligence rather than starting duplicate provider workers. Other application routes remain independent.

This is **not** a durable shared store. The market host's snapshots, last-known-good observations, and six-hour health logs remain in memory and reset on restart. A website reader does not hold a durable, cross-instance copy. Render Free sleeps after 15 idle minutes and may restart with empty memory, so it does **not** satisfy an uninterrupted freshness promise. Use an actually always-running one-replica host or accept cold-start gaps. Keep canonical opt-in and legacy rollback until real host acceptance passes; no unit test proves live provider coverage.

Deploy in this order: (1) build and deploy the same commit to a one-replica persistent Node HTTPS host with writer enabled and reader origin unset; (2) wait for a complete v2 cycle and record actual target/batch/returned/omitted counts; (3) deploy Vercel/web with writer disabled and fixed writer origin; (4) compare both `/api/markets/v2/stocks` responses, then reload/filter/page/detail from multiple browsers and confirm writer Jupiter request counts do not rise per visitor; (5) check the approved legacy Stocks view and wallet views; (6) simulate a temporary market-host outage and confirm explicit reviewed-catalog fallback in both Stocks views, then restore; (7) rehearse switching the UI to Current market and turning the preview flag off. Never claim deployment acceptance without these live checks.

## Phase 7 canonical UI Preview and release gate

The Stocks workspace now contains an **opt-in Canonical preview** comparison in development. The approved current market is still the default and one-click rollback. `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW=true` is a **non-secret build-time Preview setting** that selects the canonical view by default; set it only on a dedicated Preview build while acceptance is underway. Leave it `false` in Production until the host, source, and rollback checks below pass. The canonical view reads `/api/markets/v2/*` only, shows one row per canonical underlying, and reveals every exact-mint variant in detail. Search/filter/sort/page/detail are snapshot reads and do not start a provider cycle. Its count of issuer-confirmed mints is **not** the count of classified U.S. equity/ETF underlyings. An unknown-class issuer mint stays searchable but is not promoted to an ordinary stock. The dated reviewed fallback currently contains more exact identities than it can classify as eligible ordinary securities; do not advertise the total as a live stock count.

On a tested **single persistent Node Preview instance** only, set `MARKET_V2_WRITER_ENABLED=true` and measure the actual active exact issuer mint targets, batch count, provider responses/omissions, 429 backoff, and price availability before asserting freshness. The price queue may observe unclassified issuer mints for **display only**; only the separate strict equity/ETF resolver permits sensitive calculations. The catalog and price writer are process-local. A browser reload, filter, page, or detail must not increase Jupiter batch requests beyond that one writer's schedule. Do not enable the v2 writer on Vercel Functions or multi-replica Preview. A Vercel reader may use `MARKET_V2_WRITER_ORIGIN` only after the persistent host passes the live checks above.

Preview acceptance sequence (record exact timestamps and counts; **do not infer success from mocked tests**):

1. Deploy a reviewed commit to one HTTPS Preview instance with `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW=true`, `MARKET_V2_WRITER_ENABLED=true`, and all server variables scoped to Preview. Confirm only one running Node replica; run a cold start with no wallet. Check `/api/markets/v2/stocks` responds with a dated fallback or previous complete snapshot before the first price cycle, never Sample data.
2. Wait for a complete published price cycle. Record active exact issuer price targets **separately** from strict calculation-eligible mints, batches, calls, start spacing (at least 2.1 seconds), duration, 429/Retry-After, omissions, failed batches, last-success timestamps, and `N/M` cap coverage. A 1,000-mint fixture is *not* proof of 1,000 live issuer-qualified mints or prices. If external sources are unreachable, record a **failed release gate**, not an invented success.
3. Open the same Preview in two browsers and exercise load, reload, search, all filters, both sort directions, paging, and a detail. Compare provider request counters before/after. They must reflect the single writer's schedule, not visitor count. Verify a stale value retains its original timestamp and becomes unavailable for sensitive use.
4. Exercise one optional provider failure at a time (issuer registry, Jupiter Price, liquidity metadata, Lend/reference source), then a controlled total upstream outage. The catalog remains searchable using a validated previous/bundled snapshot, each field has its own unavailable state, and recovery promotes a complete validated snapshot without a price or cap substitution.
5. Check mobile and desktop, light/dark themes, logo failure fallback, keyboard focus restoration, no-wallet, Sample, Live/public-address, Portfolio, Exposure, Protect, and loan Risk-O-Meter. Verify the v2 canonical detail does not send a wallet address to the public market API.
6. Redeploy/restart once. Observe cold fallback, warm-up, old complete snapshot behavior, CDN `Cache-Control`/response age, and no duplicate writer. With a process-local store, restart loses warm prices; this limitation must be acceptable for the chosen host or replaced by a verified shared store before cutover.
7. Rehearse rollback: select **Current market**, verify legacy `/api/markets/stocks` and all portfolio/protection views, then set `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW=false` on Preview and redeploy. Only after all gates pass may a separately reviewed Production build make the canonical path default. Keep the legacy path for immediate rollback.

## 3. Environment variables

Copy the *names* from `.env.example`; set values in your host's secret/variable UI. **Do not upload `.env.local` or paste it into GitHub.** The checked-in `.gitignore` and `.dockerignore` exclude `.env*` except `.env.example`. No private key, seed phrase, or server wallet is needed. Only the explicitly non-secret UI Preview switch below may use `NEXT_PUBLIC_`; never put provider keys or private RPC URLs in public variables.

| Variable | Required? | Production meaning |
| --- | --- | --- |
| `APP_CLUSTER` | Recommended | Must be `solana:mainnet`; other values are rejected by the current registry. |
| `SOLANA_RPC_URL` | Recommended for reliable Live reads | A private server-side mainnet HTTPS RPC URL with wallet token-account/indexed reads as required by the app. Default public Solana RPC is rate-limited and may fail. Treat embedded tokens as secrets. |
| `JUPITER_API_KEY` | Optional | Server-side Jupiter read/quote key. **Public Stocks Price V3 worker deliberately remains keyless**; a key does not make it a durable background service. |
| `APP_ORIGIN` | Recommended for public HTTPS origin | Exact browser origin such as `https://app.example.com` (no path/trailing slash) for quote-route origin validation. Set to the actual deployed hostname; Preview/custom domains may need separate values. |
| `MARKET_MONITORING_ENABLED` | Optional, default on | `true` keeps sanitized temporary process-local events; `false` disables them. |
| `MARKET_V2_WRITER_ENABLED` | Optional, default off | `true` starts the additive Phase 6 issuer/Price V3 writer in one persistent Node process only. Leave `false` on serverless or multi-replica deployments; the legacy public Stocks route is unaffected. |
| `MARKET_V2_WRITER_ORIGIN` | Optional, split deployment only | Server-only HTTPS origin of the *single* persistent market host. Set on Vercel/web readers, **never on the writer**. Both Stocks route families read that host instead of starting local market-price work. No path, query, credentials, or browser prefix. It must differ from `APP_ORIGIN`. |
| `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW` | Optional, default false | **Non-secret build-time flag.** `true` selects the canonical Stocks view by default in a dedicated Preview build. Keep false in Production until the Phase 7 deployment acceptance and rollback rehearsal pass. Changing it requires a rebuild/redeploy. |
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
4. Run the five checks below, `git diff --check`, then inspect `git diff --stat`, `git diff`, and `git status --short` **inside `.public-release`**. Stage **reviewed paths** (`git add <paths>`), inspect `git diff --cached --stat`, then commit and push `main` to the existing `origin` only after you approve the diff. Do not run Git commands from the outer development checkout by accident; that is a different repository and branch.
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

## 7. Vercel website + one persistent market host

Vercel can build the Next app and serve the website/route handlers, but **must not own the process-local price worker**. The fixed-origin reader bridge is included in this release: both Stocks route families can read the one persistent market host. It is not a shared database, a distributed lease, or durable history. A host restart loses its warm prices, and a sleeping/free host can leave the website with dated identities but unavailable observations.

1. Deploy this same reviewed Git revision to **one continuously running Node replica** on a host such as Render, Railway, or a VPS. Set `MARKET_V2_WRITER_ENABLED=true`, leave `MARKET_V2_WRITER_ORIGIN` unset, set the server-side RPC and other required values from §3, and expose HTTPS. Verify `/api/markets/v2/stocks?pageSize=1` reports a completed price snapshot with positive attempted and returned counts. Confirm the approved `/api/markets/stocks` route works too. Do not scale this writer above one replica.
2. Import the GitHub repository into Vercel as a **Next.js** project, not a static export. On the Vercel website set `MARKET_V2_WRITER_ENABLED=false`, `MARKET_V2_WRITER_ORIGIN=https://<the-persistent-host>` (bare HTTPS origin, no path or slash), `APP_ORIGIN=https://<the-website-host>`, and the website's other server-only values from §3. Leave `NEXT_PUBLIC_MARKET_V2_UI_PREVIEW=false` for Production; it is a build-time value and changing it requires redeploying. Never place RPC URLs, Jupiter keys, or the writer origin under `NEXT_PUBLIC_*`.
3. After deployment, compare the Vercel and writer `/api/markets/v2/stocks?pageSize=1` responses: `prices.snapshotId`, attempted/returned counts, and catalog/source should agree. Reload and browse from two clients; those reads must not start new price cycles. If Vercel reports `bundled / idle / 0`, fix the writer origin/reachability rather than enabling a worker on Vercel. Also test `/api/markets/stocks`, a public-address portfolio, and Protect; `/api/portfolio` and quote routes still depend on the host's actual function duration/bundle limits.
4. Rehearse writer restart and outage. The website must keep its non-market features working and show explicit market unavailability without substituting Sample values. Check security headers, no-wallet access, mobile, logos, and the Current market rollback before sharing the URL. Provider quotas and the missing metadata/company-cap fields above remain separate release limitations.

Do not add per-visitor timers, Vercel cron per batch, or extra market workers to compensate for a missing writer. For multi-replica writer failover or durable price continuity, a separately reviewed shared store and distributed producer lease would still be needed.

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
