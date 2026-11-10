// In-memory Solana RPC + Core Candy Machine account fixtures for unit tests.
// No network: account bytes are produced with the program's own serializers.

import {
  generateSigner, none, publicKey, sol, some, dateTime, type PublicKey, type Umi, type RpcInterface,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58, base64 } from "@metaplex-foundation/umi/serializers";
import {
  findCandyGuardPda, findMintCounterPda, getCandyGuardAccountDataSerializer,
  getMintCounterAccountDataSerializer, mplCandyMachine,
} from "@metaplex-foundation/mpl-core-candy-machine";
// The hooked (items-aware) serializer has no `serialize` for the hidden section, so use the generated base one.
import { getCandyMachineAccountDataSerializer } from "@metaplex-foundation/mpl-core-candy-machine/dist/src/generated/types/candyMachineAccountData.js";
import { CORE_CANDY_GUARD_PROGRAM_ID, CORE_CANDY_MACHINE_PROGRAM_ID } from "../src/adapter.js";

export interface SimCall { tx: string; config: Record<string, unknown> }

export class MockRpc {
  accounts = new Map<string, { data: Uint8Array; owner: string; lamports?: bigint }>();
  simCalls: SimCall[] = [];
  simResult: { err: unknown; logs: string[]; unitsConsumed?: number } = {
    err: null, logs: ["Program log: Instruction: MintV1"], unitsConsumed: 100_000,
  };
  blockhash = base58.deserialize(new Uint8Array(32).fill(7))[0];

  asRpc(): RpcInterface {
    const self = this;
    const rpc: Partial<RpcInterface> = {
      getEndpoint: () => "http://mock.localhost",
      getCluster: () => "localnet",
      async getAccount(pk: PublicKey) {
        const a = self.accounts.get(pk);
        if (!a) return { exists: false, publicKey: pk };
        return {
          exists: true, publicKey: pk, data: a.data, executable: false,
          owner: publicKey(a.owner), lamports: sol(1), rentEpoch: 0n,
        } as never;
      },
      async getAccounts(pks: PublicKey[]) { return Promise.all(pks.map((p) => rpc.getAccount!(p))); },
      async getLatestBlockhash() { return { blockhash: self.blockhash, lastValidBlockHeight: 1234 }; },
      async call<R>(method: string, params?: unknown[]): Promise<R> {
        if (method !== "simulateTransaction") throw new Error(`unexpected rpc ${method}`);
        self.simCalls.push({ tx: params![0] as string, config: params![1] as Record<string, unknown> });
        return { context: { slot: 1 }, value: self.simResult } as R;
      },
    };
    return rpc as RpcInterface;
  }
}

export interface FixtureOptions {
  itemsAvailable?: number;
  itemsRedeemed?: number;
  priceSol?: number;
  mintLimit?: number | null;
  startDate?: number | null; // unix seconds
  extraGuards?: Record<string, unknown>;
  groups?: boolean;
}

export interface Fixture {
  umi: Umi;
  rpc: MockRpc;
  candyMachine: PublicKey;
  candyGuard: PublicKey;
  collection: PublicKey;
  treasury: PublicKey;
  setMintCounter(user: PublicKey, count: number): void;
}

export function buildFixture(opts: FixtureOptions = {}): Fixture {
  const rpc = new MockRpc();
  const umi = createUmi("http://127.0.0.1:1");
  umi.rpc = rpc.asRpc();
  umi.use(mplCandyMachine());

  const candyMachine = generateSigner(umi).publicKey;
  const collection = generateSigner(umi).publicKey;
  const treasury = generateSigner(umi).publicKey;
  const authority = generateSigner(umi).publicKey;
  const [candyGuard, bump] = findCandyGuardPda(umi, { base: candyMachine });

  const cmData = getCandyMachineAccountDataSerializer().serialize({
    authority,
    mintAuthority: candyGuard,
    collectionMint: collection,
    itemsRedeemed: opts.itemsRedeemed ?? 3,
    data: {
      itemsAvailable: opts.itemsAvailable ?? 10,
      maxEditionSupply: 0,
      isMutable: true,
      configLineSettings: none(),
      hiddenSettings: some({ name: "Test #$ID+1$", uri: "https://example.invalid/x.json", hash: new Uint8Array(32) }),
    },
  });
  rpc.accounts.set(candyMachine, { data: cmData, owner: CORE_CANDY_MACHINE_PROGRAM_ID });

  const guards: Record<string, unknown> = {
    solPayment: some({ lamports: sol(opts.priceSol ?? 0.1), destination: treasury }),
    ...(opts.mintLimit === null ? {} : { mintLimit: some({ id: 1, limit: opts.mintLimit ?? 1 }) }),
    ...(opts.startDate === null || opts.startDate === undefined ? {} : { startDate: some({ date: dateTime(opts.startDate) }) }),
    ...(opts.extraGuards ?? {}),
  };
  const guardData = getCandyGuardAccountDataSerializer(umi).serialize({
    base: candyMachine,
    bump,
    authority,
    guards,
    groups: opts.groups ? [{ label: "public", guards: {} }] : [],
  } as never);
  rpc.accounts.set(candyGuard, { data: guardData, owner: CORE_CANDY_GUARD_PROGRAM_ID });

  return {
    umi, rpc, candyMachine, candyGuard, collection, treasury,
    setMintCounter(user, count) {
      const [pda] = findMintCounterPda(umi, { id: 1, user, candyMachine, candyGuard });
      rpc.accounts.set(pda, { data: getMintCounterAccountDataSerializer().serialize({ count }), owner: CORE_CANDY_GUARD_PROGRAM_ID });
    },
  };
}

export function decodeBase64(s: string): Uint8Array {
  return base64.serialize(s);
}
