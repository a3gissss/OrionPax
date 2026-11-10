// Tiny Solana JSON-RPC client + throwaway keypairs (node:crypto ed25519). Local validator only.
import { generateKeyPairSync } from "node:crypto";
import { assertLocalRpc } from "../env.js";
import { base58Encode } from "./base58.js";

export interface SolanaKeypair {
  /** base58 public key */
  publicKey: string;
  /** solana-keygen JSON format: 64 bytes = 32-byte seed || 32-byte public key */
  secretKey: number[];
}

export function generateSolanaKeypair(): SolanaKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  return { publicKey: base58Encode(pub), secretKey: [...seed, ...pub] };
}

let rpcId = 0;

export async function solanaRpc<T>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  assertLocalRpc(rpcUrl);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

export async function getSolanaBalance(rpcUrl: string, address: string): Promise<bigint> {
  const r = await solanaRpc<{ value: number }>(rpcUrl, "getBalance", [address, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

/** Airdrop (local validator faucet) and wait until the signature is confirmed. */
export async function airdropAndConfirm(rpcUrl: string, address: string, lamports: bigint, timeoutMs = 30_000): Promise<string> {
  const sig = await solanaRpc<string>(rpcUrl, "requestAirdrop", [address, Number(lamports), { commitment: "confirmed" }]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await solanaRpc<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>(rpcUrl, "getSignatureStatuses", [[sig]]);
    const s = st.value[0];
    if (s?.err) throw new Error(`airdrop ${sig} failed: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return sig;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`airdrop ${sig} not confirmed within ${timeoutMs}ms`);
}

/** Resolves once the validator answers getHealth = "ok" (or throws after timeout). */
export async function waitForSolanaValidator(rpcUrl: string, timeoutMs = 60_000): Promise<{ solanaCore: string }> {
  assertLocalRpc(rpcUrl); // fail fast; don't retry a refused URL until timeout
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const health = await solanaRpc<string>(rpcUrl, "getHealth");
      if (health === "ok") return await solanaRpc<{ "solana-core": string }>(rpcUrl, "getVersion").then((v) => ({ solanaCore: v["solana-core"] }));
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`solana validator at ${rpcUrl} not healthy within ${timeoutMs}ms: ${String(last)}`);
}
