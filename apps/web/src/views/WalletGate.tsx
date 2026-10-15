import { useEffect, useState } from "react";
import type { ConnectionPhase } from "../lib/walletConnect";
import { phaseLabel, needsUserAction } from "../lib/walletConnect";

/**
 * The wallet gate, written for someone who has never seen a Midnight wallet.
 *
 * The previous version was a bare "Install Lace" link plus a Connect button that
 * could sit for a minute with no visible change, because a LOCKED extension
 * cannot show its approval popup and the connection promise never settles. A
 * first-time visitor read that as a broken site.
 *
 * Three things a person needs, in order:
 *
 *   1. What is happening right now. Not a spinner — a sentence that changes as
 *      the situation does, because "asking your wallet" and "your wallet is not
 *      answering and is probably locked" call for different actions.
 *   2. What to click. The step that needs them is highlighted, with the one
 *      instruction that unblocks it.
 *   3. Why bother. Connecting is how a contribution is proven; reading needs no
 *      wallet at all, and saying that up front stops people bouncing.
 *
 * The panel is deliberately ordered so the first useful thing (read without a
 * wallet) is available before any setup is asked for.
 */

const LACE_URL = "https://www.lace.io/";
/** Free test funds. On Preprod the faucet dispenses tNIGHT, which generates tDUST. */
const FAUCET_URL = "https://midnight-tmnight-preprod.nethermind.dev/";

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
};

export function WalletGate({ open, phase, installed, busy, onConnect, onBrowse }: WalletGateProps) {
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

  const waiting = phase?.kind === "requesting" || phase?.kind === "needs-attention";
  const stuck = elapsed >= 6 || phase?.kind === "needs-attention";

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
      <div
        className="card card-pad"
        style={{ maxWidth: 560, width: "100%", maxHeight: "90vh", overflowY: "auto" }}
      >
        <div className="kicker">STEP 1 OF 2</div>
        <h2 style={{ margin: "4px 0 8px", fontSize: 22 }}>
          {phase?.kind === "needs-attention"
            ? "Your wallet needs attention"
            : phase?.kind === "error" || phase?.kind === "rejected"
              ? "Connection did not complete"
              : "Connect a wallet to contribute"}
        </h2>

        {/* Lead with what needs no setup at all. */}
        <div
          className="notice"
          style={{ borderColor: "#14301e", background: "var(--green-bg)", lineHeight: 1.55 }}
        >
          <b style={{ color: "var(--green)" }}>You do not need a wallet to read.</b> The report and
          the verification page are open to anyone — no account, no permission. A wallet is only
          for contributing a figure, because that is what makes the proof attributable to a human.
        </div>

        {/* A live status line, not a spinner. */}
        <StatusBlock phase={phase} busy={busy} stuck={stuck} elapsed={elapsed} installed={installed} />

        {/* The steps, numbered, with the blocking one called out. */}
        <ol style={{ margin: "14px 0 0", paddingLeft: 20, lineHeight: 1.7, fontSize: 14 }}>
          <li style={{ color: installed ? "var(--muted)" : "var(--fg)" }}>
            <b>Install the Lace extension.</b>{" "}
            {installed ? (
              <span className="muted">Already detected in this browser.</span>
            ) : (
              <>
                <a href={LACE_URL} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                  lace.io
                </a>{" "}
                — then reload this page.
              </>
            )}
          </li>
          <li style={{ color: installed ? "var(--fg)" : "var(--muted)" }}>
            <b>Unlock Lace and switch it to {`the Preprod network`}.</b> A locked wallet cannot show
            its approval prompt, which looks exactly like the button doing nothing.
          </li>
          <li style={{ color: installed ? "var(--fg)" : "var(--muted)" }}>
            <b>Press Connect, then approve the request in the extension.</b> You will need a little
            tDUST to contribute — it comes free from the{" "}
            <a href={FAUCET_URL} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              Preprod faucet
            </a>
            . Request tNIGHT, then press <b>Generate tDUST</b> in Lace and wait a minute.
          </li>
        </ol>

        <div className="row" style={{ gap: 8, marginTop: 18, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={onConnect} disabled={busy}>
            {busy ? phaseLabel(phase ?? { kind: "requesting", detail: "", waitedMs: 0 }) : "Connect Lace"}
          </button>
          <button className="btn" onClick={onBrowse}>
            Read without a wallet
          </button>
          {!installed && (
            <a className="btn btn-ghost" href={LACE_URL} target="_blank" rel="noreferrer">
              Get Lace
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** The changing sentence that tells the user where they are. */
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
  // Nothing has been attempted yet: give the calm starting state.
  if (!busy && !phase) {
    return (
      <div className="small muted" style={{ marginTop: 12, lineHeight: 1.55 }}>
        {installed
          ? "A wallet extension is available in this browser. Press Connect to continue."
          : "No wallet extension was found in this browser yet."}
      </div>
    );
  }

  const tone =
    phase?.kind === "connected"
      ? { border: "#14301e", bg: "var(--green-bg)", color: "var(--green)" }
      : phase?.kind === "needs-attention" || stuck || phase?.kind === "error" || phase?.kind === "rejected"
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
        lineHeight: 1.55,
        fontSize: 13,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <b>{phaseLabel(phase ?? { kind: "requesting", detail: "", waitedMs: 0 })}</b>
        {busy && elapsed > 0 && <span className="mono small">{elapsed}s</span>}
      </div>
      {phase && <div style={{ marginTop: 4 }}>{phase.detail}</div>}
      {phase && phase.kind === "error" && phase.hint && (
        <div style={{ marginTop: 4 }}>{phase.hint}</div>
      )}
      {busy && stuck && phase?.kind !== "needs-attention" && (
        <div style={{ marginTop: 6 }}>
          This is taking longer than usual. Open the Lace extension and unlock it — the request is
          waiting for you there.
        </div>
      )}
      {phase && needsUserAction(phase) && (
        <div style={{ marginTop: 6 }}>
          Nothing was sent to the network. You can try again safely.
        </div>
      )}
    </div>
  );
}

/**
 * The small always-visible hint under the header Connect button.
 *
 * Gives the next action without opening the dialog, for someone who is already
 * half-way through setup.
 */
export function walletHint(phase: ConnectionPhase | null, installed: boolean): string | null {
  if (!installed) return "Install Lace to contribute — reading needs no wallet.";
  if (!phase) return null;
  if (phase.kind === "needs-attention") return "Unlock Lace, then approve the connection.";
  if (phase.kind === "rejected") return "Connection declined in the wallet.";
  return null;
}
