# mint-engine

Local multi-wallet (1–10) mint engine for NFT drops and token launches on Solana, Ethereum, Base and Robinhood Chain, driven from a local web dashboard.

How each chain orders mint transactions, and how the engine routes for each: [docs/routing-review.md](docs/routing-review.md).

## Quick start

```bash
npm install
npm run build
npm run build -w @mint-engine/web      # dashboard UI, served by the server
```

**1. Create a wallet vault** (passphrases and keys are typed at a hidden prompt, never passed as arguments):

```bash
npm run vault -w @mint-engine/server -- init --vault ../../wallets.keystore
npm run vault -w @mint-engine/server -- generate evm "Main EVM" --vault ../../wallets.keystore
npm run vault -w @mint-engine/server -- import solana "Main SOL" --vault ../../wallets.keystore
npm run vault -w @mint-engine/server -- list --vault ../../wallets.keystore
```

Back up `wallets.keystore` **and** your passphrase. There is no recovery.

**2. Configure chains:** copy `mint-engine.config.example.json` to `mint-engine.config.json` (gitignored, since RPC URLs often hold API keys) and keep only the chains you use.

**3. Start the dashboard:**

```bash
npm run start:real -w @mint-engine/server
```

Open the printed `http://127.0.0.1:4810/#token=…` URL, unlock the vault, and create a mint job. The server binds to 127.0.0.1 only and needs the per-run session token.

Without `--config`, `npm run dev -w @mint-engine/server` starts with fake wallets and chains, for trying the UI.

## Layout
- `packages/core`: shared types (`ChainAdapter`, `TxRouter`, `WalletSigner`, `MintJob`, `EngineEvent`), the dashboard API contract, Jito tip accounts, mocks. All cross-package contracts go through `@mint-engine/core`.
- `packages/wallets`: encrypted keystore (scrypt + AES-256-GCM)
- `packages/chain-solana-nft` (Metaplex Core Candy Machine), `chain-solana-token` (pump.fun-style curves), `chain-evm-nft` (SeaDrop / Zora 1155 / ERC721A / custom), `chain-evm-token` (bonding curve / Uniswap V2): `ChainAdapter`s
- `packages/router-solana` (fan-out + Jito), `router-evm-l1` (public fan-out, Flashbots-style private relay and bundles), `router-evm-l2` (Base + Robinhood sequencer fan-out): `TxRouter`s
- `packages/watcher`: go-live triggers (time, state-poll, slot/block)
- `packages/engine`: job orchestration, pre-arming, crash-safe ledger (no double mints), retries
- `packages/fixtures`: local test contracts and helpers
- `apps/server`: dashboard API + real backend + vault CLI; `apps/web`: dashboard UI

## Known limits
- **pump.fun:** the bundled launchpad definition matches pump.fun's older buy layout; the live program needs its own `LaunchpadDefinition` before Solana token launches will work on mainnet.
- **Event triggers** aren't wired to chain subscriptions yet; use `time`, `state-poll` or `slot-or-block`.
- **Candy Machine guard groups** aren't supported yet; CAPTCHA (gatekeeper) and third-party-signer guards are refused by design.
- **Restored jobs** (after a crash) are reported but not auto-resumed. Wallets already sent are never re-sent.

## Tests

```bash
npm test                                   # unit tests, all packages
npm test -w @mint-engine/web               # dashboard component tests
npm run chains:up                          # local chains (Docker)
npm run e2e -w @mint-engine/<package>      # per-package e2e against local chains (see each package)
E2E_BASE_RPC=http://127.0.0.1:8546 npm run e2e -w @mint-engine/server   # full flow
```

Tests only ever target local chains. Never commit keys.
