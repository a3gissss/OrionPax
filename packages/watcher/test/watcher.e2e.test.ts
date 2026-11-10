// E2E: go-live triggers against a LOCAL anvil "base" chain (chain id 8453).
// Start it with `docker compose up -d base` (port 8546) or set E2E_BASE_RPC.
import { beforeAll, describe, expect, it } from "vitest";
import solc from "solc";
import {
  createPublicClient, createWalletClient, defineChain, http,
  type Abi, type Address, type Hex,
} from "viem";
import type { MintTarget } from "@mint-engine/core";
import { waitForGoLive } from "../src/index.js";

const RPC = process.env.E2E_BASE_RPC ?? "http://127.0.0.1:8546";
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(RPC)) {
  throw new Error(`E2E_BASE_RPC must point at a local chain, got ${RPC}`);
}

const chain = defineChain({
  id: 8453,
  name: "base-local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Sale {
  bool public saleActive;
  event SaleStarted();
  function startSale() external {
    saleActive = true;
    emit SaleStarted();
  }
}`;

function compile(): { abi: Abi; bytecode: Hex } {
  const input = {
    language: "Solidity",
    sources: { "Sale.sol": { content: SOURCE } },
    settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(JSON.stringify(errors));
  const c = out.contracts["Sale.sol"].Sale;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

const publicClient = createPublicClient({ chain, transport: http(RPC), pollingInterval: 100 });
const walletClient = createWalletClient({ chain, transport: http(RPC) });

let abi: Abi;
let bytecode: Hex;
let deployer: Address;
let flipper: Address;

async function deploy(): Promise<Address> {
  const hash = await walletClient.deployContract({ abi, bytecode, account: deployer, chain });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  return rcpt.contractAddress!;
}

async function flip(address: Address): Promise<number> {
  const sentAt = Date.now();
  await walletClient.writeContract({ address, abi, functionName: "startSale", account: flipper, chain });
  return sentAt;
}

function inlineAdapter(address: Address) {
  return {
    async detect(_t: MintTarget) {
      const live = (await publicClient.readContract({ address, abi, functionName: "saleActive" })) as boolean;
      return { live };
    },
  };
}

const targetFor = (address: Address): MintTarget => ({ kind: "nft", chain: "base", address, quantity: 1 });

beforeAll(async () => {
  ({ abi, bytecode } = compile());
  const accounts = await walletClient.requestAddresses().catch(() => publicClient.request({ method: "eth_accounts" }) as Promise<Address[]>);
  expect(accounts.length).toBeGreaterThanOrEqual(2);
  [deployer, flipper] = accounts as [Address, Address];
  expect(await publicClient.getChainId()).toBe(8453);
});

describe("watcher e2e (local anvil base)", () => {
  it("event trigger via watchContractEvent fires < 1.5 s after the flag flips", async () => {
    const address = await deploy();
    const order: string[] = [];
    const p = waitForGoLive({ type: "event", signature: "SaleStarted()" }, {
      subscribe: (cb) => publicClient.watchContractEvent({
        address, abi, eventName: "SaleStarted", pollingInterval: 100,
        onLogs: (logs) => cb(logs[0]),
      }),
    }, {
      onArm: () => { order.push("arm"); },
      onFire: () => { order.push("fire"); },
    });
    await new Promise((r) => setTimeout(r, 500)); // let the filter install
    const sentAt = await flip(address);
    const res = await p;
    const latency = res.firedAt - sentAt;
    console.log(`event trigger latency: ${latency.toFixed(1)} ms`);
    expect(latency).toBeLessThan(1500);
    expect(order).toEqual(["arm", "fire"]);
    expect((res.event as { eventName?: string }).eventName).toBe("SaleStarted");
  });

  it("state-poll trigger with an inline adapter reading saleActive", async () => {
    const address = await deploy();
    const adapter = inlineAdapter(address);
    const states: boolean[] = [];
    const p = waitForGoLive({ type: "state-poll", intervalMs: 100 }, {
      adapter, target: targetFor(address), jobId: "e2e",
      emit: (e) => { if (e.type === "mint.state") states.push(e.state.live); },
    });
    await new Promise((r) => setTimeout(r, 400));
    const sentAt = await flip(address);
    const res = await p;
    console.log(`state-poll latency: ${(res.firedAt - sentAt).toFixed(1)} ms`);
    expect(res.state?.live).toBe(true);
    expect(states).toEqual([false, true]);
    expect(res.firedAt - sentAt).toBeLessThan(2500);
  });

  it("slot-or-block trigger fires at currentBlock + 3", async () => {
    const start = Number(await publicClient.getBlockNumber());
    const at = start + 3;
    const armedAtHeight: number[] = [];
    const res = await waitForGoLive({ type: "slot-or-block", at }, {
      getHeight: async () => Number(await publicClient.getBlockNumber({ cacheTime: 0 })),
    }, {
      heightPollMs: 100, leadBlocks: 1,
      onArm: async () => { armedAtHeight.push(Number(await publicClient.getBlockNumber({ cacheTime: 0 }))); },
    });
    const now = Number(await publicClient.getBlockNumber({ cacheTime: 0 }));
    expect(res.height).toBeGreaterThanOrEqual(at);
    expect(res.height).toBeLessThanOrEqual(at + 1);
    expect(now).toBeGreaterThanOrEqual(at);
    expect(armedAtHeight[0]).toBeGreaterThanOrEqual(at - 1);
  });

  it("time trigger with chain-time skew correction from block timestamps", async () => {
    const getChainTime = async () => Number((await publicClient.getBlock({ blockTag: "latest" })).timestamp) * 1000;
    const at = Date.now() + 1500;
    const order: string[] = [];
    const res = await waitForGoLive({ type: "time", at }, { getChainTime }, {
      leadMs: 500, resyncBeforeMs: 0, chainTimeBiasMs: 1000, // 1 s block time: blockTime/2 + 500
      onArm: () => { order.push("arm"); }, onFire: () => { order.push("fire"); },
    });
    expect(order).toEqual(["arm", "fire"]);
    // Block timestamps have 1 s granularity and lag the wall clock by < ~2 block times.
    expect(Math.abs(res.clockOffsetMs!)).toBeLessThan(3000);
    expect(res.latenessMs!).toBeGreaterThanOrEqual(0);
  });
});
