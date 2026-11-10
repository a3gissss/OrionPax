import { useState } from "react";

export function TokenGate({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string | null }) {
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <form
        className="gate-card panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="brand gate-brand">MINT<span>·</span>ENGINE</div>
        <p className="muted">
          Paste the session token printed by the local server (127.0.0.1:4810). It is kept in this tab's
          sessionStorage only and sent as the <code>x-session-token</code> header.
        </p>
        <label htmlFor="session-token">Session token</label>
        <input
          id="session-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <div className="field-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={!value.trim()}>Connect</button>
      </form>
    </div>
  );
}
