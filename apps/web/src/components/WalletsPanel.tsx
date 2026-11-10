import { useState } from "react";
import type { ChainId, WalletView } from "@mint-engine/core";
import { CHAINS, CHAIN_LABEL } from "../lib/form";
import { NATIVE, fromBaseUnits } from "../lib/units";
import { Badge, Mono, Panel } from "./common";

export type VaultState = "unknown" | "locked" | "unlocked";

interface Props {
  vault: VaultState;
  wallets: WalletView[];
  busy: boolean;
  error: string | null;
  onUnlock: (passphrase: string) => void;
  onLock: () => void;
  onRefresh: () => void;
}

const SHORT: Record<ChainId, string> = { solana: "SOL", ethereum: "ETH L1", base: "BASE", robinhood: "RH" };

export function WalletsPanel({ vault, wallets, busy, error, onUnlock, onLock, onRefresh }: Props) {
  const [pass, setPass] = useState("");
  const right = (
    <>
      <Badge kind={vault === "unlocked" ? "ok" : vault === "locked" ? "warn" : "muted"}>vault {vault}</Badge>
      {vault === "unlocked" && (
        <>
          <button type="button" className="btn btn-sm" onClick={onRefresh} disabled={busy}>Refresh</button>
          <button type="button" className="btn btn-sm" onClick={onLock} disabled={busy} title="Alt+L">Lock</button>
        </>
      )}
    </>
  );
  return (
    <Panel title="Vault & wallets" right={right} id="wallets">
      {vault !== "unlocked" ? (
        <form
          className="unlock-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (pass) {
              onUnlock(pass);
              setPass("");
            }
          }}
        >
          <label htmlFor="vault-pass">Vault passphrase</label>
          <input id="vault-pass" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!pass || busy}>Unlock</button>
          {error && <span className="field-error" role="alert">{error}</span>}
        </form>
      ) : (
        <>
          {error && <div className="field-error" role="alert">{error}</div>}
          <div className="table-wrap">
            <table className="grid-table" aria-label="Wallets">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Family</th>
                  <th>Address</th>
                  {CHAINS.map((c) => <th key={c} className="num" title={CHAIN_LABEL[c]}>{SHORT[c]}</th>)}
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => (
                  <tr key={w.id}>
                    <td>{w.label}</td>
                    <td><Badge kind={w.family}>{w.family}</Badge></td>
                    <td><Mono value={w.address} head={6} tail={4} /></td>
                    {CHAINS.map((c) => {
                      const b = w.balances[c];
                      return <td key={c} className="num mono">{b === undefined ? <span className="muted">—</span> : `${fromBaseUnits(b, NATIVE[c].decimals, 4)}`}</td>;
                    })}
                  </tr>
                ))}
                {wallets.length === 0 && <tr><td colSpan={3 + CHAINS.length} className="muted">No wallets in vault.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
