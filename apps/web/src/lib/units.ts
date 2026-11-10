// Decimal-string <-> base-unit conversion without floating point.
import type { ChainId } from "@mint-engine/core";

export const NATIVE: Record<ChainId, { symbol: string; decimals: number }> = {
  solana: { symbol: "SOL", decimals: 9 },
  ethereum: { symbol: "ETH", decimals: 18 },
  base: { symbol: "ETH", decimals: 18 },
  robinhood: { symbol: "ETH", decimals: 18 },
};

const DECIMAL_RE = /^\d+(\.\d+)?$/;

export function isDecimal(s: string): boolean {
  return DECIMAL_RE.test(s.trim());
}

/** "1.5" with 9 decimals -> "1500000000". Throws on malformed input or too many fraction digits. */
export function toBaseUnits(amount: string, decimals: number): string {
  const s = amount.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`not a decimal number: "${amount}"`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  const digits = (whole + frac.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  return digits === "" ? "0" : digits;
}

/** "1500000000" with 9 decimals -> "1.5". Non-integer input is returned unchanged. */
export function fromBaseUnits(base: string, decimals: number, maxFrac = 6): string {
  if (!/^\d+$/.test(base)) return base;
  const padded = base.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  let frac = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function shortId(id: string, head = 6, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
