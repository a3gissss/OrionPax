import type { PreparedTx } from "@mint-engine/core";
import {
  bytesToHex,
  hexToBytes,
  parseTransaction,
  serializeTransaction,
  type TransactionSerializableEIP1559,
  type TransactionSerializable,
} from "viem";

export interface TxPatch {
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gas?: bigint;
  chainId?: number;
}

/** Decode an unsigned (or signed) serialized EVM tx. */
export function decodeUnsigned(unsigned: Uint8Array): TransactionSerializable {
  const parsed = parseTransaction(bytesToHex(unsigned)) as TransactionSerializable & {
    r?: unknown; s?: unknown; v?: unknown; yParity?: unknown;
  };
  const { r: _r, s: _s, v: _v, yParity: _y, ...rest } = parsed;
  return rest as TransactionSerializable;
}

/**
 * Patch nonce + EIP-1559 fees into a serialized unsigned tx; returns a new serialized unsigned
 * EIP-1559 tx ready for `WalletSigner.signTransaction`. Legacy / EIP-2930 inputs are upgraded to 1559.
 */
export function patchUnsignedTx(unsigned: Uint8Array, patch: TxPatch): Uint8Array {
  const tx = decodeUnsigned(unsigned) as Record<string, unknown>;
  if (tx.type === "eip4844" || tx.type === "eip7702") {
    // Re-serializing as 1559 would drop blob / authorization fields.
    throw new Error(`patchUnsignedTx: ${String(tx.type)} transactions are not supported`);
  }
  const chainId = patch.chainId ?? (tx.chainId as number | undefined);
  if (chainId === undefined) throw new Error("patchUnsignedTx: chainId missing (pass patch.chainId)");
  const maxFeePerGas = patch.maxFeePerGas ?? (tx.maxFeePerGas as bigint | undefined) ?? (tx.gasPrice as bigint | undefined);
  if (maxFeePerGas === undefined) throw new Error("patchUnsignedTx: maxFeePerGas missing (pass patch.maxFeePerGas)");
  let maxPriorityFeePerGas =
    patch.maxPriorityFeePerGas ?? (tx.maxPriorityFeePerGas as bigint | undefined) ?? maxFeePerGas;
  if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
  const out: TransactionSerializableEIP1559 = {
    type: "eip1559",
    chainId,
    nonce: patch.nonce ?? (tx.nonce as number | undefined),
    to: tx.to as TransactionSerializableEIP1559["to"],
    value: tx.value as bigint | undefined,
    data: tx.data as TransactionSerializableEIP1559["data"],
    gas: patch.gas ?? (tx.gas as bigint | undefined),
    accessList: tx.accessList as TransactionSerializableEIP1559["accessList"],
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  return hexToBytes(serializeTransaction(out));
}

/** Same as patchUnsignedTx, but on a PreparedTx (returns a copy). */
export function patchPrepared(prepared: PreparedTx, patch: TxPatch): PreparedTx {
  return { ...prepared, unsigned: patchUnsignedTx(prepared.unsigned, patch) };
}
