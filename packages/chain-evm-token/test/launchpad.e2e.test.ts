// E2E against local anvil chains only (docker). Uses anvil's well-known dev mnemonic — never real keys.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import solc from "solc";
import {
  createPublicClient, createWalletClient, decodeFunctionData, http, parseEther, parseEventLogs,
  parseTransaction, toBytes, toHex, type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { PreparedTx, TokenLaunchTarget, WalletRef } from "@mint-engine/core";
import { ERC20_ABI, EvmTokenAdapter, GENERIC_BONDING_CURVE, type EvmChain } from "../src/index.js";

const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const wallets = Array.from({ length: 10 }, (_, i) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i }));
const frontRunner = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 10 });
const deployer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 11 });

const CHAINS: Array<{ chain: EvmChain; rpcUrl: string }> = [
  { chain: "base", rpcUrl: process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546" },
  { chain: "robinhood", rpcUrl: process.env.E2E_ROBINHOOD_RPC ?? "http://127.0.0.1:8547" },
];

interface Compiled { abi: Abi; bytecode: Hex }

function compileFixture(): Compiled {
  const path = fileURLToPath(new URL("./fixtures/BondingCurveLaunchpad.sol", import.meta.url));
  const input = {
    language: "Solidity",
    sources: { "BondingCurveLaunchpad.sol": { content: readFileSync(path, "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts["BondingCurveLaunchpad.sol"].BondingCurveLaunchpad;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

const walletRef = (i: number): WalletRef => ({
  id: `w${i + 1}`, label: `Wallet ${i + 1}`, family: "evm", address: wallets[i]!.address,
});

/** Stand-in for the TxRouter: assign the wallet's next nonce, sign locally, broadcast. */
async function signAndSend(client: PublicClient, prepared: PreparedTx, i: number, account = wallets[i]!): Promise<Hex> {
  const tx = parseTransaction(toHex(prepared.unsigned));
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const signed = await account.signTransaction({ ...tx, nonce, chainId: tx.chainId!, type: "eip1559" } as never);
  return client.sendRawTransaction({ serializedTransaction: signed });
}

function minOutOf(p: PreparedTx): bigint {
  const { args } = decodeFunctionData({ abi: GENERIC_BONDING_CURVE.abi, data: parseTransaction(toHex(p.unsigned)).data! });
  return args![1] as bigint;
}

let compiled: Compiled;
beforeAll(() => { compiled = compileFixture(); });

describe.each(CHAINS)("chain-evm-token e2e on $chain", ({ chain, rpcUrl }) => {
  let client: PublicClient;
  let launchpad: Address;
  let token: Address;
  let graduatedToken: Address;
  let adapter: EvmTokenAdapter;

  const target = (tokenAddress: Address, slippageBps = 500): TokenLaunchTarget => ({
    kind: "token", chain, tokenAddress, launchpadAddress: launchpad,
    spendPerWallet: parseEther("0.1").toString(), slippageBps,
  });

  beforeAll(async () => {
    client = createPublicClient({ transport: http(rpcUrl) });
    const chainId = await client.getChainId();
    const dev = createWalletClient({ account: deployer, transport: http(rpcUrl), chain: { id: chainId } as never });
    const deployHash = await dev.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode });
    launchpad = (await client.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;

    const create = async (sym: string): Promise<Address> => {
      const hash = await dev.writeContract({
        address: launchpad, abi: compiled.abi, functionName: "createToken",
        args: [`Test ${sym}`, sym, parseEther("1000000000"), parseEther("30")],
      } as never);
      const rcpt = await client.waitForTransactionReceipt({ hash });
      const [log] = parseEventLogs({ abi: compiled.abi, logs: rcpt.logs, eventName: "TokenCreated" });
      return (log as unknown as { args: { token: Address } }).args.token;
    };
    token = await create("LIVE");
    graduatedToken = await create("GRAD");
    const g = await dev.writeContract({ address: launchpad, abi: compiled.abi, functionName: "graduate", args: [graduatedToken] } as never);
    await client.waitForTransactionReceipt({ hash: g });

    adapter = new EvmTokenAdapter({ chain, rpcUrl });
  }, 120_000);

  it("detects, prepares, simulates and lands buys from 10 wallets", async () => {
    const state = await adapter.detect(target(token));
    expect(state.live).toBe(true);
    expect(BigInt(state.pricePerUnit!)).toBeGreaterThan(0n);

    const prepared = await Promise.all(wallets.map((_, i) => adapter.prepare(target(token), walletRef(i), {})));
    for (const p of prepared) {
      expect(p.value).toBe(parseEther("0.1").toString());
      expect((await adapter.simulate(p)).ok).toBe(true);
    }

    const hashes = await Promise.all(prepared.map((p, i) => signAndSend(client, p, i)));
    const receipts = await Promise.all(hashes.map((hash) => client.waitForTransactionReceipt({ hash })));
    expect(receipts).toHaveLength(10);
    for (const [i, r] of receipts.entries()) {
      expect(r.status).toBe("success");
      const bal = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallets[i]!.address] });
      expect(bal).toBeGreaterThanOrEqual(minOutOf(prepared[i]!));
      expect(bal).toBeGreaterThan(0n);
    }
  }, 120_000);

  it("slippage guard reverts when a large buy front-runs between prepare and send", async () => {
    const victim = 0;
    const prepared = await adapter.prepare(target(token, 100), walletRef(victim), {});
    expect((await adapter.simulate(prepared)).ok).toBe(true);
    const before = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallets[victim]!.address] });

    const chainId = await client.getChainId();
    const fr = createWalletClient({ account: frontRunner, transport: http(rpcUrl), chain: { id: chainId } as never });
    const block = await client.getBlock();
    const frHash = await fr.writeContract({
      address: launchpad, abi: compiled.abi, functionName: "buy",
      args: [token, 0n, block.timestamp + 600n], value: parseEther("20"),
    } as never);
    expect((await client.waitForTransactionReceipt({ hash: frHash })).status).toBe("success");

    const sim = await adapter.simulate(prepared);
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(/SlippageExceeded/);

    const hash = await signAndSend(client, prepared, victim);
    const rcpt = await client.waitForTransactionReceipt({ hash });
    expect(rcpt.status).toBe("reverted");
    const after = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallets[victim]!.address] });
    expect(after).toBe(before);
  }, 120_000);

  it("refuses graduated tokens", async () => {
    const state = await adapter.detect(target(graduatedToken));
    expect(state.live).toBe(false);
    await expect(adapter.prepare(target(graduatedToken), walletRef(1), {})).rejects.toThrow(/graduated/);
  }, 60_000);

  it("simulate decodes a signed tx revert", async () => {
    const prepared = await adapter.prepare(target(token), walletRef(2), {});
    const tx = parseTransaction(toHex(prepared.unsigned));
    // Re-sign with an impossible minTokensOut to force a decoded custom-error revert.
    const { args } = decodeFunctionData({ abi: GENERIC_BONDING_CURVE.abi, data: tx.data! });
    const { encodeFunctionData } = await import("viem");
    const data = encodeFunctionData({ abi: GENERIC_BONDING_CURVE.abi, functionName: "buy", args: [args![0] as Address, 2n ** 255n, args![2] as bigint] });
    const signed = await wallets[2]!.signTransaction({ ...tx, data, nonce: 0, chainId: tx.chainId!, type: "eip1559" } as never);
    const sim = await adapter.simulate(prepared, toBytes(signed));
    expect(sim.ok).toBe(false);
    expect(sim.error).toMatch(/^reverted: SlippageExceeded\(/);
  }, 60_000);
});
