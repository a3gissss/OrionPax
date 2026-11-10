# Public mints and transaction routing: Solana, Ethereum, Base, Robinhood Chain

*Last reviewed: 10 November 2026. Written for the mint-engine project. On-chain landscapes change week to week; re-verify before relying on a number.*

**How to read this.** Every factual claim either cites a source or is marked **[unverified]**. "Verified" means it was checked against the linked page on the review date, with official docs preferred. Market-share figures come from third-party data or press and are the least stable part of this document.

---

## TL;DR

| | Solana | Ethereum L1 | Base | Robinhood Chain |
|---|---|---|---|---|
| Who orders txs | Current slot leader (≈0.4 s slots). Most stake runs Jito-Solana and accepts Jito bundles | Proposer, which in ~90% of blocks buys the block from a PBS builder via MEV-Boost relays | One sequencer (Coinbase). Since **Denim (5 Nov 2026)**: full 200 ms blocks, **ordered by priority fee** | One Arbitrum Nitro sequencer, **first-come, first-served**. Fees do not buy position |
| Mempool | None (txs are forwarded straight to upcoming leaders) | Public p2p mempool plus private orderflow (Flashbots Protect, builder RPCs) | Sequencer-private; no public p2p mempool **[unverified]** | Sequencer-private; FCFS queue |
| Fast means | Reach the leader early, set a priority fee or Jito tip, keep compute-unit (CU) usage tight | Land in the first block of the mint at a competitive tip, privately if possible | Get to the sequencer early in the right 200 ms block with a top priority fee | Lowest network latency to the sequencer. Nothing else helps |
| Key failure | Blockhash expiry (~150 blocks), dropped packets | Nonce gaps, underpriced or stuck txs, public-mempool sniping | Revert from sold-out or limit; data-availability (DA) throttling delays | Arriving late in the FCFS queue; reverts once sold out |
| Gas token | SOL | ETH | ETH | ETH |
| Chain id | n/a | 1 | 8453 | **4663** (testnet 46630) |

> **Two corrections to earlier project assumptions.**
> 1. **Base no longer has Flashblocks.** The Denim upgrade replaced the 200 ms Flashblocks preconfirmations with *complete canonical 200 ms blocks* on mainnet on **5 Nov 2026 18:00 UTC**. The Flashblocks streams stopped and there are no "preconfirmed" receipts any more. See [Base: 200ms blocks](https://docs.base.org/upgrades/denim/200ms-blocks) and [migrate from Flashblocks](https://docs.base.org/upgrades/denim/migrate-from-flashblocks).
> 2. **Robinhood Chain does not use Timeboost.** Its official docs describe a first-come, first-served sequencer where "increasing your fee will not shift your transaction ahead" ([Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum)). The docs never mention Timeboost or an express lane. Status: **not enabled**, inferred from the official docs' FCFS description. No explicit "Timeboost is off" statement was found.

---

## 1. Solana

### 1.1 Public-mint landscape

**NFTs.**
- The standard primary-mint path is **Metaplex Core** assets sold through **Core Candy Machine** with **Core Candy Guard**. The guards enforce start date, SOL payment, mint limit, allow list, bot tax, third-party signer and similar rules.
  - Program ids: Core `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` ([mpl-core](https://github.com/metaplex-foundation/mpl-core)), Candy Machine `CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J`, Candy Guard `CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ` ([mpl-core-candy-machine](https://github.com/metaplex-foundation/mpl-core-candy-machine), [Metaplex docs](https://metaplex.com/docs/core-candy-machine)).
  - Metaplex publishes an [anti-bot best-practices page](https://metaplex.com/docs/smart-contracts/core-candy-machine/anti-bot-protection-best-practices). Its guards (`mintLimit`, `botTax`, `thirdPartySigner`, `gatekeeper`) are the limits this engine must respect, never route around.
- Legacy Token Metadata Candy Machine v3 and Magic Eden's launchpad still exist. Their relative 2026 share is **[unverified]**.

**Token launches (bonding curves).**
- **pump.fun** remains the reference design: a virtual-reserve constant-product curve that graduates to an AMM.
- Competitors include **LetsBonk** (Raydium LaunchLab) and **Meteora Dynamic Bonding Curve (DBC)**.
- Share swings violently and depends on the measurement window:
  - Late Aug 2025 Jupiter snapshots put pump.fun anywhere from ~49% to ~73% ([CoinMarketCap Academy](https://coinmarketcap.com/academy/article/pumpfun-reclaims-90percent-market-share-in-solana-launchpad-war), [The Block](https://www.theblock.co/post/367266/solana-memecoin-launchpad-war-flips-again-as-pump-takes-top-spot-amid-letsbonk-collapse)).
  - **No reliable 2026 share breakdown was found [unverified].**

### 1.2 How a transaction travels

1. **Build and sign.** The client builds a tx with a recent blockhash plus `ComputeBudget` instructions (CU limit and price in micro-lamports per CU), then signs it locally.
2. **Standard path.** `sendTransaction` goes to an RPC node. The node forwards the tx over QUIC to the TPU of the current and next few leaders on the leader schedule. There is no mempool; if the packet isn't accepted, the tx simply never lands. RPC nodes rebroadcast until the blockhash expires unless you set `maxRetries`. **[unverified against solana.com: the docs site returned HTTP 429 during review.]** Stake-weighted QoS means connections through staked RPCs get priority **[unverified]**.
3. **Jito path.** You can send to a **Jito block engine** ([docs](https://docs.jito.wtf/lowlatencytxnsend/)):
   - `sendTransaction` proxies with MEV protection and always uses `skip_preflight=true`. Adding `bundleOnly=true` gives revert protection.
   - `sendBundle` takes **≤5 txs**, executed "sequentially and atomically" within one slot.
   - The **minimum tip is 1,000 lamports**, paid to one of **8 tip accounts** chosen at random. Don't put tip accounts in an Address Lookup Table (ALT).
   - The suggested split for `sendTransaction` is 70% priority fee and 30% tip.
   - Default rate limit: **1 request/s per IP per region**. Mainnet regions: Amsterdam, Dublin, Frankfurt, London, New York, Salt Lake City, Singapore, Tokyo.
   - **Uncle bandits:** a skipped leader slot can leak bundle contents, which are then rebroadcast without atomicity. Mitigations: put the tip in the same tx as the mint, and add pre/post account checks.
4. **Inclusion.** The leader's banking stage orders by priority (fee per CU) under account-lock contention. Jito-Solana leaders also run the bundle auction.
5. **Confirmation.** Commitment progresses processed → confirmed → finalized.

### 1.3 What "fast" means

- Sub-second slots make the competition about *being in the right leader's queue first*, not about out-bidding a mempool.
- Practical levers:
  - Fan out the send to several staked RPCs plus a Jito region near the leader.
  - Set a CU limit near the simulated usage, because a smaller CU request makes priority cheaper and more schedulable.
  - Set a competitive CU price and Jito tip.
  - Pre-build and pre-sign everything so firing is just I/O.
  - Watch the Candy Guard `startDate` or slot rather than polling the UI.

### 1.4 Failure modes

| Failure | Cause | Engine handling |
|---|---|---|
| **Blockhash expired** | `lastValidBlockHeight` = height at fetch + 150 blocks (blocks, not slots), so roughly 60–90 s ([Chainstack](https://docs.chainstack.com/docs/solana-how-to-handle-the-transaction-expiry-error)) | Re-fetch the blockhash, re-sign and resend. Never resend after expiry with the same signature expecting it to land. Durable nonces are an alternative for pre-signed txs |
| **Dropped** | Leader QUIC congestion or no stake-weighted path | Rebroadcast on a timer until `lastValidBlockHeight` |
| **Sold out / guard revert** | Candy Machine is out of items, or a guard (`mintLimit`, `startDate`, `botTax`) fires | Detect from logs and stop that wallet. Do not retry into a bot tax |
| **Front-running / sniping** | Bundles from other searchers on bonding-curve buys | Slippage bound (`minOut`). Jito `bundleOnly` for revert protection |
| **Account-lock contention** | Every minter writes the same Candy Machine account | Unavoidable; priority fee decides |

### 1.5 Cost model

- Base fee: 5,000 lamports per signature.
- Priority fee: CU price × CU limit.
- Optional Jito tip, minimum 1,000 lamports.
- The mint price itself, plus asset rent for the new Core asset account.
- Failed txs still pay the base fee and priority fee, except Jito bundles and `bundleOnly`, which only land if they succeed.

---

## 2. Ethereum L1

### 2.1 Public-mint landscape

- **NFTs.**
  - **OpenSea Drops / SeaDrop** ([SeaDrop docs](https://docs.opensea.io/docs/seadrop)) supports public drops, Merkle allowlists, server-signed mints and token-gated mints.
  - **Zora** 1155 editions with a fixed-price sale strategy, and **Manifold** creator contracts.
  - Plenty of custom **ERC721A** contracts exposing `mint(quantity)` with `price`, `maxPerWallet` and `saleActive`.
  - Primary-mint activity has largely moved to L2s, Base especially **[directional; source quality is low]**.
- **Token launches.** On L1, launches are mostly direct Uniswap pool creation. Bonding-curve launchpads are concentrated on L2s and Solana **[unverified]**.

### 2.2 How a transaction travels

1. A signed EIP-1559 tx goes either to the **public mempool** (gossiped to all nodes and visible to every searcher) or to **private orderflow**.
2. **Flashbots Protect** at `https://rpc.flashbots.net/fast` ([docs](https://docs.flashbots.net/flashbots-protect/overview)):
   - It sends txs to a private mempool hidden from frontrunning and sandwich bots.
   - It offers **revert protection**: you don't pay for failed txs.
   - It can pay MEV and gas refunds.
   - `/fast` shares with more builders for faster inclusion.
3. **PBS today is off-protocol (MEV-Boost).**
   - Builders assemble blocks from the mempool plus private flow and bundles, and bid to relays. The proposer of each 12 s slot picks the highest bid.
   - Roughly **~90%** of blocks go through MEV-Boost, and builder share is highly concentrated **[third-party data, varies by window]** (live data: [mevboost.pics](https://mevboost.pics/), [relayscan.io](https://www.relayscan.io/)).
   - **Enshrined PBS (EIP-7732)** is the scheduled headliner of the *Glamsterdam* fork but is **not live**; scope and date are still being settled ([EtherWorld](https://etherworld.co/glamsterdam-at-crossroads-whats-in-whats-out-whats-still-uncertain/)).
4. Inclusion happens at a 12 s slot boundary. Finality takes ~2 epochs (~13 min).

### 2.3 What "fast" means

- There is one inclusion opportunity per 12 s, so the target is **the first block in which the sale is open**.
- Levers:
  - Pre-sign at the correct nonce.
  - Fire as soon as `SaleStarted` or the scheduled block appears.
  - Use a priority fee that clears builders.
  - Send through Protect or builder RPCs so the tx is private and can't be sniped from the mempool.
  - Optionally send in parallel to the public mempool. This trades privacy for reach, and the router makes it configurable.

### 2.4 Failure modes

| Failure | Engine handling |
|---|---|
| **Nonce gap or collision** (a pending tx blocks later ones) | Per-wallet nonce manager. Replace-by-fee (same nonce, ≥10% higher fees) to un-stick **[10% bump is geth's default replacement rule; unverified for every client]** |
| **Underpriced / stuck** when base fee jumps during a hyped mint | Generous `maxFeePerGas` cap. Rebroadcast or replace |
| **Revert** (sold out, `maxPerWallet`, wrong value) | Simulate (`eth_call`) before firing. Private submission with revert protection avoids paying for failures |
| **Front-running / sniping** | Private relay. For mints the bigger risk is being out-bid in the same block, not a sandwich |

### 2.5 Cost model

- `gasUsed × (baseFee + priorityFee)` + mint price.
- On the public mempool, failed txs still pay gas. With Protect, a reverting tx is not included, so it costs nothing.

---

## 3. Base

### 3.1 Public-mint landscape

- **NFTs.** Zora 1155 editions, OpenSea/SeaDrop drops and custom ERC721A contracts, mirroring Ethereum. Relative share is **[unverified]**.
- **Token launches.**
  - **Zora coins** (creator/content coins). Zora led Base token creation counts in 2025 ([Decrypt](https://decrypt.co/332573/base-overtakes-solana-in-daily-tokens-created-as-pump-fun-continues-to-shrink), [The Block](https://www.theblock.co/post/365384/base-solana-zora)).
  - **Clanker**: Uniswap pools launched from Farcaster. Farcaster acquired it in Oct 2025, and it launched 200,000+ tokens in its first five months ([The Block](https://www.theblock.co/post/349549/clanker-team-earns-13-million-in-revenue-from-over-200000-tokens-on-base-in-just-five-months)). Press reports of record weekly fees in Feb 2026 are **[unverified]**.
  - **Flaunch**: a Uniswap v4 hook launchpad listed in the [Base launch-tokens cookbook](https://docs.base.org/cookbook/launch-tokens).
  - **No reliable 2026 market-share breakdown was found [unverified].**

### 3.2 How a transaction travels (post-Denim)

1. A signed EIP-1559 tx goes to a Base RPC and is forwarded to the **single sequencer**. There is no p2p public mempool to watch or snipe from **[unverified: Base's docs say only that `base_transactionStatus` "checks whether a transaction is in the node mempool" and that public endpoints reject it]**.
2. **Block building.**
   - Since **Denim (mainnet 5 Nov 2026 18:00 UTC; Sepolia 21 Oct 2026)**, `base-reth-node` builds "a complete canonical block every 200ms" ([200ms blocks](https://docs.base.org/upgrades/denim/200ms-blocks)).
   - Within a block, user txs are **"ordered by priority fee"** ([Transaction ordering](https://docs.base.org/specifications/transactions/transaction-ordering)). Each block starts with the L1-info deposit and a BaseTime deposit.
   - Order is final once a block is produced, because each 200 ms block is canonical with its own receipts. That replaces the old Flashblocks "locked order within a 200 ms sub-block" behaviour.
3. **Monitoring.**
   - Subscribe to `newHeads` / `logs`. The Flashblocks WS endpoints stay open but stream nothing.
   - The `pending` tag resolves to the latest canonical block.
   - `newFlashblocks`, `newFlashblockTransactions` and `pendingLogs` are retired ([migrate from Flashblocks](https://docs.base.org/upgrades/denim/migrate-from-flashblocks)).
   - New `timestampMs` and `blockTimestampMs` RPC fields give millisecond time.
4. **Timing caveat.** `block.number` now advances 5 blocks per second, so contracts that measure time in blocks behave differently.
5. Batches post to Ethereum, and L1 finality follows L1.

### 3.3 What "fast" means

- Land in the **first 200 ms block** after the sale opens, near the top of that block.
- Inside a block the order is set by **priority fee**. Arrival only decides *which block* you make.
- Levers: low-latency RPC (or your own node), pre-signed txs, a priority fee above the competition, and an event-driven trigger on `newHeads`/`logs`.

### 3.4 Failure modes

| Failure | Engine handling |
|---|---|
| **DA throttling** | Txs "can be delayed regardless of priority fee" during data-availability throttling ([Network fees](https://docs.base.org/specifications/transactions/network-fees)). Surface this as a warning, not a retry storm |
| **Reverts** (sold out, limits) | Simulate first. Reverted txs still pay L2 and L1 fees. No Protect-style revert protection was found in Base's public docs **[unverified]** |
| **Nonce gaps** | Same as Ethereum |
| **No preconfirmations** | `TxStatus = "preconfirmed"` and `acceptPreconf` in `@mint-engine/core` no longer map to anything on Base. Treat inclusion in a 200 ms block as "confirmed (unsafe)" |

### 3.5 Cost model

- **L2 execution fee:** `gasUsed × (baseFee + priorityFee)`. The base fee has a **0.005 gwei floor**.
- **L1 security (data) fee:** usually the larger part.
- **Operator fee:** zero by default.

Source: [Network fees](https://docs.base.org/specifications/transactions/network-fees).

---

## 4. Robinhood Chain

### 4.1 Facts (verified on official docs)

- **Chain id 4663** on mainnet and **46630** on testnet. Gas is paid in **ETH**. Explorer: `robinhoodchain.blockscout.com`.
- Public RPC: `https://rpc.mainnet.chain.robinhood.com`. It is rate-limited and "not recommended for production".
- Sequencer endpoint: `https://sequencer.mainnet.chain.robinhood.com`. Sequencer feed: `wss://feed.mainnet.chain.robinhood.com`, with a delayed backup feed about 500 ms behind at `wss://delayed-feed.mainnet.chain.robinhood.com`.
- Source for all of the above: [Connecting to Robinhood Chain](https://docs.robinhood.com/chain/connecting).
- It is an Ethereum L2 built on **Arbitrum Orbit / Nitro**. Public mainnet launched **1 July 2026**, after a public testnet from 10 Feb 2026. A minority of reports say 2 July ([Arbitrum DAO factsheet](https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041), [Cointelegraph](https://cointelegraph.com/news/robinhood-public-blockchain-mainnet-launch)).
- **Ordering is FCFS** by sequencer arrival time. There are "no priority gas auctions", and a higher fee "will not shift your transaction ahead of others already in the queue" ([Differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum)).
- **Timeboost: not enabled.** Robinhood's docs describe plain FCFS and never mention Timeboost or an express lane.
  - For context: Arbitrum's Timeboost (a 60 s sealed-bid express-lane auction, which adds a 200 ms delay for everyone else) is optional per chain and needs an auction contract plus sequencer config ([Timeboost for Arbitrum chains](https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/sequencer/timeboost)).
  - Arbitrum One itself is replacing Timeboost with a **Priority Gas Auction** policy: 125 ms rounds ordered by priority fee ([gentle introduction](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction)).
  - If Robinhood Chain ever adopts PGA or Timeboost, the FCFS assumptions below stop holding. Watch [Notices & Upgrades](https://docs.robinhood.com/chain/notices-and-upgrades).
- **`block.number`** returns an *L1 block estimate*. Use `ArbSys(0x64).arbBlockNumber()` for the L2 block number. This matters for any "start at block N" trigger.

### 4.2 Public-mint landscape

- **Token launches** dominate.
  - **Pons** (since 12 Aug 2026) became the largest launchpad. **Noxa** shut down after 3 days, and **Vlad.fun** halted operations.
  - Others include memecoin.fun and LONG (long.xyz).
  - A 90-day Robinhood gas subsidy drove early volume.
  - Sources: [Alchemy overview](https://www.alchemy.com/overviews/launch-a-memecoin-on-robinhood-chain), [Galaxy Research](https://www.galaxy.com/insights/research/robinhood-chain-launch-analysis-base-comparison-memecoins-distribution-thesis), [Bitquery](https://bitquery.io/investigations/robinhood-vs-solana-memecoins). Several sources are promotional; contract interfaces of these launchpads are **[unverified]**.
- **NFT mint platforms:** none notable found **[unverified]**. Expect generic ERC721A and 1155 contracts.

### 4.3 How a transaction travels

1. A signed tx goes to RPC (Alchemy or public) and is forwarded to the **sequencer**. You can also post directly to the sequencer endpoint.
2. The sequencer orders txs **first-come, first-served** and emits them on the **sequencer feed** immediately. That is a soft confirmation within well under a second.
3. Batches post to Ethereum using blobs. Hard finality follows L1 ([Transaction finality](https://docs.robinhood.com/chain/transaction-finality)).

### 4.4 What "fast" means

Pure **latency to the sequencer**. Fees don't reorder anything. Levers:

- Pre-sign.
- Fire on the exact trigger: the feed, or `newHeads` from a node that consumes the feed.
- Send directly to the sequencer endpoint and to one or two low-latency RPCs in parallel. This is the same signed tx, so duplicates are harmless.
- Keep the host geographically close to the sequencer **[sequencer location unverified]**.

Over-paying the priority fee wastes money.

### 4.5 Failure modes and costs

| Failure | Engine handling |
|---|---|
| Late in the FCFS queue, so sold out by the time you execute | Simulate, then stop on `SoldOut`. Don't spam: each revert costs gas |
| Nonce gaps | Same as other EVM chains |
| Public RPC rate limiting | Use your own provider key. Never use the public RPC for mint bursts |
| Feed reconnects | The WS feed is compressed-only since 17 Sep 2026 under RFC 7692 ([Notices](https://docs.robinhood.com/chain/notices-and-upgrades)). Fall back to the delayed feed |

**Cost.** The **L2 execution fee** plus an **L1 data fee**, both folded into gas and estimated by `eth_estimateGas` ([Gas & fees](https://docs.robinhood.com/chain/gas-and-fees)).

---

## 5. How mint-engine maps onto each chain

| Package | Solana | Ethereum | Base | Robinhood |
|---|---|---|---|---|
| `chain-solana-nft` | Core Candy Machine / Guard: detect guards, build `mintV1`, respect `mintLimit` | | | |
| `chain-solana-token` | pump.fun-style curve `buy` with `minOut` slippage | | | |
| `chain-evm-nft` | | ERC721A / SeaDrop / Zora 1155 detect and prepare; read `maxPerWallet` | same | same |
| `chain-evm-token` | | | Bonding-curve `buy(token,minOut,deadline)`, `getBuyQuote`, `isGraduated` | same |
| `router-solana` | Fan-out to RPCs plus Jito `sendTransaction` / `sendBundle`; rebroadcast until `lastValidBlockHeight` | | | |
| `router-evm-l1` | | Flashbots Protect (`privateRelayUrl`) and/or public mempool; nonce and RBF management | | |
| `router-evm-l2` | | | Sequencer RPC fan-out; priority fee matters; no preconf after Denim | Direct sequencer plus RPC fan-out; FCFS, so a minimal priority fee is enough; soft-confirm via feed |
| `watcher` | Candy Guard `startDate`, slot | `SaleStarted` event, block | `newHeads`/`logs` at 200 ms cadence | Feed/`newHeads`; use `arbBlockNumber` for block triggers |
| `wallets` | Local encrypted keystore, 1–10 wallets; secrets never leave the package | ← | ← | ← |
| `engine` | Pre-build, simulate, pre-sign, fire on trigger, confirm | ← | ← | ← |
| `fixtures` | Local validator plus Metaplex programs (see `packages/fixtures/scripts/README.md`) | Anvil + ERC721A / 1155 / curve fixtures | Anvil, chain id 8453 | Anvil; **set `ROBINHOOD_CHAIN_ID=4663`** to mirror mainnet |

**Follow-ups for other units (not in this unit's scope):**

- `docker-compose.yml` defaults Robinhood to chain id 31338. 4663 is the verified mainnet id.
- `core`'s `preconfirmed` status should be documented as N/A for Base post-Denim. On Robinhood it maps to "seen on the sequencer feed".

---

## 6. Responsible use

mint-engine is a personal tool for taking part in **public** mints from a small number of the user's own wallets. It is designed and tested under these rules:

- **Per-wallet limits are respected, never evaded.** Quantity is capped at the on-chain `maxPerWallet`, Candy Guard `mintLimit` or Zora `maxTokensPerAddress`. The engine never splits funds across throwaway wallets to get around a limit. Wallet count is hard-capped at 10 (`MAX_WALLETS_PER_JOB`).
- **No anti-sybil or anti-bot evasion.** No CAPTCHA solving, no faking allowlist proofs, no third-party-signer bypass, no gatekeeper token farming. If a drop uses `botTax`, `gatekeeper` or signed mints, the engine reports that and stops.
- **Local key custody.** Keys live in the local encrypted keystore (`packages/wallets`). The dashboard server binds to `127.0.0.1` only. Nothing is sent to a third-party service except signed transactions to the RPC or relay you configure.
- **Built and tested on local chains.** All tests run against local `solana-test-validator` and anvil nodes. The fixtures package refuses non-local RPC URLs and only uses public dev keys or throwaway keys written to a gitignored file.
- Mints and launches are speculative, and many launchpad tokens go to zero. Check each project's terms and your local rules before taking part. This document is not financial advice.

---

## Sources

Official docs:
- Robinhood Chain: [overview](https://docs.robinhood.com/chain), [connecting](https://docs.robinhood.com/chain/connecting), [differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum), [gas & fees](https://docs.robinhood.com/chain/gas-and-fees), [finality](https://docs.robinhood.com/chain/transaction-finality), [notices](https://docs.robinhood.com/chain/notices-and-upgrades)
- Base: [200ms blocks (Denim)](https://docs.base.org/upgrades/denim/200ms-blocks), [migrate from Flashblocks](https://docs.base.org/upgrades/denim/migrate-from-flashblocks), [transaction ordering](https://docs.base.org/specifications/transactions/transaction-ordering), [network fees](https://docs.base.org/specifications/transactions/network-fees), [launch tokens](https://docs.base.org/cookbook/launch-tokens)
- Arbitrum: [Timeboost / PGA introduction](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction), [Timeboost for Arbitrum chains](https://docs.arbitrum.io/launch-arbitrum-chain/chain-config/sequencer/timeboost)
- Jito: [low-latency transaction send](https://docs.jito.wtf/lowlatencytxnsend/)
- Flashbots: [Protect overview](https://docs.flashbots.net/flashbots-protect/overview)
- Metaplex: [Core Candy Machine](https://metaplex.com/docs/core-candy-machine), [mpl-core](https://github.com/metaplex-foundation/mpl-core), [mpl-core-candy-machine](https://github.com/metaplex-foundation/mpl-core-candy-machine)
- OpenSea: [SeaDrop](https://docs.opensea.io/docs/seadrop)

Third-party data and press (lower confidence):
- Solana expiry: [Chainstack](https://docs.chainstack.com/docs/solana-how-to-handle-the-transaction-expiry-error)
- Solana launchpad share: [The Block](https://www.theblock.co/post/367266/solana-memecoin-launchpad-war-flips-again-as-pump-takes-top-spot-amid-letsbonk-collapse), [CoinMarketCap Academy](https://coinmarketcap.com/academy/article/pumpfun-reclaims-90percent-market-share-in-solana-launchpad-war)
- Base launchpads: [Decrypt](https://decrypt.co/332573/base-overtakes-solana-in-daily-tokens-created-as-pump-fun-continues-to-shrink), [The Block](https://www.theblock.co/post/365384/base-solana-zora), [The Block (Clanker)](https://www.theblock.co/post/349549/clanker-team-earns-13-million-in-revenue-from-over-200000-tokens-on-base-in-just-five-months)
- Robinhood Chain: [Arbitrum DAO factsheet](https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041), [Cointelegraph](https://cointelegraph.com/news/robinhood-public-blockchain-mainnet-launch), [Alchemy](https://www.alchemy.com/overviews/launch-a-memecoin-on-robinhood-chain), [Galaxy Research](https://www.galaxy.com/insights/research/robinhood-chain-launch-analysis-base-comparison-memecoins-distribution-thesis), [Bitquery](https://bitquery.io/investigations/robinhood-vs-solana-memecoins)
- Ethereum PBS: [mevboost.pics](https://mevboost.pics/), [relayscan.io](https://www.relayscan.io/), [EtherWorld on Glamsterdam](https://etherworld.co/glamsterdam-at-crossroads-whats-in-whats-out-whats-still-uncertain/)
