// Local-validator helpers for e2e tests. Only ever points at a local RPC.

import { readFileSync } from "node:fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction, type Signer,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "../../src/index.js";

export const RPC_URL = process.env.E2E_SOLANA_RPC ?? "http://127.0.0.1:8899";
export const WS_URL = process.env.E2E_SOLANA_WS ?? "ws://127.0.0.1:8900";

const host = new URL(RPC_URL).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  throw new Error(`refusing to run e2e against non-local RPC ${RPC_URL}`);
}

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function connect(): Connection {
  return new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL });
}

export async function waitForSignatures(conn: Connection, sigs: string[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(sigs);
  const results = new Map<string, { slot: number; err: unknown }>();
  while (pending.size > 0) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pending.size} signatures`);
    const list = [...pending];
    const { value } = await conn.getSignatureStatuses(list);
    value.forEach((st, i) => {
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        results.set(list[i]!, { slot: st.slot, err: st.err });
        pending.delete(list[i]!);
      }
    });
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

export async function sendAndWait(conn: Connection, ixs: TransactionInstruction[], signers: Signer[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const res = (await waitForSignatures(conn, [sig])).get(sig)!;
  if (res.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.err)}`);
  return sig;
}

export async function airdrop(conn: Connection, to: PublicKey[], sol: number) {
  const sigs = await Promise.all(to.map((pk) => conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)));
  await waitForSignatures(conn, sigs);
}

export async function waitForRpc(conn: Connection, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await conn.getLatestBlockhash();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`local validator at ${RPC_URL} not reachable: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64(n: bigint | number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** Deploy an SBF program with the upgradeable loader (InitializeBuffer / Write / DeployWithMaxDataLen). */
export async function deployProgram(conn: Connection, payer: Keypair, soPath: string): Promise<PublicKey> {
  const elf = readFileSync(soPath);
  const buffer = Keypair.generate();
  const program = Keypair.generate();
  const bufferLen = 37 + elf.length;

  await sendAndWait(conn, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: buffer.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(bufferLen), space: bufferLen, programId: BPF_UPGRADEABLE_LOADER,
    }),
    new TransactionInstruction({
      programId: BPF_UPGRADEABLE_LOADER,
      keys: [
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      ],
      data: u32(0),
    }),
  ], [payer, buffer]);

  const CHUNK = 900;
  const writes: Promise<string>[] = [];
  for (let off = 0; off < elf.length; off += CHUNK) {
    const bytes = elf.subarray(off, off + CHUNK);
    writes.push(sendAndWait(conn, [new TransactionInstruction({
      programId: BPF_UPGRADEABLE_LOADER,
      keys: [
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([u32(1), u32(off), u64(bytes.length), bytes]),
    })], [payer]));
  }
  await Promise.all(writes);

  const [programData] = PublicKey.findProgramAddressSync([program.publicKey.toBuffer()], BPF_UPGRADEABLE_LOADER);
  await sendAndWait(conn, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: program.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(36), space: 36, programId: BPF_UPGRADEABLE_LOADER,
    }),
    new TransactionInstruction({
      programId: BPF_UPGRADEABLE_LOADER,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: program.publicKey, isSigner: false, isWritable: true },
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([u32(2), u64(elf.length * 2)]),
    }),
  ], [payer, program]);

  // Programs become invocable from the slot after deployment.
  const slot = await conn.getSlot("confirmed");
  while ((await conn.getSlot("confirmed")) < slot + 2) await new Promise((r) => setTimeout(r, 200));
  return program.publicKey;
}

// ---- SPL Token (hand-encoded) ----

export async function createMint(conn: Connection, payer: Keypair, decimals: number): Promise<Keypair> {
  const mint = Keypair.generate();
  await sendAndWait(conn, [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
      // InitializeMint2: tag 20, decimals, mint authority, no freeze authority.
      data: Buffer.concat([Buffer.from([20, decimals]), payer.publicKey.toBuffer(), Buffer.from([0])]),
    }),
  ], [payer, mint]);
  return mint;
}

export function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([7]), u64(amount)]),
  });
}

export async function tokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, "confirmed");
  if (!info) return 0n;
  return info.data.readBigUInt64LE(64);
}

// ---- Fixture program admin instructions ----

export function initGlobalIx(programId: PublicKey, authority: PublicKey, feeRecipient: PublicKey, feeBps: bigint) {
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.alloc(8, 0xf1), u64(feeBps), feeRecipient.toBuffer()]),
  });
}

export function createCurveIx(
  programId: PublicKey, authority: PublicKey, mint: PublicKey, curve: PublicKey,
  p: { vTok: bigint; vSol: bigint; realTok: bigint; supply: bigint },
) {
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.alloc(8, 0xf2), u64(p.vTok), u64(p.vSol), u64(p.realTok), u64(p.supply)]),
  });
}

export function setCompleteIx(programId: PublicKey, authority: PublicKey, curve: PublicKey) {
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
    ],
    data: Buffer.alloc(8, 0xf3),
  });
}
