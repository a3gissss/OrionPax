// EVM fixtures: deploy the local test contracts to an anvil node and expose its dev accounts.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { assertLocalRpc, localEndpoints } from "./env.js";
import { BondingCurveLaunchpad, Fixture1155, FixtureERC721A, FixtureFixedPriceMinter, LaunchToken } from "./artifacts.generated.js";

/** Foundry/anvil default dev mnemonic. Public test value: these keys hold nothing outside local chains. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** docker-compose starts anvil with `--accounts 12`; only these indices are prefunded (10,000 ETH each). */
export const ANVIL_FUNDED_ACCOUNTS = 12;

export interface DevAccount {
  index: number;
  address: Address;
  privateKey: Hex;
}

/** First `n` anvil dev accounts (m/44'/60'/0'/0/i of the default mnemonic). */
export function anvilDevAccounts(n: number): DevAccount[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`anvilDevAccounts: n must be a positive integer, got ${n}`);
  return Array.from({ length: n }, (_, index) => {
    const acct = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
    const pk = acct.getHdKey().privateKey;
    if (!pk) throw new Error("failed to derive dev key");
    return { index, address: acct.address, privateKey: toHex(pk) };
  });
}

export const fixtureAbis = {
  erc721a: FixtureERC721A.abi,
  zora1155: Fixture1155.abi,
  fixedPriceMinter: FixtureFixedPriceMinter.abi,
  launchpad: BondingCurveLaunchpad.abi,
  launchToken: LaunchToken.abi,
} as const;

export interface EvmFixtureOptions {
  /** Deployer key; defaults to anvil dev account 0. */
  deployerKey?: Hex;
  erc721a?: { name?: string; symbol?: string; priceWei?: bigint; maxPerWallet?: bigint; maxSupply?: bigint; saleActive?: boolean };
  zora1155?: { mintFeeWei?: bigint; priceWei?: bigint; maxPerAddress?: bigint; maxSupply?: bigint };
  launchpad?: { graduationEthWei?: bigint; tokenName?: string; tokenSymbol?: string };
}

export interface EvmFixtures {
  rpcUrl: string;
  chainId: number;
  deployer: Address;
  erc721a: { address: Address; priceWei: bigint; maxPerWallet: bigint; maxSupply: bigint; saleActive: boolean };
  zora1155: { address: Address; minter: Address; tokenId: bigint; mintFeeWei: bigint; priceWei: bigint; maxPerAddress: bigint };
  launchpad: { address: Address; token: Address; graduationEthWei: bigint };
}

export async function evmChain(rpcUrl: string): Promise<Chain> {
  assertLocalRpc(rpcUrl);
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const id = await probe.getChainId();
  return defineChain({
    id,
    name: `local-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface EvmClients {
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;
}

export function evmClients(rpcUrl: string, chain: Chain, privateKey: Hex): EvmClients {
  assertLocalRpc(rpcUrl);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  return { account, publicClient, walletClient };
}

/**
 * Deploy all EVM fixtures to a local node. Defaults to the Base anvil (E2E_BASE_RPC or :8546).
 * Deploys sequentially from one key (dev account 0 by default). Not safe to call concurrently with the SAME
 * deployer against the same node: pass a distinct `deployerKey` per concurrent caller.
 */
export async function deployEvmFixtures(rpcUrl: string = localEndpoints().base, opts: EvmFixtureOptions = {}): Promise<EvmFixtures> {
  const chain = await evmChain(rpcUrl);
  const deployerKey = opts.deployerKey ?? anvilDevAccounts(1)[0]!.privateKey;
  const { account, publicClient, walletClient } = evmClients(rpcUrl, chain, deployerKey);

  const deploy = async (artifact: { abi: Abi; bytecode: Hex }, args: unknown[]): Promise<Address> => {
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args, account, chain });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy failed: ${hash}`);
    return r.contractAddress;
  };
  const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account });
    const hash = await walletClient.writeContract(request);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return r;
  };

  // ERC721A-style drop
  const e = opts.erc721a ?? {};
  const erc721a = {
    priceWei: e.priceWei ?? parseEther("0.01"),
    maxPerWallet: e.maxPerWallet ?? 2n,
    maxSupply: e.maxSupply ?? 100n,
    saleActive: e.saleActive ?? false,
  };
  const erc721aAddr = await deploy(FixtureERC721A, [e.name ?? "Fixture Drop", e.symbol ?? "FXD", erc721a.priceWei, erc721a.maxPerWallet, erc721a.maxSupply]);
  if (erc721a.saleActive) await write(erc721aAddr, FixtureERC721A.abi, "setSaleActive", [true]);

  // Zora-1155-like collection + fixed price minter, sale open now for ~30 days
  const z = opts.zora1155 ?? {};
  const zora = {
    mintFeeWei: z.mintFeeWei ?? parseEther("0.000111"),
    priceWei: z.priceWei ?? parseEther("0.001"),
    maxPerAddress: z.maxPerAddress ?? 3n,
  };
  const c1155 = await deploy(Fixture1155, [zora.mintFeeWei]);
  const minter = await deploy(FixtureFixedPriceMinter, []);
  await write(c1155, Fixture1155.abi, "setMinter", [minter, true]);
  // Read results from the mined receipt's events (not the simulation) so concurrent writers can't skew them.
  const setupLogs = parseEventLogs({ abi: Fixture1155.abi, eventName: "SetupNewToken", logs: (await write(c1155, Fixture1155.abi, "setupNewToken", [z.maxSupply ?? 1000n])).logs });
  const tokenId = setupLogs[0]?.args.tokenId;
  if (tokenId === undefined) throw new Error("SetupNewToken event missing");
  const now = (await publicClient.getBlock()).timestamp;
  await write(minter, FixtureFixedPriceMinter.abi, "setSale", [
    c1155,
    tokenId,
    { saleStart: 0n, saleEnd: now + 30n * 86400n, maxTokensPerAddress: zora.maxPerAddress, pricePerToken: zora.priceWei, fundsRecipient: account.address },
  ]);

  // Bonding-curve launchpad + one launched token
  const l = opts.launchpad ?? {};
  const graduationEthWei = l.graduationEthWei ?? parseEther("85");
  const launchpad = await deploy(BondingCurveLaunchpad, [graduationEthWei]);
  const createdLogs = parseEventLogs({
    abi: BondingCurveLaunchpad.abi,
    eventName: "TokenCreated",
    logs: (await write(launchpad, BondingCurveLaunchpad.abi, "createToken", [l.tokenName ?? "Fixture Coin", l.tokenSymbol ?? "FXC"])).logs,
  });
  const token = createdLogs[0]?.args.token;
  if (!token) throw new Error("TokenCreated event missing");

  return {
    rpcUrl,
    chainId: chain.id,
    deployer: account.address,
    erc721a: { address: erc721aAddr, ...erc721a },
    zora1155: { address: c1155, minter, tokenId, ...zora },
    launchpad: { address: launchpad, token, graduationEthWei },
  };
}

/** Flip the ERC721A fixture's sale on/off (emits SaleStarted when turned on). Owner = deployer key. */
export async function setErc721aSaleActive(rpcUrl: string, address: Address, active: boolean, ownerKey?: Hex): Promise<Hex> {
  const chain = await evmChain(rpcUrl);
  const { account, publicClient, walletClient } = evmClients(rpcUrl, chain, ownerKey ?? anvilDevAccounts(1)[0]!.privateKey);
  const hash = await walletClient.writeContract({ address, abi: FixtureERC721A.abi, functionName: "setSaleActive", args: [active], account, chain });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`setSaleActive reverted: ${hash}`);
  return hash;
}

/** anvil_setBalance on a local node (used to fund throwaway wallets). */
export async function setEvmBalance(rpcUrl: string, address: Address, wei: bigint): Promise<void> {
  assertLocalRpc(rpcUrl);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [address, toHex(wei)] }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`anvil_setBalance: ${body.error.message}`);
}
