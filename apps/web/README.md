# @mint-engine/web: dashboard

A Vite + React + TypeScript dashboard for the mint-engine server. It uses the contract in
`@mint-engine/core` (`api.ts`). The server listens on `127.0.0.1:4810`; REST lives under `/api/*` and the live stream is at `/ws`.

## Scripts

| command | what |
|---|---|
| `npm run dev -w @mint-engine/web` | Dev server; proxies `/api` and `/ws` to `127.0.0.1:4810` |
| `npm run dev:mock -w @mint-engine/web` | Dev server on `127.0.0.1:22245` with an in-process fake API and WS stream (no server needed) |
| `npm run build -w @mint-engine/web` | Typecheck + production build to `apps/web/dist` |
| `npm test -w @mint-engine/web` | Vitest + Testing Library component tests (jsdom) |

In mock mode the session token is `mock-session-token`. Any passphrase unlocks the vault except `wrong`, which is rejected.
The mock has 12 EVM wallets and 4 Solana wallets. An NFT quantity above 5 makes every tx fail, so you can see failure paths.
The `time` trigger waits at most 8 seconds.

## Panels

- **Vault & wallets**: lock and unlock the vault. Shows a wallet table with label, family, address (with copy) and native balances per chain.
- **New mint**: pick a chain (Solana, Ethereum, Base, Robinhood) and a kind:
  - NFT: address, quantity, style, token id.
  - Token launch: token, launchpad, spend per wallet, slippage.

  Wallets are a multi-select capped at 10 and filtered by the chain's family.
  Fees: priority fee, Jito tip on Solana, max fee per gas on EVM, a max total fee cap, and private submission on Ethereum.
  Triggers: now, time, state poll, event, or block/slot.
  You enter amounts in human units (SOL/ETH/gwei); the request carries them as base-unit decimal strings.
  A pre-flight summary is shown before submitting.
- **Jobs / Timeline / Event log**: the job list shows status and confirmed counts, with a cancel action.
  The per-wallet timeline tracks prepared → signed → sent → preconfirmed → confirmed/failed, with timestamps, +ms deltas, and tx ids with copy buttons. It is driven by WS `tx.status` events.

Keyboard: `Alt+N` focuses the form, `Ctrl+Enter` opens the review and confirms it, `Esc` goes back from the review.
`Alt+J` focuses the jobs list, where `↑/↓` (or `j/k`) select a job and `x` cancels it. `Alt+L` locks the vault.

## Auth and transport assumptions (to match `apps/server`)

- The user pastes the session token once. It is stored in `sessionStorage` and sent on every REST call as `x-session-token`.
  A `401` drops it and returns to the token screen.
- Browsers cannot set headers on a WebSocket, so the token travels as a subprotocol.
  The client offers `Sec-WebSocket-Protocol: mint-engine, token.<base64url(token)>`, and the server should select `mint-engine`.
- `GET /api/wallets` and `POST /api/jobs` return `423` while the vault is locked. A wrong passphrase on unlock returns `403`.
  Errors are JSON bodies of the form `{ "error": string }`.
- Balances in `WalletView.balances` are base units (lamports or wei) as decimal strings.
- On `job.created` for an unknown job, the client re-fetches `GET /api/jobs`.

`@mint-engine/core` is resolved from source (a Vite alias and a tsconfig path), so the app does not import from `dist`.
The Vite config itself loads the mock plugin through Node, so the scripts run `tsc -b packages/core` first.
