# PositionLayer — official product guide

## Purpose and safety boundary

PositionLayer explains tokenized-stock holdings and Jupiter Lend borrowing risk on Solana mainnet. It is an analytical, read-only workspace. It does not connect to a brokerage, move funds, monitor a wallet in the background, guarantee liquidation avoidance, or offer investment advice. There is no signing, transaction build/bytes, submission, Swap execution, or Lend action. The one user-triggered Jupiter liquidity check requests a quote without a taker or transaction and does not change balances.

## Modes and navigation

**Live is the initial mode.** A connected Wallet Standard wallet supplies only its public address; alternatively, a user can paste a public Solana address. Selecting **Sample** explicitly opens illustrative fixture values. Sample is never substituted after a Live failure and is not automatically restored after reload. A watched Live public address can be restored locally in the same browser. The Stocks page needs no wallet in either mode.

**Market analysis** is marked Soon and disabled; it has no page or data request.

## Overview

Overview gives a short answer rather than a complete inventory: covered portfolio value, spendable wallet USDC, outstanding protocol debt, net equity or partial net equity, the highest-risk supported loan, three leading company exposures, important stock/ETF holdings, and verified stock/ETF underlying assets deposited in Earn. The highest-risk loan links to Protect; holdings link to Portfolio; company exposures link to Exposure. Unknown or unvalued positions are not presented as zero.

## Stocks — public market

The public market is built around **up to 300 issuer-confirmed Solana deployment mints**. Issuer identity is matched by exact mint, not symbol/name similarity. A bundled reviewed identity snapshot enables the catalog to remain visible during an issuer registry outage; live provider coverage is still labeled. The global process-local worker sends six sequential Jupiter Price V3 requests of up to 50 mints each, respects provider backoff, and shares validated observations across users of one Node process. Reloading the browser does not restart the cycle. The page supports bounded search, source-classified Equity/ETF/unclassified filtering, price-availability filtering, deterministic sort, and 20-row pagination.

The table distinguishes Price V3 from a Jupiter Tokens V2 **display-only reference**. Last-known-good observations preserve their original timestamp and move through live, delayed, stale, and unavailable states. A stale or reference-only price is not eligible for sensitive calculations. Liquidity, 24-hour volume, holder counts, and **tokenized** market cap are shown only where providers report them. The tokenized-cap summary is a **partial sum** over covered mints; it is not a company market-cap total. Original company market cap remains unavailable because no verified, licensed free equity-cap feed is configured. ETFs do not have company market caps.

Each asset detail separates identity, selected Jupiter observation, exact-mint Meteora DLMM/DAMM v2 liquidity/comparison evidence where eligible, issuer indicative reference and market/multiplier context, local wallet context, and data-quality/source links. Comparison returns AGREE, DIVERGED, or NOT_COMPARABLE with a blocker. It never averages prices. Estimated premium/discount appears only when the exact issuer mint, currency, unit, freshness, multiplier state, and halt gates pass. It is **not** arbitrage or executable profit. Jupiter Lend availability is an exact-collateral-mint match to a shared vault list, not a lending instruction. Supply and proof-of-reserve details identify their aggregation scope. Official issuer logos fall back safely to initials when unavailable.

## Portfolio and Exposure

Portfolio groups complete verified stock/ETF wallet and posted-collateral positions, cash/crypto, Jupiter Earn, supported and unmodeled borrow positions, other indexed protocol records, and unverified/excluded assets. Covered value includes wallet, posted collateral, and Earn underlying value once. Receipt tokens and indexed-only comparisons are excluded. Exposure combines verified direct, posted, Earn, and ETF routes by company and sector. SPY look-through uses dated issuer holdings; QQQ decomposition and unclassified sectors remain explicit coverage gaps. Market price is a reference valuation, separate from the Lend protocol oracle used for loan risk.

## Risk-O-Meter and Protect

For supported loans, the meter shows current LTV, maximum-borrow boundary, liquidation threshold, boundary used, decline buffer, and health factor. It uses validated protocol collateral/debt and refreshes visible Live risk views before the stale boundary. Invalid, stale, future-dated, unsupported, or missing values produce **Risk unavailable** rather than a fabricated reading. Protect runs hypothetical broad or company-specific shocks, compares current and stressed LTV, estimates a target repayment, and shows verified free-USDC coverage and shortfall. The scenario is not an action. A user may request a narrowly scoped Jupiter stock-to-USDC quote as short-lived liquidity evidence; quote expiry/failure is isolated from the plan.

## Monitoring and privacy

The optional Basic-auth-protected `/admin/health` shows sanitized provider health and recent transition events. Events are bounded to 5,000 entries/about 5 MiB, expire in at most six hours, and are not permanent or shared across processes. The page itself makes no upstream provider calls. Logs deliberately omit wallet addresses, request/response bodies, URLs, headers, credentials, signatures, and transaction material. Public-address Live reads are sent to the app's server and relevant Solana/Jupiter providers, so a public address is not anonymous to those services. Portfolio POST responses are private/no-store. Do not publish the admin credentials or expose the page without HTTPS.

## Failure semantics

Independent provider failures preserve successful sections when safe; stale/unavailable fields are clearly labeled. Live failure never falls back to Sample. An unavailable quote does not erase a valid protection plan. A missing Meteora pool is not treated as an incorrect Jupiter price. Provider recovery does not change an old timestamp retroactively. On restart, in-memory price/health state warms again; the reviewed catalog can remain visible while prices repopulate.

For formulas, source rules, and current data caveats see [Methodology](METHODOLOGY.md). For deployment requirements see [Hosting and release](HOSTING_AND_RELEASE.md).
