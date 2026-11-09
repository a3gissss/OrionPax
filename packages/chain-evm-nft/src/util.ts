import {
  BaseError, bytesToHex, decodeErrorResult, getAddress, hexToBytes, parseAbiItem, parseTransaction, serializeTransaction,
  toFunctionSelector, type AbiFunction, type Address, type Hex,
} from "viem";
import { knownErrorsAbi } from "./abis.js";

// ---------- bytecode selector probing ----------

/**
 * Does the runtime bytecode dispatch on this function? Walks the opcodes (skipping PUSH data correctly)
 * looking for `PUSH4 <selector>`, or `PUSH3` for selectors with a leading zero byte.
 */
export function hasSelector(bytecode: Hex | undefined, signature: string): boolean {
  if (!bytecode || bytecode === "0x") return false;
  const sel = toFunctionSelector(signature).slice(2).toLowerCase();
  const short = sel.startsWith("00") ? sel.slice(2) : undefined;
  const code = bytecode.toLowerCase().replace(/^0x/, "");
  for (let i = 0; i + 2 <= code.length;) {
    const op = parseInt(code.slice(i, i + 2), 16);
    i += 2;
    if (op >= 0x60 && op <= 0x7f) {
      const n = (op - 0x5f) * 2;
      const data = code.slice(i, i + n);
      if (op === 0x63 && data === sel) return true;
      if (op === 0x62 && short !== undefined && data === short) return true;
      i += n;
    }
  }
  return false;
}

const EIP1167_PREFIX = "363d3d373d3d3d363d73";

/** If `bytecode` is an EIP-1167 minimal proxy, return its implementation. */
export function eip1167Target(bytecode: Hex | undefined): Address | undefined {
  if (!bytecode) return undefined;
  const code = bytecode.toLowerCase().replace(/^0x/, "");
  const at = code.indexOf(EIP1167_PREFIX);
  if (at !== 0 && at !== 2) return undefined;
  const start = at + EIP1167_PREFIX.length;
  return getAddress(`0x${code.slice(start, start + 40)}`);
}

/** Address stored right-aligned in a 32-byte storage word, or undefined when empty. */
export function slotToAddress(word: Hex | undefined): Address | undefined {
  if (!word) return undefined;
  const hex = word.replace(/^0x/, "").padStart(64, "0");
  const addr = hex.slice(24);
  if (/^0+$/.test(addr)) return undefined;
  return getAddress(`0x${addr}`);
}

// ---------- custom function ----------

/** Parse a custom function signature like `mint(uint256)` or `function mint(uint256 q) payable`. */
export function parseCustomFunction(signature: string): AbiFunction {
  const sig = signature.trim().startsWith("function ") ? signature.trim() : `function ${signature.trim()}`;
  const item = parseAbiItem(sig) as unknown;
  if (!item || typeof item !== "object" || (item as { type?: string }).type !== "function") {
    throw new Error(`customFunction.signature is not a function: ${signature}`);
  }
  return item as AbiFunction;
}

/**
 * Coerce JSON-ish args into viem-encodable values.
 * Placeholders: "$quantity" → mint quantity, "$wallet" → minting wallet address.
 * Integer params accept number / decimal string / bigint.
 */
export function coerceArgs(fn: AbiFunction, args: unknown[], ctx: { quantity: number; wallet: Address }): unknown[] {
  if (args.length !== fn.inputs.length) {
    throw new Error(`customFunction ${fn.name} expects ${fn.inputs.length} args, got ${args.length}`);
  }
  return fn.inputs.map((input, i) => {
    let v = args[i];
    if (v === "$quantity") v = ctx.quantity;
    if (v === "$wallet") v = ctx.wallet;
    if (/^u?int\d*$/.test(input.type) && (typeof v === "number" || typeof v === "string")) {
      if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error(`arg ${i} is not an integer: ${v}`);
      return BigInt(v);
    }
    return v;
  });
}

// ---------- revert decoding ----------

/** Find raw revert data anywhere in a viem error chain. */
export function extractRevertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d) && d.length >= 10) return d as Hex;
    if (d && typeof d === "object") {
      const inner = (d as { data?: unknown }).data;
      if (typeof inner === "string" && /^0x[0-9a-fA-F]*$/.test(inner) && inner.length >= 10) return inner as Hex;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Turn revert data into a human-readable reason. */
export function decodeRevertData(data: Hex): string {
  try {
    const r = decodeErrorResult({ abi: knownErrorsAbi, data });
    if (r.errorName === "Error") return String(r.args?.[0] ?? "");
    if (r.errorName === "Panic") return `Panic(0x${(r.args?.[0] as bigint).toString(16)})`;
    const args = (r.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
    return `${r.errorName}(${args.join(", ")})`;
  } catch {
    return `unknown error ${data.slice(0, 10)} (${data})`;
  }
}

/** Best-effort human-readable reason for any RPC/call failure. */
export function revertReason(err: unknown): string {
  const data = extractRevertData(err);
  if (data) return decodeRevertData(data);
  if (err instanceof BaseError) {
    // viem sometimes already decoded `reason` (e.g. "execution reverted: Sale not active").
    const reason = (err.walk((e) => typeof (e as { reason?: unknown }).reason === "string") as { reason?: string } | null)?.reason;
    if (reason) return reason;
    return err.details || err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------- tx helpers ----------

/**
 * Re-serialize an unsigned EIP-1559 tx produced by `prepare` with the real nonce.
 * Routers / the engine call this before handing bytes to the signer when the adapter
 * was constructed without a `nonceProvider` (prepare then emits a `nonce: 0` placeholder).
 */
export function withNonce(unsigned: Uint8Array, nonce: number): Uint8Array {
  const tx = parseTransaction(bytesToHex(unsigned));
  if (tx.type !== "eip1559") throw new Error(`expected eip1559 tx, got ${tx.type}`);
  return hexToBytes(serializeTransaction({ ...tx, nonce }));
}

/** Number from bigint when it fits in a JS safe integer, else undefined (e.g. "unlimited" sentinels). */
export function safeNum(v: bigint): number | undefined {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined;
}
