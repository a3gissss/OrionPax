# mint-engine

Local multi-wallet (1–10) mint engine for NFT drops and token launches on Solana, Ethereum, Base and Robinhood Chain, driven from a local web dashboard.

## Layout
- `packages/core` — shared types (`ChainAdapter`, `TxRouter`, `WalletSigner`, `MintJob`, `EngineEvent`), dashboard API contract, mocks. **All cross-package imports go through `@mint-engine/core`.**
- `packages/wallets` — encrypted keystore
- `packages/chain-solana-nft`, `chain-solana-token`, `chain-evm-nft`, `chain-evm-token` — `ChainAdapter`s
- `packages/router-solana`, `router-evm-l1`, `router-evm-l2` — `TxRouter`s
- `packages/watcher` — go-live triggers
- `packages/engine` — job orchestration
- `packages/fixtures` — local test contracts/programs + wallet funding
- `apps/server`, `apps/web` — dashboard
- `docs/` — routing review

## Dev
```bash
npm install
npm run build
npm test
npm run chains:up   # local solana-test-validator + anvil chains (Docker)
```
Tests only ever target local chains. Never commit keys.
