// "New mint" form model: state, validation and conversion to CreateJobRequest.
import {
  CHAIN_FAMILY, MAX_WALLETS_PER_JOB,
  type ChainFamily, type ChainId, type CreateJobRequest, type FeeStrategy, type GoLiveTrigger,
  type MintKind, type MintTarget, type NftMintTarget, type WalletRef,
} from "@mint-engine/core";
import { NATIVE, isDecimal, toBaseUnits, fromBaseUnits } from "./units";

export const CHAINS: ChainId[] = ["solana", "ethereum", "base", "robinhood"];
export const CHAIN_LABEL: Record<ChainId, string> = { solana: "Solana", ethereum: "Ethereum", base: "Base", robinhood: "Robinhood Chain" };

export type NftStyle = NonNullable<NftMintTarget["style"]>;
export const STYLES_BY_FAMILY: Record<ChainFamily, NftStyle[]> = {
  solana: ["core-candy-machine", "custom"],
  evm: ["seadrop", "zora-1155", "erc721a", "custom"],
};

export type TriggerType = GoLiveTrigger["type"];
export const TRIGGERS: { type: TriggerType; label: string }[] = [
  { type: "now", label: "Now" },
  { type: "time", label: "Time" },
  { type: "state-poll", label: "State poll" },
  { type: "event", label: "Event" },
  { type: "slot-or-block", label: "Block" },
];

export interface MintFormState {
  chain: ChainId;
  kind: MintKind;
  nft: { address: string; quantity: string; style: NftStyle | ""; tokenId: string; customSignature: string; customArgs: string };
  token: { tokenAddress: string; launchpadAddress: string; spend: string; slippageBps: string };
  walletIds: string[];
  /** priorityFee: Solana micro-lamports/CU, EVM gwei. maxFee: EVM gwei. jitoTip: SOL. maxTotalFee: native units. */
  fees: { priorityFee: string; maxFee: string; jitoTip: string; maxTotalFee: string; privateSubmission: boolean };
  trigger: { type: TriggerType; at: string; intervalMs: string; signature: string; block: string };
  maxRetries: string;
}

export function initialFormState(): MintFormState {
  return {
    chain: "base",
    kind: "nft",
    nft: { address: "", quantity: "1", style: "", tokenId: "", customSignature: "", customArgs: "[]" },
    token: { tokenAddress: "", launchpadAddress: "", spend: "", slippageBps: "300" },
    walletIds: [],
    fees: { priorityFee: "", maxFee: "", jitoTip: "", maxTotalFee: "", privateSubmission: false },
    trigger: { type: "now", at: "", intervalMs: "500", signature: "", block: "" },
    maxRetries: "2",
  };
}

export const familyOf = (chain: ChainId): ChainFamily => CHAIN_FAMILY[chain];

/** Wallets usable on the chain (family match). */
export function walletsForChain<W extends WalletRef>(wallets: W[], chain: ChainId): W[] {
  const fam = familyOf(chain);
  return wallets.filter((w) => w.family === fam);
}

/** Toggle a wallet in the selection; refuses to grow past MAX_WALLETS_PER_JOB. */
export function toggleWallet(selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  if (selected.length >= MAX_WALLETS_PER_JOB) return selected;
  return [...selected, id];
}

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INT = /^\d+$/;

export function isAddressFor(chain: ChainId, addr: string): boolean {
  return familyOf(chain) === "evm" ? EVM_ADDR.test(addr.trim()) : SOL_ADDR.test(addr.trim());
}

export type FormErrors = Partial<Record<string, string>>;

function checkAmount(errors: FormErrors, key: string, value: string, decimals: number, required: boolean, positive = false) {
  const v = value.trim();
  if (!v) {
    if (required) errors[key] = "Required";
    return;
  }
  if (!isDecimal(v)) {
    errors[key] = "Must be a number";
    return;
  }
  try {
    const base = toBaseUnits(v, decimals);
    if (positive && /^0+$/.test(base)) errors[key] = "Must be greater than 0";
  } catch (e) {
    errors[key] = (e as Error).message;
  }
}

export function validateForm(s: MintFormState, wallets: WalletRef[], now = Date.now()): FormErrors {
  const errors: FormErrors = {};
  const fam = familyOf(s.chain);
  const native = NATIVE[s.chain];
  const addrHint = fam === "evm" ? "0x + 40 hex chars" : "base58 address";

  if (s.kind === "nft") {
    const a = s.nft.address.trim();
    if (!a) errors["nft.address"] = "Required";
    else if (!isAddressFor(s.chain, a)) errors["nft.address"] = `Invalid ${fam === "evm" ? "EVM" : "Solana"} address (${addrHint})`;
    const q = s.nft.quantity.trim();
    if (!INT.test(q) || Number(q) < 1) errors["nft.quantity"] = "Whole number ≥ 1";
    else if (Number(q) > 100) errors["nft.quantity"] = "At most 100 per wallet";
    if (s.nft.style && !STYLES_BY_FAMILY[fam].includes(s.nft.style)) errors["nft.style"] = `Style not available on ${CHAIN_LABEL[s.chain]}`;
    // Token id only exists on EVM (the field is hidden on Solana).
    if (fam === "evm") {
      if (s.nft.style === "zora-1155" && !INT.test(s.nft.tokenId.trim())) errors["nft.tokenId"] = "Token id required for 1155";
      else if (s.nft.tokenId.trim() && !INT.test(s.nft.tokenId.trim())) errors["nft.tokenId"] = "Whole number";
    }
    if (s.nft.style === "custom") {
      if (!s.nft.customSignature.trim()) errors["nft.customSignature"] = "Required for custom style";
      try {
        const args: unknown = JSON.parse(s.nft.customArgs || "[]");
        if (!Array.isArray(args)) errors["nft.customArgs"] = "Must be a JSON array";
      } catch {
        errors["nft.customArgs"] = "Invalid JSON";
      }
    }
  } else {
    const t = s.token.tokenAddress.trim();
    if (!t) errors["token.tokenAddress"] = "Required";
    else if (!isAddressFor(s.chain, t)) errors["token.tokenAddress"] = `Invalid address (${addrHint})`;
    const l = s.token.launchpadAddress.trim();
    if (!l) errors["token.launchpadAddress"] = "Required";
    else if (!isAddressFor(s.chain, l)) errors["token.launchpadAddress"] = `Invalid address (${addrHint})`;
    checkAmount(errors, "token.spend", s.token.spend, native.decimals, true, true);
    const sl = s.token.slippageBps.trim();
    if (!INT.test(sl)) errors["token.slippageBps"] = "Required (whole bps)";
    else if (Number(sl) > 10_000) errors["token.slippageBps"] = "At most 10000 bps";
  }

  // Wallets
  const byId = new Map(wallets.map((w) => [w.id, w]));
  if (s.walletIds.length === 0) errors.walletIds = "Select at least one wallet";
  else if (s.walletIds.length > MAX_WALLETS_PER_JOB) errors.walletIds = `At most ${MAX_WALLETS_PER_JOB} wallets per job`;
  else if (new Set(s.walletIds).size !== s.walletIds.length) errors.walletIds = "Duplicate wallets selected";
  else {
    const bad = s.walletIds.filter((id) => byId.get(id)?.family !== fam);
    if (bad.length) errors.walletIds = `${bad.length} selected wallet(s) are not ${fam} wallets`;
  }

  // Fees
  if (fam === "solana") {
    if (s.fees.priorityFee.trim() && !INT.test(s.fees.priorityFee.trim())) errors["fees.priorityFee"] = "Whole micro-lamports/CU";
    checkAmount(errors, "fees.jitoTip", s.fees.jitoTip, 9, false);
  } else {
    checkAmount(errors, "fees.priorityFee", s.fees.priorityFee, 9, false);
    checkAmount(errors, "fees.maxFee", s.fees.maxFee, 9, false);
  }
  checkAmount(errors, "fees.maxTotalFee", s.fees.maxTotalFee, native.decimals, false);

  // Trigger
  const tr = s.trigger;
  if (tr.type === "time") {
    const at = new Date(tr.at).getTime();
    if (!tr.at || Number.isNaN(at)) errors["trigger.at"] = "Pick a date and time";
    else if (at <= now) errors["trigger.at"] = "Must be in the future";
  } else if (tr.type === "state-poll") {
    if (!INT.test(tr.intervalMs.trim()) || Number(tr.intervalMs) < 50) errors["trigger.intervalMs"] = "Interval ≥ 50 ms";
  } else if (tr.type === "slot-or-block") {
    if (!INT.test(tr.block.trim()) || Number(tr.block) < 1) errors["trigger.block"] = `${fam === "solana" ? "Slot" : "Block"} number required`;
  }

  const r = s.maxRetries.trim();
  if (r && (!INT.test(r) || Number(r) > 20)) errors.maxRetries = "0–20";
  return errors;
}

function buildTarget(s: MintFormState): MintTarget {
  if (s.kind === "nft") {
    const t: NftMintTarget = { kind: "nft", chain: s.chain, address: s.nft.address.trim(), quantity: Number(s.nft.quantity) };
    if (s.nft.style) t.style = s.nft.style;
    if (familyOf(s.chain) === "evm" && s.nft.tokenId.trim()) t.tokenId = s.nft.tokenId.trim();
    if (s.nft.style === "custom") t.customFunction = { signature: s.nft.customSignature.trim(), args: JSON.parse(s.nft.customArgs || "[]") as unknown[] };
    return t;
  }
  return {
    kind: "token",
    chain: s.chain,
    tokenAddress: s.token.tokenAddress.trim(),
    launchpadAddress: s.token.launchpadAddress.trim(),
    spendPerWallet: toBaseUnits(s.token.spend, NATIVE[s.chain].decimals),
    slippageBps: Number(s.token.slippageBps),
  };
}

function buildFees(s: MintFormState): FeeStrategy {
  const f: FeeStrategy = {};
  const fam = familyOf(s.chain);
  const pf = s.fees.priorityFee.trim();
  if (fam === "solana") {
    if (pf) f.priorityFee = String(BigInt(pf));
    if (s.fees.jitoTip.trim()) f.jitoTip = toBaseUnits(s.fees.jitoTip, 9);
  } else {
    if (pf) f.priorityFee = toBaseUnits(pf, 9);
    if (s.fees.maxFee.trim()) f.maxFee = toBaseUnits(s.fees.maxFee, 9);
    if (s.chain === "ethereum" && s.fees.privateSubmission) f.privateSubmission = true;
  }
  if (s.fees.maxTotalFee.trim()) f.maxTotalFee = toBaseUnits(s.fees.maxTotalFee, NATIVE[s.chain].decimals);
  return f;
}

function buildTrigger(s: MintFormState): GoLiveTrigger {
  const t = s.trigger;
  switch (t.type) {
    case "now": return { type: "now" };
    case "time": return { type: "time", at: new Date(t.at).getTime() };
    case "state-poll": return { type: "state-poll", intervalMs: Number(t.intervalMs) };
    case "event": return t.signature.trim() ? { type: "event", signature: t.signature.trim() } : { type: "event" };
    case "slot-or-block": return { type: "slot-or-block", at: Number(t.block) };
  }
}

/** Assumes validateForm returned no errors. */
export function buildRequest(s: MintFormState): CreateJobRequest {
  const req: CreateJobRequest = { target: buildTarget(s), walletIds: [...s.walletIds], fees: buildFees(s), trigger: buildTrigger(s) };
  if (s.maxRetries.trim()) req.maxRetries = Number(s.maxRetries);
  return req;
}

/** Human-readable pre-flight lines for the confirm step. */
export function preflightLines(req: CreateJobRequest, wallets: WalletRef[]): [string, string][] {
  const chain = req.target.chain;
  const n = NATIVE[chain];
  const fam = familyOf(chain);
  const lines: [string, string][] = [["Chain", CHAIN_LABEL[chain]]];
  const t = req.target;
  if (t.kind === "nft") {
    lines.push(["Kind", "NFT drop"], ["Collection", t.address], ["Qty / wallet", String(t.quantity)]);
    lines.push(["Style", t.style ?? "auto-detect"]);
    if (t.tokenId) lines.push(["Token id", t.tokenId]);
    if (t.customFunction) lines.push(["Function", `${t.customFunction.signature} ${JSON.stringify(t.customFunction.args)}`]);
  } else {
    const total = (BigInt(t.spendPerWallet) * BigInt(req.walletIds.length)).toString();
    lines.push(["Kind", "Token launch"], ["Token", t.tokenAddress], ["Launchpad", t.launchpadAddress]);
    lines.push(["Spend / wallet", `${fromBaseUnits(t.spendPerWallet, n.decimals)} ${n.symbol}`]);
    lines.push(["Spend total", `${fromBaseUnits(total, n.decimals)} ${n.symbol}`]);
    lines.push(["Slippage", `${t.slippageBps} bps (${(t.slippageBps / 100).toFixed(2)}%)`]);
  }
  const labels = req.walletIds.map((id) => wallets.find((w) => w.id === id)?.label ?? id);
  lines.push(["Wallets", `${req.walletIds.length}: ${labels.join(", ")}`]);
  const f = req.fees;
  if (fam === "solana") {
    lines.push(["Priority fee", f.priorityFee ? `${f.priorityFee} µlamports/CU` : "auto"]);
    lines.push(["Jito tip", f.jitoTip ? `${fromBaseUnits(f.jitoTip, 9, 9)} SOL` : "none"]);
  } else {
    lines.push(["Priority fee", f.priorityFee ? `${fromBaseUnits(f.priorityFee, 9, 9)} gwei` : "auto"]);
    lines.push(["Max fee/gas", f.maxFee ? `${fromBaseUnits(f.maxFee, 9, 9)} gwei` : "auto"]);
    if (chain === "ethereum") lines.push(["Submission", f.privateSubmission ? "private relay" : "public mempool"]);
  }
  lines.push(["Max total fee", f.maxTotalFee ? `${fromBaseUnits(f.maxTotalFee, n.decimals, 9)} ${n.symbol} / tx` : "no cap"]);
  const tr = req.trigger;
  const trig =
    tr.type === "now" ? "immediately" :
    tr.type === "time" ? new Date(tr.at).toLocaleString() :
    tr.type === "state-poll" ? `poll mint state every ${tr.intervalMs} ms` :
    tr.type === "event" ? `on event${tr.signature ? ` ${tr.signature}` : " (adapter default)"}` :
    `at ${fam === "solana" ? "slot" : "block"} ${tr.at}`;
  lines.push(["Trigger", trig], ["Max retries", String(req.maxRetries ?? "default")]);
  return lines;
}
