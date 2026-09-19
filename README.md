# PositionLayer

### When Wall Street closes, your loan doesn't.

PositionLayer is a read-only Solana portfolio and loan-risk workspace for tokenized stocks. It turns a public wallet address into a reconciled view of holdings, issuer-confirmed xStocks, Jupiter Earn and Lend positions, company exposure, and hypothetical protection plans. The public Stocks market works without a wallet.

> No signing, transaction construction, submission, trading, or funds movement. A Jupiter liquidity check is a user-triggered quote-only read, not an order.

## Explore the product

| Workspace | What it answers |
| --- | --- |
| **Overview** | What is my covered value, free USDC, debt, net equity, highest-risk loan, and largest company exposure? |
| **Stocks** | Which issuer-confirmed Solana xStocks have market observations, liquidity, and source-backed details? |
| **Portfolio** | Where is every wallet, posted-collateral, Earn, borrow, indexed, or excluded position counted? |
| **Exposure** | Which companies and sectors appear directly and through verified ETF look-through? |
| **Protect** | How would a hypothetical stock shock affect a loan, and what USDC repayment would reach a target LTV? |
| **Market analysis** | Coming soon. The navigation item is intentionally disabled. |

Live is the default. Connect a Solana Wallet Standard wallet or paste a public address for read-only analysis. **Sample** opens only when selected; reloading does not silently restore sample data. Stocks is wallet-independent.

## Why it is different

- Exact Solana mint matching separates issuer-confirmed xStocks from unrelated token names. The selected market price comes from Jupiter Price V3; issuer marks and Meteora pool observations retain separate labels and cannot silently replace it.
- A shared, process-local worker rotates **six sequential, keyless batches of 50 mints** through a 300-asset issuer universe. A page reload reads cached results rather than restarting the worker. Missing observations stay unavailable or visibly aged; they are never zero-filled.
- Protocol LTV uses Jupiter's loan accounting/oracle basis, not a public token price. Stale, invalid, or unsupported risk inputs fail closed.
- Portfolio and exposure totals avoid double-counting receipt tokens, posted collateral, Earn underlying assets, and indexed comparison records.
- Six-hour, sanitized, bounded monitoring is available through an optional protected `/admin/health` page. It is process-local and never persists indefinitely.

## Run locally

Node.js **22.14+** and npm are required.

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. No `.env.local` is required for Sample or the keyless public-market path. For Live, copy `.env.example` to `.env.local` and configure `SOLANA_RPC_URL` if the public Solana endpoint is too constrained. `JUPITER_API_KEY` is optional and server-only. Never add private keys or seed phrases.

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:ui
```

The production start command binds to `0.0.0.0` for container/platform hosting:

```bash
npm run build
npm run start
```

## Deployment fit

For the **current architecture**, use **one continuously running Node.js instance** with HTTPS, such as a persistent Node web service, a VM, or the included Dockerfile. The 300-mint price worker, provider queues, caches, quote throttling, and temporary health logs are in memory in that one process. Free services that sleep can work for a demo but lose warm prices on restart. **Vercel Functions and multi-instance replicas are not equivalent full-scale deployments** until a durable single-leader worker and shared cache/rate limiter are built. Do not claim an always-warm 30-second refresh there.

Follow [Hosting and release](docs/HOSTING_AND_RELEASE.md) for GitHub, Vercel, Render, Railway, Docker/VM steps, exact variables, verification, and limitations.

## Documentation

- [Official product and feature guide](docs/PRODUCT_GUIDE.md)
- [Hosting and release checklist](docs/HOSTING_AND_RELEASE.md)
- [Methods and source limitations](docs/METHODOLOGY.md)

Phase plans, review evidence, and local maintainer/submission notes are kept locally and intentionally excluded from the public repository.

This project is an analytical prototype, not investment advice, a brokerage, an automated monitor, or a liquidation-prevention guarantee. Data quality and access depend on the named providers; unavailable fields remain explicit.
