import { useState, type ReactNode } from "react";
import { shortId } from "../lib/units";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-icon"
      title={`${label}: ${value}`}
      aria-label={`${label} ${value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 900);
        } catch {
          /* clipboard blocked; the full value is in the title tooltip */
        }
      }}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

export function Mono({ value, head, tail }: { value: string; head?: number; tail?: number }) {
  return (
    <span className="mono-id">
      <span className="mono" title={value}>{shortId(value, head, tail)}</span>
      <CopyButton value={value} />
    </span>
  );
}

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function Panel({ title, right, children, id, className }: { title: ReactNode; right?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section className={`panel ${className ?? ""}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
      <header className="panel-head">
        <h2>{title}</h2>
        {right && <div className="panel-tools">{right}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div className="field-error" role="alert">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}
