// E2E against a LOCAL solana-test-validator only (never mainnet).
// Run:  docker run -d --rm --name unit4-solana -p 21499:8899 -p 21498:8900 \
//         solanalabs/solana:v1.18.26 solana-test-validator --reset --rpc-port 8899 --bind-address 0.0.0.0
//       E2E_SOLANA_RPC=http://127.0.0.1:21499 E2E_SOLANA_WS=ws://127.0.0.1:21498 npm run e2e -w @mint-engine/router-solana
// Throwaway keys are generated in memory per run and never written or logged.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSolanaRpc,
  generateKeyPairSigner,
  getBase58Decoder,
  lamports,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { BlockhashCache, SolanaTxRouter, signatureOf } from "../src/index.js";
import { prepared, signTransfer } from "./helpers.js";
import { StubServer } from "./stub.js";

const RPC = process.env.E2E_SOLANA_RPC ?? "http://127.0.0.1:8899";
const WS = process.env.E2E_SOLANA_WS ?? "ws://127.0.0.1:8900";
for (const u of [RPC, WS]) {
  const host = new URL(u).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error(`e2e must target a local validator, got ${host}`);
}

const rpc = createSolanaRpc(RPC);
const jito = new StubServer(); // records sendBundle calls
let wallets: KeyPairSigner[] = [];
let cache: BlockhashCache;

async function waitConfirmed(sigs: Signature[], timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { value } = await rpc.getSignatureStatuses(sigs).send();
    if (value.every((s) => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("airdrops not confirmed");
}

beforeAll(async () => {
  await jito.start();
  wallets = await Promise.all(Array.from({ length: 10 }, () => generateKeyPairSigner()));
  const sigs = await Promise.all(wallets.map((w) => rpc.requestAirdrop(w.address, lamports(1_000_000_000n)).send()));
  await waitConfirmed(sigs);
  cache = new BlockhashCache({ rpcUrl: RPC, wsUrl: WS, intervalMs: 400 });
  await cache.start();
}, 60_000);

afterAll(async () => {
  cache?.stop();
  await jito.stop();
});

describe("router-solana e2e (local validator)", () => {
  it("sends 10 wallets' txs with fan-out (same RPC twice) + Jito stub and confirms all", async () => {
    const bh = await cache.get();
    const dest = (await generateKeyPairSigner()).address;
    const items = await Promise.all(
      wallets.map(async (w, i) => ({
        prepared: prepared(`w${i}`, bh.lastValidBlockHeight),
        signed: await signTransfer({ payer: w, to: dest, lamports: 10_000n + BigInt(i), blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }),
      })),
    );
    const router = new SolanaTxRouter({ chain: "solana", rpcUrl: RPC, extraRpcUrls: [RPC], privateRelayUrl: jito.url });

    const sent = [
      ...(await router.send(items.slice(0, 5), { jitoTip: "1000" })),
      ...(await router.send(items.slice(5), {})),
    ];
    expect(sent.map((s) => s.id)).toEqual(items.map((i) => signatureOf(i.signed)));
    expect(jito.jitoCalls).toHaveLength(1);
    expect(jito.jitoCalls[0]).toMatchObject({ path: "/api/v1/bundles", method: "sendBundle" });
    expect((jito.jitoCalls[0]!.params[0] as string[]).length).toBe(5);

    const out = await router.confirm(sent, { timeoutMs: 60_000 });
    expect(out.map((o) => o.status)).toEqual(Array(10).fill("confirmed"));
    for (const o of out) expect(o.slotOrBlock).toBeGreaterThan(0);
  }, 90_000);

  it("a tx whose blockhash never becomes valid resolves to expired", async () => {
    const height = Number(await rpc.getBlockHeight({ commitment: "confirmed" }).send());
    const bogusHash = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const validUntil = height + 3;
    const signed = await signTransfer({ payer: wallets[0]!, to: wallets[1]!.address, lamports: 1n, blockhash: bogusHash, lastValidBlockHeight: validUntil });
    const router = new SolanaTxRouter({ chain: "solana", rpcUrl: RPC });
    const sent = await router.send([{ prepared: prepared("w0-expire", validUntil), signed }], {});
    const [o] = await router.confirm(sent, { timeoutMs: 30_000 });
    expect(o!.status).toBe("expired");
  }, 40_000);
});
