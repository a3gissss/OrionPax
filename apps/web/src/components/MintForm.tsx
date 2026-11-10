import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_WALLETS_PER_JOB, type ChainId, type CreateJobRequest, type MintKind, type WalletView } from "@mint-engine/core";
import {
  CHAINS, CHAIN_LABEL, STYLES_BY_FAMILY, TRIGGERS, buildRequest, familyOf, initialFormState, preflightLines,
  toggleWallet, validateForm, walletsForChain, type FormErrors, type MintFormState, type NftStyle, type TriggerType,
} from "../lib/form";
import { NATIVE, fromBaseUnits, shortId } from "../lib/units";
import { Field, Panel } from "./common";

interface Props {
  wallets: WalletView[];
  disabled?: boolean;
  onSubmit: (req: CreateJobRequest) => Promise<void>;
}

export function MintForm({ wallets, disabled, onSubmit }: Props) {
  const [s, setS] = useState<MintFormState>(initialFormState);
  const [showErrors, setShowErrors] = useState(false);
  const [review, setReview] = useState<CreateJobRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const fam = familyOf(s.chain);
  const native = NATIVE[s.chain];
  const eligible = useMemo(() => walletsForChain(wallets, s.chain), [wallets, s.chain]);
  // Display-only errors; review/confirm re-validate with a fresh clock (time triggers).
  const errors: FormErrors = useMemo(() => validateForm(s, wallets), [s, wallets]);
  const err = (k: string) => (showErrors ? errors[k] : undefined);
  const atCap = s.walletIds.length >= MAX_WALLETS_PER_JOB;

  // Drop selections that no longer exist (vault relocked / wallet removed).
  useEffect(() => {
    setS((p) => {
      const ids = p.walletIds.filter((id) => wallets.some((w) => w.id === id));
      return ids.length === p.walletIds.length ? p : { ...p, walletIds: ids };
    });
  }, [wallets]);

  useEffect(() => {
    if (review) confirmRef.current?.focus();
  }, [review]);

  // A pending review is a snapshot: drop it if the vault locks or the wallet set changes.
  useEffect(() => {
    setReview(null);
  }, [wallets, disabled]);

  const set = <K extends keyof MintFormState>(k: K, v: MintFormState[K]) => setS((p) => ({ ...p, [k]: v }));
  const setNested = <K extends "nft" | "token" | "fees" | "trigger">(k: K, patch: Partial<MintFormState[K]>) =>
    setS((p) => ({ ...p, [k]: { ...p[k], ...patch } }));

  const changeChain = (chain: ChainId) =>
    setS((p) => {
      const f = familyOf(chain);
      const style = p.nft.style && !STYLES_BY_FAMILY[f].includes(p.nft.style) ? "" : p.nft.style;
      // Family filter: drop selected wallets that cannot sign on the new chain.
      const walletIds = p.walletIds.filter((id) => wallets.find((w) => w.id === id)?.family === f);
      const tokenId = f === "evm" ? p.nft.tokenId : "";
      return { ...p, chain, walletIds, nft: { ...p.nft, style, tokenId }, fees: { ...p.fees, privateSubmission: chain === "ethereum" && p.fees.privateSubmission } };
    });

  const startReview = () => {
    setShowErrors(true);
    setSubmitError(null);
    if (disabled || Object.keys(validateForm(s, wallets, Date.now())).length > 0) return;
    setReview(buildRequest(s));
  };

  const confirm = async () => {
    if (!review || disabled || submitting) return;
    if (Object.keys(validateForm(s, wallets, Date.now())).length > 0) {
      // e.g. the scheduled go-live time passed while the review was open.
      setReview(null);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(review);
      setReview(null);
      setShowErrors(false);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const id = (k: string) => `mf-${k.replace(".", "-")}`;
  const errorCount = Object.keys(errors).length;

  return (
    <Panel
      title="New mint"
      id="new-mint"
      right={<span className="kbd-hint">Alt+N focus · Ctrl+Enter review</span>}
    >
      <form
        className="mint-form"
        noValidate
        aria-label="New mint"
        onSubmit={(e) => {
          e.preventDefault();
          startReview();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!review) startReview();
            else void confirm();
          }
          if (e.key === "Escape" && review) {
            e.preventDefault();
            setReview(null);
          }
        }}
      >
        <fieldset disabled={disabled || !!review || submitting} className="form-main">
          <div className="row">
            <Field label="Chain" htmlFor={id("chain")}>
              <select id={id("chain")} value={s.chain} onChange={(e) => changeChain(e.target.value as ChainId)}>
                {CHAINS.map((c) => <option key={c} value={c}>{CHAIN_LABEL[c]}</option>)}
              </select>
            </Field>
            <div className="field">
              <span className="label" id="kind-label">Kind</span>
              <div className="seg" role="radiogroup" aria-labelledby="kind-label">
                {(["nft", "token"] as MintKind[]).map((k) => (
                  <label key={k} className={`seg-item${s.kind === k ? " on" : ""}`}>
                    <input type="radio" name="kind" value={k} checked={s.kind === k} onChange={() => set("kind", k)} />
                    {k === "nft" ? "NFT drop" : "Token launch"}
                  </label>
                ))}
              </div>
            </div>
          </div>

          {s.kind === "nft" ? (
            <>
              <Field label={fam === "solana" ? "Candy Machine address" : "Collection contract"} htmlFor={id("nft.address")} error={err("nft.address")}>
                <input id={id("nft.address")} className="mono" spellCheck={false} placeholder={fam === "evm" ? "0x…" : "base58…"} value={s.nft.address} onChange={(e) => setNested("nft", { address: e.target.value })} />
              </Field>
              <div className="row row-3">
                <Field label="Qty / wallet" htmlFor={id("nft.quantity")} error={err("nft.quantity")}>
                  <input id={id("nft.quantity")} inputMode="numeric" value={s.nft.quantity} onChange={(e) => setNested("nft", { quantity: e.target.value })} />
                </Field>
                <Field label="Style" htmlFor={id("nft.style")} error={err("nft.style")}>
                  <select id={id("nft.style")} value={s.nft.style} onChange={(e) => setNested("nft", { style: e.target.value as NftStyle | "" })}>
                    <option value="">auto-detect</option>
                    {STYLES_BY_FAMILY[fam].map((st) => <option key={st} value={st}>{st}</option>)}
                  </select>
                </Field>
                {fam === "evm" && (
                  <Field label="Token id" htmlFor={id("nft.tokenId")} error={err("nft.tokenId")} hint={s.nft.style === "zora-1155" ? "required for 1155" : "optional"}>
                    <input id={id("nft.tokenId")} inputMode="numeric" value={s.nft.tokenId} onChange={(e) => setNested("nft", { tokenId: e.target.value })} />
                  </Field>
                )}
              </div>
              {s.nft.style === "custom" && (
                <div className="row">
                  <Field label="Function signature" htmlFor={id("nft.customSignature")} error={err("nft.customSignature")}>
                    <input id={id("nft.customSignature")} className="mono" placeholder="mint(uint256)" value={s.nft.customSignature} onChange={(e) => setNested("nft", { customSignature: e.target.value })} />
                  </Field>
                  <Field label="Args (JSON array)" htmlFor={id("nft.customArgs")} error={err("nft.customArgs")}>
                    <input id={id("nft.customArgs")} className="mono" value={s.nft.customArgs} onChange={(e) => setNested("nft", { customArgs: e.target.value })} />
                  </Field>
                </div>
              )}
            </>
          ) : (
            <>
              <Field label={fam === "solana" ? "Token mint" : "Token contract"} htmlFor={id("token.tokenAddress")} error={err("token.tokenAddress")}>
                <input id={id("token.tokenAddress")} className="mono" spellCheck={false} value={s.token.tokenAddress} onChange={(e) => setNested("token", { tokenAddress: e.target.value })} />
              </Field>
              <Field label="Launchpad / curve" htmlFor={id("token.launchpadAddress")} error={err("token.launchpadAddress")}>
                <input id={id("token.launchpadAddress")} className="mono" spellCheck={false} value={s.token.launchpadAddress} onChange={(e) => setNested("token", { launchpadAddress: e.target.value })} />
              </Field>
              <div className="row">
                <Field label={`Spend / wallet (${native.symbol})`} htmlFor={id("token.spend")} error={err("token.spend")}>
                  <input id={id("token.spend")} inputMode="decimal" placeholder="0.1" value={s.token.spend} onChange={(e) => setNested("token", { spend: e.target.value })} />
                </Field>
                <Field label="Slippage (bps)" htmlFor={id("token.slippageBps")} error={err("token.slippageBps")} hint="100 bps = 1%">
                  <input id={id("token.slippageBps")} inputMode="numeric" value={s.token.slippageBps} onChange={(e) => setNested("token", { slippageBps: e.target.value })} />
                </Field>
              </div>
            </>
          )}

          <div className={`field wallet-pick${err("walletIds") ? " has-error" : ""}`}>
            <div className="wallet-pick-head">
              <span className="label" id="wallets-label">
                Wallets <span className={`count${atCap ? " cap" : ""}`} data-testid="wallet-count">{s.walletIds.length}/{MAX_WALLETS_PER_JOB}</span>
                <span className="muted"> · {fam} only</span>
              </span>
              <span className="panel-tools">
                <button type="button" className="btn btn-sm" onClick={() => set("walletIds", eligible.slice(0, MAX_WALLETS_PER_JOB).map((w) => w.id))}>First {MAX_WALLETS_PER_JOB}</button>
                <button type="button" className="btn btn-sm" onClick={() => set("walletIds", [])}>Clear</button>
              </span>
            </div>
            <div className="wallet-list" role="group" aria-labelledby="wallets-label">
              {eligible.length === 0 && <div className="muted">No {fam} wallets available{wallets.length === 0 ? " (unlock the vault)" : ""}.</div>}
              {eligible.map((w) => {
                const checked = s.walletIds.includes(w.id);
                const bal = w.balances[s.chain];
                return (
                  <label key={w.id} className={`wallet-chip${checked ? " on" : ""}${!checked && atCap ? " off" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && atCap}
                      onChange={() => set("walletIds", toggleWallet(s.walletIds, w.id))}
                      aria-label={w.label}
                    />
                    <span>{w.label}</span>
                    <span className="mono muted">{shortId(w.address, 4, 3)}</span>
                    {bal !== undefined && <span className="mono">{fromBaseUnits(bal, native.decimals, 3)}</span>}
                  </label>
                );
              })}
            </div>
            {err("walletIds") ? <div className="field-error" role="alert">{err("walletIds")}</div> : atCap ? <div className="field-hint">Max {MAX_WALLETS_PER_JOB} wallets per job.</div> : null}
          </div>

          <div className="subhead">Fees</div>
          <div className="row row-3">
            <Field label={fam === "solana" ? "Priority (µlamports/CU)" : "Priority fee (gwei)"} htmlFor={id("fees.priorityFee")} error={err("fees.priorityFee")} hint="blank = auto">
              <input id={id("fees.priorityFee")} inputMode="decimal" value={s.fees.priorityFee} onChange={(e) => setNested("fees", { priorityFee: e.target.value })} />
            </Field>
            {fam === "solana" ? (
              <Field label="Jito tip (SOL)" htmlFor={id("fees.jitoTip")} error={err("fees.jitoTip")} hint="bundle via Jito">
                <input id={id("fees.jitoTip")} inputMode="decimal" value={s.fees.jitoTip} onChange={(e) => setNested("fees", { jitoTip: e.target.value })} />
              </Field>
            ) : (
              <Field label="Max fee / gas (gwei)" htmlFor={id("fees.maxFee")} error={err("fees.maxFee")} hint="blank = auto">
                <input id={id("fees.maxFee")} inputMode="decimal" value={s.fees.maxFee} onChange={(e) => setNested("fees", { maxFee: e.target.value })} />
              </Field>
            )}
            <Field label={`Max total fee (${native.symbol})`} htmlFor={id("fees.maxTotalFee")} error={err("fees.maxTotalFee")} hint="per tx cap">
              <input id={id("fees.maxTotalFee")} inputMode="decimal" value={s.fees.maxTotalFee} onChange={(e) => setNested("fees", { maxTotalFee: e.target.value })} />
            </Field>
          </div>
          {s.chain === "ethereum" && (
            <label className="check">
              <input type="checkbox" checked={s.fees.privateSubmission} onChange={(e) => setNested("fees", { privateSubmission: e.target.checked })} />
              Private submission (relay / bundle, skips public mempool)
            </label>
          )}

          <div className="subhead">Trigger</div>
          <div className="seg" role="radiogroup" aria-label="Trigger">
            {TRIGGERS.map((t) => (
              <label key={t.type} className={`seg-item${s.trigger.type === t.type ? " on" : ""}`}>
                <input type="radio" name="trigger" value={t.type} checked={s.trigger.type === t.type} onChange={() => setNested("trigger", { type: t.type as TriggerType })} />
                {t.type === "slot-or-block" && fam === "solana" ? "Slot" : t.label}
              </label>
            ))}
          </div>
          <div className="row">
            {s.trigger.type === "time" && (
              <Field label="Go-live at (local time)" htmlFor={id("trigger.at")} error={err("trigger.at")}>
                <input id={id("trigger.at")} type="datetime-local" step="1" value={s.trigger.at} onChange={(e) => setNested("trigger", { at: e.target.value })} />
              </Field>
            )}
            {s.trigger.type === "state-poll" && (
              <Field label="Poll interval (ms)" htmlFor={id("trigger.intervalMs")} error={err("trigger.intervalMs")}>
                <input id={id("trigger.intervalMs")} inputMode="numeric" value={s.trigger.intervalMs} onChange={(e) => setNested("trigger", { intervalMs: e.target.value })} />
              </Field>
            )}
            {s.trigger.type === "event" && (
              <Field label="Event signature" htmlFor={id("trigger.signature")} hint="blank = adapter's mint-open event">
                <input id={id("trigger.signature")} className="mono" value={s.trigger.signature} onChange={(e) => setNested("trigger", { signature: e.target.value })} />
              </Field>
            )}
            {s.trigger.type === "slot-or-block" && (
              <Field label={fam === "solana" ? "Slot" : "Block number"} htmlFor={id("trigger.block")} error={err("trigger.block")}>
                <input id={id("trigger.block")} inputMode="numeric" value={s.trigger.block} onChange={(e) => setNested("trigger", { block: e.target.value })} />
              </Field>
            )}
            <Field label="Max retries" htmlFor={id("maxRetries")} error={err("maxRetries")}>
              <input id={id("maxRetries")} inputMode="numeric" value={s.maxRetries} onChange={(e) => set("maxRetries", e.target.value)} />
            </Field>
          </div>

          {!review && (
            <div className="actions">
              {showErrors && errorCount > 0 && <span className="field-error">{errorCount} field(s) need attention</span>}
              <button type="submit" className="btn btn-primary">Review mint</button>
            </div>
          )}
        </fieldset>

        {review && (
          <div className="preflight" role="dialog" aria-label="Pre-flight summary">
            <div className="subhead">Pre-flight</div>
            <dl>
              {preflightLines(review, wallets).map(([k, v]) => (
                <div key={k} className="pf-row"><dt>{k}</dt><dd className="mono">{v}</dd></div>
              ))}
            </dl>
            {submitError && <div className="field-error" role="alert">{submitError}</div>}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setReview(null)} disabled={submitting}>Back (Esc)</button>
              <button type="button" ref={confirmRef} className="btn btn-danger" onClick={() => void confirm()} disabled={submitting || disabled}>
                {submitting ? "Submitting…" : `Confirm & launch ${review.walletIds.length} wallet${review.walletIds.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}
      </form>
    </Panel>
  );
}
