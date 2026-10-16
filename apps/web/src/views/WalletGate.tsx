import { useEffect, useState } from "react";
import type { ConnectionPhase } from "../lib/walletConnect";
import { phaseLabel, needsUserAction } from "../lib/walletConnect";

/**
 * The wallet gate, kept short.
 *
 * This used to carry the entire setup procedure — install, unlock, update, faucet,
 * unshielded address, tDUST. That was the wrong container: a modal cannot be
 * bookmarked or read ahead of time, and six steps of instructions in front of a
 * button is a wall people scroll past. The guide is a page now (`#guide`) and this
 * says only the two things the moment requires:
 *
 *   1. Reading needs no wallet. Offered before any setup is asked for.
 *   2. Where the connection currently is, and what to do about it.
 *
 * Everything else is one link away.
 */

const LACE_URL = "https://www.lace.io/";

export type WalletGateProps = {
  open: boolean;
  /** The live connection phase, or null before any attempt. */
  phase: ConnectionPhase | null;
  /** True when an extension was detected in this browser. */
  installed: boolean;
  /** True when a request is in flight. */
  busy: boolean;
  onConnect: () => void;
  onBrowse: () => void;
  onOpenGuide: () => void;
};

export function WalletGate({
  open,
  phase,
  installed,
  busy,
  onConnect,
  onBrowse,
  onOpenGuide,
}: WalletGateProps) {
  const [elapsed, setElapsed] = useState(0);

  // Tick only while a request is pending, so the guidance can escalate with time.
  useEffect(() => {
    if (!open || !busy) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [open, busy]);

  if (!open) return null;

  const stuck = elapsed >= 6 || phase?.kind === "needs-attention";
  const failed = phase?.kind === "error" || phase?.kind === "rejected";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Connect a wallet"
    >
      <div className="card card-pad" style={{ maxWidth: 480, width: "100%" }}>
        <h2 style={{ margin: "0 0 10px", fontSize: 21 }}>
          {stuck
            ? "Your wallet needs attention"
            : failed
              ? "Connection did not complete"
              : "Connect a wallet to contribute"}
        </h2>

        {/* The one thing a visitor needs before anything else. */}
        <div
          className="notice"
          style={{ borderColor: "#14301e", background: "var(--green-bg)", lineHeight: 1.6 }}
        >
          <b style={{ color: "var(--green)" }}>You do not need a wallet to read.</b> The report and
          the verification page are open to anyone. A wallet is only for contributing a figure,
          because that is a transaction.
        </div>

        <StatusBlock phase={phase} busy={busy} stuck={stuck} elapsed={elapsed} installed={installed} />

        <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={onConnect} disabled={busy}>
            {busy ? phaseLabel(phase ?? { kind: "requesting", detail: "", waitedMs: 0 }) : "Connect wallet"}
          </button>
          <button className="btn" onClick={onBrowse}>
            Read without a wallet
          </button>
        </div>

        <div className="small muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
          First time, or something not working?{" "}
          <button
            className="btn btn-ghost small"
            style={{ padding: "2px 8px" }}
            onClick={onOpenGuide}
          >
            Open the setup guide
          </button>{" "}
          — six steps, including the one everyone skips.
        </div>

        {!installed && (
          <div className="small muted" style={{ marginTop: 10 }}>
            No wallet extension found in this browser.{" "}
            <a href={LACE_URL} target="_blank" rel="noreferrer" className="link">
              Get Lace
            </a>
            .
          </div>
        )}
      </div>
    </div>
  );
}

/** One changing sentence about where the connection is. */
function StatusBlock({
  phase,
  busy,
  stuck,
  elapsed,
  installed,
}: {
  phase: ConnectionPhase | null;
  busy: boolean;
  stuck: boolean;
  elapsed: number;
  installed: boolean;
}) {
  if (!busy && !phase) {
    return (
      <div className="small muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
        {installed
          ? "A wallet extension is available in this browser."
          : "No wallet extension was found in this browser yet."}
      </div>
    );
  }

  const tone =
    phase?.kind === "connected"
      ? { border: "#14301e", bg: "var(--green-bg)", color: "var(--green)" }
      : stuck || phase?.kind === "error" || phase?.kind === "rejected"
        ? { border: "#713f12", bg: "#1a1500", color: "#fcd34d" }
        : { border: "var(--line)", bg: "var(--panel2)", color: "var(--fg)" };

  return (
    <div
      className="notice"
      style={{
        marginTop: 12,
        borderColor: tone.border,
        background: tone.bg,
        color: tone.color,
        lineHeight: 1.6,
        fontSize: 13,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <b>{phaseLabel(phase ?? { kind: "requesting", detail: "", waitedMs: 0 })}</b>
        {busy && elapsed > 0 && <span className="mono small">{elapsed}s</span>}
      </div>
      {phase && <div style={{ marginTop: 4 }}>{phase.detail}</div>}
      {phase?.kind === "error" && phase.hint && <div style={{ marginTop: 4 }}>{phase.hint}</div>}
      {busy && stuck && phase?.kind !== "needs-attention" && (
        <div style={{ marginTop: 6 }}>
          Taking longer than usual. Open the Lace extension and unlock it — the request is waiting
          for you there.
        </div>
      )}
      {phase && needsUserAction(phase) && (
        <div style={{ marginTop: 6 }}>
          Nothing was sent to the network. Trying again is safe.
        </div>
      )}
    </div>
  );
}

/**
 * The always-visible hint under the header Connect button.
 *
 * Gives the next action without opening the dialog, for someone already half-way
 * through setup.
 */
export function walletHint(phase: ConnectionPhase | null, installed: boolean): string | null {
  if (!installed) return "Install Lace to contribute — reading needs no wallet.";
  if (!phase) return null;
  if (phase.kind === "needs-attention") return "Unlock Lace, then approve the connection.";
  if (phase.kind === "rejected") return "Connection declined in the wallet.";
  return null;
}
