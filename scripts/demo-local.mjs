// Local demo setup: deploys demo contracts on a LOCAL chain and creates a vault of 10 funded
// throwaway EVM wallets, plus a config for the real dashboard server.
//
//   node scripts/demo-local.mjs [rpcUrl]      (default http://127.0.0.1:8546, must be local)
//   npm run start -w @mint-engine/server -- --config .demo/config.json
//
// Everything goes to .demo/ (gitignored). The vault passphrase is random and written to
// .demo/demo-info.json. These keys are for local testing only: never fund them on a real chain.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvilDevAccounts, assertLocalRpc, deployEvmFixtures, evmChain, setErc721aSaleActive } from "@mint-engine/fixtures";
import { WalletVault } from "@mint-engine/wallets";

const RPC = process.argv[2] ?? "http://127.0.0.1:8546";
assertLocalRpc(RPC);
const DIR = ".demo";

await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });

const chain = await evmChain(RPC);
console.log(`chain id ${chain.id} at ${RPC}`);

const fx = await deployEvmFixtures(RPC, { erc721a: { maxPerWallet: 2n, priceWei: parseEther("0.01"), maxSupply: 1000n } });
await setErc721aSaleActive(RPC, fx.erc721a.address, true);
console.log(`NFT drop (ERC721A, 0.01 ETH, max 2/wallet): ${fx.erc721a.address}`);
console.log(`Token launchpad: ${fx.launchpad.address}  token: ${fx.launchpad.token}`);

const passphrase = randomBytes(18).toString("base64url");
const vaultPath = join(DIR, "wallets.keystore");
const vault = await WalletVault.create(vaultPath, passphrase);
for (let i = 1; i <= 10; i++) await vault.generate("evm", `Demo ${i}`);

const funder = privateKeyToAccount(anvilDevAccounts(1)[0].privateKey);
const wc = createWalletClient({ account: funder, chain, transport: http(RPC) });
const pc = createPublicClient({ chain, transport: http(RPC) });
for (const w of vault.list()) {
  const hash = await wc.sendTransaction({ to: w.address, value: parseEther("1") });
  await pc.waitForTransactionReceipt({ hash });
}
vault.lock();
console.log("10 demo wallets created and funded with 1 ETH each");

await writeFile(join(DIR, "config.json"), JSON.stringify({
  vaultPath,
  ledgerPath: join(DIR, "ledger.json"),
  chains: { base: { rpcUrl: RPC, evmChainId: chain.id } },
  evmLaunchpads: { base: { [fx.launchpad.address]: "generic-bonding-curve" } },
}, null, 2));
await writeFile(join(DIR, "demo-info.json"), JSON.stringify({
  note: "LOCAL TEST ONLY. Throwaway keys on a local chain.",
  rpc: RPC,
  vaultPassphrase: passphrase,
  nftDrop: fx.erc721a.address,
  launchpad: fx.launchpad.address,
  launchToken: fx.launchpad.token,
}, null, 2));
console.log(`Wrote ${DIR}/config.json and ${DIR}/demo-info.json (vault passphrase is in demo-info.json)`);
