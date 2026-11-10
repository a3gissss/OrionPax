// E2E: 10 throwaway wallets mint from a local Core Candy Machine (solPayment + mintLimit 1).
// Requires a LOCAL solana-test-validator with mpl-core + core candy machine/guard loaded.
// See packages/chain-solana-nft/scripts/start-validator.sh. Never point this at mainnet.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import {
  generateSigner, keypairIdentity, publicKey as toPk, sol, some, type Umi,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createCollection, mplCore } from "@metaplex-foundation/mpl-core";
import {
  create, fetchCandyMachine, findMintCounterPda, mplCandyMachine, safeFetchMintCounter,
} from "@metaplex-foundation/mpl-core-candy-machine";
import type { NftMintTarget, WalletRef } from "@mint-engine/core";
import { SolanaCoreCandyMachineAdapter } from "../src/index.js";

const RPC = process.env.E2E_SOLANA_RPC ?? "http://127.0.0.1:8899";
const WS = process.env.E2E_SOLANA_WS ?? "ws://127.0.0.1:8900";
const N = 10;
const PRICE_SOL = 0.1;

const isLocal = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(RPC);

describe.runIf(isLocal)("Core Candy Machine e2e (local validator)", () => {
  let conn: Connection;
  let umi: Umi;
  let adapter: SolanaCoreCandyMachineAdapter;
  let cmAddress: string;
  const wallets: Keypair[] = Array.from({ length: N }, () => Keypair.generate());
  const treasury = Keypair.generate();

  async function airdrop(pk: Keypair["publicKey"], sol: number) {
    const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  beforeAll(async () => {
    conn = new Connection(RPC, { commitment: "confirmed", wsEndpoint: WS });
    const authority = Keypair.generate();
    await airdrop(authority.publicKey, 100);
    await Promise.all(wallets.map((w) => airdrop(w.publicKey, 2)));

    umi = createUmi(RPC, { commitment: "confirmed" }).use(mplCore()).use(mplCandyMachine());
    umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(authority.secretKey)));

    const collection = generateSigner(umi);
    await createCollection(umi, { collection, name: "E2E", uri: "https://example.invalid/c.json" })
      .sendAndConfirm(umi);

    const candyMachine = generateSigner(umi);
    await (await create(umi, {
      candyMachine,
      collection: collection.publicKey,
      collectionUpdateAuthority: umi.identity,
      itemsAvailable: 20,
      hiddenSettings: some({ name: "E2E #$ID+1$", uri: "https://example.invalid/a.json", hash: new Uint8Array(32) }),
      configLineSettings: null,
      guards: {
        solPayment: some({ lamports: sol(PRICE_SOL), destination: toPk(treasury.publicKey.toBase58()) }),
        mintLimit: some({ id: 1, limit: 1 }),
      },
    })).sendAndConfirm(umi);
    cmAddress = candyMachine.publicKey;

    adapter = new SolanaCoreCandyMachineAdapter({ rpcUrl: RPC });
  }, 180_000);

  afterAll(() => { /* validator is torn down by the caller */ });

  const target = (): NftMintTarget => ({ kind: "nft", chain: "solana", address: cmAddress, quantity: 1 });
  const ref = (kp: Keypair, i: number): WalletRef =>
    ({ id: `w${i + 1}`, label: `Wallet ${i + 1}`, family: "solana", address: kp.publicKey.toBase58() });

  it("detects the live mint", async () => {
    const s = await adapter.detect(target());
    expect(s).toMatchObject({ live: true, pricePerUnit: String(PRICE_SOL * LAMPORTS_PER_SOL), maxPerWallet: 1, remainingSupply: 20 });
  });

  it("mints one asset from each of 10 wallets", async () => {
    const prepared = await Promise.all(wallets.map((w, i) => adapter.prepare(target(), ref(w, i), { priorityFee: "1000" })));
    const sigs = await Promise.all(prepared.map(async (p, i) => {
      const sim = await adapter.simulate(p);
      expect(sim.ok, sim.logs?.join("\n")).toBe(true);
      const tx = VersionedTransaction.deserialize(p.unsigned);
      tx.sign([wallets[i]!]); // wallet adds its signature; asset co-signature is kept
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const res = await conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: p.validUntil! }, "confirmed");
      expect(res.value.err).toBeNull();
      return sig;
    }));
    expect(new Set(sigs).size).toBe(N);
    for (const [i, sig] of sigs.entries()) {
      const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      expect(tx?.meta?.err).toBeNull();
      expect(tx?.transaction.message.staticAccountKeys[0]!.equals(wallets[i]!.publicKey)).toBe(true);
    }

    const cm = await fetchCandyMachine(umi, toPk(cmAddress));
    expect(cm.itemsRedeemed).toBe(BigInt(N));
    for (const w of wallets) {
      const pda = findMintCounterPda(umi, { id: 1, user: toPk(w.publicKey.toBase58()), candyMachine: cm.publicKey, candyGuard: cm.mintAuthority });
      expect((await safeFetchMintCounter(umi, pda))?.count).toBe(1);
    }
    expect(await conn.getBalance(treasury.publicKey)).toBe(N * PRICE_SOL * LAMPORTS_PER_SOL);
  }, 180_000);

  it("rejects a second mint from the same wallet", async () => {
    await expect(adapter.prepare(target(), ref(wallets[0]!, 0), {})).rejects.toThrow(/mintLimit reached/);
  });
});
