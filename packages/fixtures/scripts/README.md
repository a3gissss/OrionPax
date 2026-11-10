# @mint-engine/fixtures: scripts and usage

These are reusable **local-only** test fixtures. Every helper refuses non-local RPC URLs, which means anything other than localhost, 127.0.0.1, ::1, `*.localhost` or `*.test`.

## Endpoints

RPC URLs are always parameters. The defaults come from env vars, so parallel runs can each use their own containers:

| env | default |
|---|---|
| `E2E_ETH_RPC` | `http://127.0.0.1:8545` |
| `E2E_BASE_RPC` | `http://127.0.0.1:8546` |
| `E2E_ROBINHOOD_RPC` | `http://127.0.0.1:8547` |
| `E2E_SOLANA_RPC` | `http://127.0.0.1:8899` |
| `E2E_SOLANA_WS` | `ws://127.0.0.1:8900` |

## Using fixtures from another package

Add `"@mint-engine/fixtures": "0.1.0"` to that package's `devDependencies`. Then in a `*.e2e.test.ts`:

```ts
import { anvilDevAccounts, deployEvmFixtures, fixtureAbis, localEndpoints, setErc721aSaleActive } from "@mint-engine/fixtures";

const rpc = localEndpoints().base;
const fx = await deployEvmFixtures(rpc, { erc721a: { maxPerWallet: 2n } });
// fx.erc721a.address  fx.zora1155.{address,minter,tokenId}  fx.launchpad.{address,token}
const wallets = anvilDevAccounts(10); // prefunded on the compose anvils (accounts 0..11)
await setErc721aSaleActive(rpc, fx.erc721a.address, true); // emits SaleStarted, good for watcher tests
```

Throwaway wallets go to the gitignored `<repo>/fixtures/.local-wallets.json`:

```ts
import { fundLocalWallets, localEndpoints } from "@mint-engine/fixtures";
const ep = localEndpoints();
await fundLocalWallets(10, { evmRpcUrls: [ep.base, ep.robinhood], solanaRpcUrl: ep.solanaRpc });
```

Solana:

```ts
import { startSolanaFixtures } from "@mint-engine/fixtures";
const sol = await startSolanaFixtures(); // waits for getHealth, reports which Metaplex programs are loaded
if (!sol.loaded.coreCandyMachine) console.log(sol.notes.join("\n"));
```

## Contracts

`contracts/*.sol` are compiled with npm `solc` into the checked-in `src/artifacts.generated.ts`:

| Contract | Surface |
|---|---|
| `FixtureERC721A` | `mint(qty)` payable, `price`, `maxPerWallet`, `maxSupply`, `saleActive`, `numberMinted`, `setSaleActive` → `SaleStarted(price,maxPerWallet,ts)`; errors `SaleNotActive`, `ExceedsMaxPerWallet`, `SoldOut`, `WrongPayment` |
| `Fixture1155` + `FixtureFixedPriceMinter` | Zora-like `mint(minter, tokenId, qty, rewardsRecipients, abi.encode(mintTo, comment))` with `value = (price + mintFee) * qty`; `sale(collection, tokenId)` returns `{saleStart, saleEnd, maxTokensPerAddress, pricePerToken, fundsRecipient}` |
| `BondingCurveLaunchpad` + `LaunchToken` | `createToken(name,symbol)`, `buy(token,minOut,deadline)` payable, `getBuyQuote(token, ethIn)`, `isGraduated(token)`; pump.fun-style virtual reserves, 1% fee, graduates at `graduationEth` |

```bash
npm run compile:contracts -w @mint-engine/fixtures   # regenerate after editing .sol
npm run check:contracts -w @mint-engine/fixtures     # fail if artifacts are stale (also a unit test)
```

## Solana programs (Metaplex Core + Core Candy Machine)

A fresh `solana-test-validator` doesn't have these programs. `solana-programs.sh` dumps them once from **devnet** (a read-only fetch of public program bytes) and boots a validator with them preloaded:

```bash
bash packages/fixtures/scripts/solana-programs.sh dump   # -> packages/fixtures/.programs/*.so (gitignore it locally)
RPC_PORT=8899 WS_PORT=8900 bash packages/fixtures/scripts/solana-programs.sh run
bash packages/fixtures/scripts/solana-programs.sh stop
```

This is equivalent to the validator flags produced by `solanaValidatorProgramArgs("/programs")`:

```
--upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d /programs/mpl_core.so none ...
```

The alternative is to clone at boot, which needs network access when the validator starts. Use `solanaValidatorCloneArgs("devnet")`:

```
--url devnet --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d ...
```

Untested: recent mpl-core builds may need a newer validator than the compose image `solanalabs/solana:v1.18.26`. Override it with `SOLANA_IMAGE`.

## E2E

```bash
docker compose up -d base robinhood solana
npm run e2e -w @mint-engine/fixtures
docker compose down
```

When running alongside other workers, use your own containers and ports via `E2E_*` env vars.
