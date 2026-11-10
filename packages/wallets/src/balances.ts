// Native balance reads through a caller-supplied RPC URL.

import { address as solAddress, createSolanaRpc } from "@solana/kit";
import { CHAIN_FAMILY, type ChainId, type WalletRef } from "@mint-engine/core";
import { createPublicClient, http, type Address } from "viem";
import { VaultError } from "./errors.js";

/** Returns lamports (Solana) or wei (EVM) as a decimal string. */
export async function readBalance(wallet: WalletRef, chain: ChainId, rpcUrl: string): Promise<string> {
  if (CHAIN_FAMILY[chain] === undefined) throw new VaultError(`Unknown chain ${JSON.stringify(chain)}`, "INVALID_INPUT");
  if (CHAIN_FAMILY[chain] !== wallet.family) {
    throw new VaultError(`Wallet ${wallet.id} is a ${wallet.family} wallet and has no balance on ${chain}`, "FAMILY_MISMATCH");
  }
  try {
    if (wallet.family === "solana") {
      const rpc = createSolanaRpc(rpcUrl);
      const res = await rpc.getBalance(solAddress(wallet.address), { commitment: "confirmed" }).send();
      return res.value.toString();
    }
    const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
    return (await client.getBalance({ address: wallet.address as Address })).toString();
  } catch (e) {
    const reason = e instanceof Error ? e.message.split("\n")[0] : "unknown error";
    throw new VaultError(`Balance read for ${wallet.id} on ${chain} failed: ${reason}`, "RPC");
  }
}
