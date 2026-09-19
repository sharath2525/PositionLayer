# PositionLayer read-only methodology

## Amounts, identity, and sources

Every supported value carries an explicit unit and source. Wallet token amounts retain integer base units and mint decimals. Token-2022 scaled-UI amounts retain unscaled quantity, active multiplier, pending multiplier, effective time, and chain-time observation. Instruments are matched by verified mint/program/decimals and security identity, never by ticker alone.

Every source carries an ID, label, URL when available, observation/retrieval times, nullable slot range, source kind, and validity. Sample, issuer-snapshot, live, and hypothetical sources cannot silently substitute for one another. Live account snapshots become stale under the application’s two-minute visibility policy; this policy does not claim an oracle publication time.

Protocol valuation, reference exposure, and hypothetical stress are separate:

- **Protocol USDC valuation** drives LTV and liquidation risk.
- **Reference USD valuation** drives holdings and company/sector exposure.
- **Hypothetical stress** transforms the recorded protocol collateral for planning only.

Jupiter quote evidence is a fourth, separate basis. It answers only whether an exact free-wallet stock amount had a current route to expected USDC output; it never replaces protocol or reference valuation.

## Loan risk

For each supported loan, let C be protocol collateral value in USDC, D accrued debt in USDC, B maximum-borrow LTV, and T liquidation threshold.

```text
currentLtv = D / C
boundaryUsed = currentLtv / T
declineBuffer = 1 - currentLtv / T
healthFactor = T / currentLtv
```

No debt is a separate state: LTV is 0, boundary used is 0, decline buffer is 1, and health factor is displayed as no debt rather than infinity. Zero/negative collateral, invalid `0 < B < T < 1`, unsupported identity, liquidated/unreadable state, missing protocol values, stale/future/unverified sources, debt disagreement, or stored-LTV disagreement makes risk unavailable.

For a hypothetical collateral return r:

```text
stressedCollateral = C × (1 + r)
stressedLtv = D / stressedCollateral
```

A broad decline uses `r = -decline`. A company-through-ETF scenario uses the same verified composition as the Exposure screen. Unknown ETF weight stays unknown and is held fixed in the partial scenario; it is never treated as verified zero exposure.

## Protection target and cash

For target t and selected collateral basis Cbasis:

```text
estimatedRepayment = max(0, D - t × Cbasis)
```

The display amount is rounded upward to 0.000001 USDC. `availableUsdc` uses only verified, unfrozen, spendable free-wallet USDC; posted collateral, Earn deposits, unsupported assets, and hypothetical proceeds are excluded. Remaining cash and shortfall are shown independently, so an underfunded plan still communicates the required amount without claiming it is executable. Separate loan plans share the same cash and cannot be summed as funded commitments.

The plan retains snapshot ID, owner/mode/cluster, loan/vault/position identity, target and target basis, scenario, assumptions, unit, sources, times, slots, and coverage. A refreshed, changed, mismatched, stale, or expired snapshot invalidates the result.

## Protection-liquidity quote

Only an underfunded selected plan may quote verified, spendable, unpledged wallet stock. The input is an integer token base-unit amount bounded by `spendableRawAmount`; posted holdings always have zero spendable raw units. An initial estimate uses reference stock/USD and USDC/USD observations only when both are current and event-compatible. Up to three Jupiter observations refine that estimate. Every calculation uses `decimal.js`; the Token-2022 multiplier converts raw input to display units exactly once.

The upstream request is `GET /swap/v2/order?inputMint=…&outputMint=USDC&amount=…`. `taker` is absent, and the adapter requires `transaction === null`. Quote evidence expires at the earliest of 30 seconds, a provider expiry, or a pending multiplier event. A past, already-applied event does not expire a new observation. Quote output remains hypothetical: `currentCashAfterQuoteUsdc` must equal current cash. The result can be potentially covered, partially covered, no route, expired, unavailable, or not needed.

The browser sends a strict same-origin POST containing the snapshot and selected plan inputs. The server reconstructs the portfolio and plan, verifies the exact holding and balance, and returns a strict evidence record without provider request IDs or transaction bytes. Quote requests are queued and rate-limited. The selected pair and exact size are disclosed to Jupiter.

## Read-only and privacy boundary

Connecting a Wallet Standard wallet reveals its public address for reads. PositionLayer does not import or call signing features, construct transaction messages, return serialized transactions, submit signatures, or change balances. Wallet-specific browser calls use POST bodies and no-store responses; owner-specific upstream reads are also no-store. The browser remembers theme and the selected public read workspace locally so a reload can restore the view. No analytics, background monitoring, WebSocket, notification, or server-side portfolio persistence is added.
