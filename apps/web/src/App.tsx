import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  BUCKETS,
  K_ANONYMITY,
  LEVELS,
  REGIONS,
  allCuts,
  bucketForSalary,
  cutLabel,
  cutKeyString,
  hexToBytes,
} from "@gotit/shared";
import {
  loadLedger,
  saveLedger,
  resetLedger,
  histogramForCut,
  isUnlocked,
  percentileForBucket,
  getOrCreateSecret,
  getSecretHex,
  enrollLocal,
  submitLocal,
  loadMyContribs,
} from "./lib/ledger";
import { requestCode, confirmCode, enrollLeaf } from "./lib/issuer";
import type { GotItProviders } from "./lib/midnight";
import { describeFailure, failureReport, safeStringify, friendlyChainError } from "./lib/effectError";
import type { IndexerReport } from "./lib/indexerStatus";
import { NETWORK_ID, networkCredentialsNote, INDEXER_PATH, INDEXER_HTTP, INDEXER_WS } from "./lib/indexerConfig";
import { WalletGate, walletHint } from "./views/WalletGate";
const GuidePage = lazy(() => import("./views/GuidePage"));
import {
  loadCategories,
  mergeCategories,
  usedCategories,
  rememberUsedCategory,
  type StoredCategory,
} from "./lib/categoryStore";
import { phaseLabel } from "./lib/walletConnect";
import type { ConnectionPhase } from "./lib/walletConnect";
import { preflightV2Deploy, describePreflight } from "./lib/preflight";
import { isLaceAvailable, getStoredContractAddress, setStoredContractAddress, getEffectiveIssuerKey, getBakedIssuerKey, getStoredIssuerKey, getStoredV2ContractAddress, setStoredV2ContractAddress } from "./lib/session";
import type { LedgerSnapshot } from "./lib/ledger";

// live on-chain reads (lazy — wasm loads on demand)
const chainReadLib = () => import("./lib/chainRead");

/**
 * Warm the lazy modules the wallet path needs, BEFORE the click.
 *
 * `connect()` is called by a click handler, and browsers grant a short
 * "user activation" window that lets a site open popups and prompt the user. Each
 * `await` between the click and the wallet call is a chance to lose it, and a
 * wallet whose approval dialog is a popup will then show nothing at all — which
 * is exactly the symptom: a connected, unlocked wallet that never answers.
 *
 * The connect path used to await two dynamic imports (`./lib/midnight` and
 * `./lib/walletConnect`) before calling connect(). Those now resolve from cache
 * because they are warmed at mount, so connect() is the first await in the
 * handler rather than the third.
 */
const walletLib = () => import("./lib/walletConnect");
let walletPathWarmed = false;
export function warmWalletPath(): void {
  if (walletPathWarmed) return;
  walletPathWarmed = true;
  void Promise.all([midnightLib(), walletLib()]).catch(() => {
    walletPathWarmed = false;
  });
}
import { bytesToHex } from "@gotit/shared";

// wasm-heavy modules load on demand — the landing page renders without them
const midnightLib = () => import("./lib/midnight");
const hashLib = () => import("@gotit/shared/hash");

// Wave 2 compliance surfaces. reportRead also pulls in wasm (the generated
// ledger decoder), so it stays lazy for the same reason.
const ReportPage = lazy(() => import("./views/ReportPage"));
const VerifyPage = lazy(() => import("./views/VerifyPage"));

type View = "browse" | "cut" | "contribute" | "result" | "report" | "verify" | "guide";

/** Only the public, shareable views are deep-linkable — the rest need wallet state. */
const HASHABLE: View[] = ["report", "verify", "guide", "browse"];

/**
 * Parse `#report` and `#report&sample` / `#report?sample`.
 *
 * The first segment is the view; the rest are flags. Treating the whole hash as
 * the view name means any flag silently drops the user back to the landing page
 * — a bug that only shows up when you actually click the URL, which is exactly
 * how this one was found.
 */
function parseHash(): { view: View; flags: string[] } {
  try {
    const raw = location.hash.replace(/^#/, "");
    const parts = raw.split(/[&?]/).filter(Boolean);
    const head = parts[0] ?? "";
    const view = (HASHABLE as string[]).includes(head) ? (head as View) : "browse";
    return { view, flags: parts.slice(1) };
  } catch {
    return { view: "browse", flags: [] };
  }
}

function viewFromHash(): View {
  return parseHash().view;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "var(--bg)", color: "var(--text)", fontFamily: "Inter, sans-serif" }}>
          <div style={{ maxWidth: 560, border: "1px solid var(--line)", borderRadius: 14, padding: 24, background: "var(--panel)" }}>
            <h2 style={{ marginTop: 0 }}>GotIt hit an unexpected error</h2>
            <p style={{ color: "var(--muted)", lineHeight: 1.5 }}>
              Reload the page to continue. If this keeps happening, your browser may have
              blocked WebAssembly — which GotIt needs for zero-knowledge proofs. Try
              disabling enhanced security / tracking prevention for this site, or open it in Chrome.
            </p>
            <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <GotItApp />
    </ErrorBoundary>
  );
}

function GotItApp() {
  const [ledger, setLedger] = useState(() => loadLedger());
  // The cut grid is the secondary Wave 1 surface; collapsed by default so the
  // compliance pitch is what a judge sees first.
  const [showCuts, setShowCuts] = useState(false);
  // Views are hash-routed so the report and verification pages are deep-linkable.
  // A judge, a works council member or a journalist should be able to paste a URL
  // and have the right page open — that is the point of a report you send to
  // someone. Wallet-dependent views stay internal, since they need state.
  const [view, setViewRaw] = useState<View>(() => viewFromHash());
  const setView = useCallback((v: View) => {
    setViewRaw(v);
    try {
      history.replaceState(null, "", HASHABLE.includes(v) && v !== "browse" ? `#${v}` : location.pathname);
    } catch {}
  }, []);
  useEffect(() => {
    const onHash = () => setViewRaw(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [activeCutKey, setActiveCutKey] = useState<string>(() => allCuts()[0] ? cutKeyString(allCuts()[0]) : "");
  const [toast, setToast] = useState<string | null>(null);
  const [chain, setChain] = useState<{ providers: GotItProviders } | null>(null);
  const [live, setLive] = useState<{ epoch: string; members: number; submissions: number; snapshot: LedgerSnapshot } | null>(null);
  const contractAddress = getStoredContractAddress();

  /**
   * The indexer's state, probed once and refreshed with the live read.
   *
   * The app has always refused to present sample data as chain data. This is the
   * other half: saying WHICH failure caused the fallback, because "nobody has
   * run a reporting period yet" and "the network decommissioned its indexer" are
   * different facts that previously produced the same screen.
   */
  const [indexer, setIndexer] = useState<IndexerReport | null>(null);

  const refreshLive = async () => {
    if (!contractAddress) return;
    try {
      const { readGotItState } = await chainReadLib();
      setLive(await readGotItState(contractAddress));
      setIndexer(null);
    } catch (e: any) {
      console.warn("[gotit] live read unavailable:", describeFailure(e));
      setLive(null);
      // Classify the failure so the banner can name it. Imported dynamically so
      // a chain-read problem never blocks first paint.
      try {
        const { probeIndexer } = await chainReadLib();
        setIndexer(await probeIndexer());
      } catch {
        setIndexer(null);
      }
    }
  };
  useEffect(() => {
    refreshLive();
    const t = setInterval(refreshLive, 90_000);
    return () => clearInterval(t);
  }, []);
  // Fetch the wallet modules while the page is idle, so the first click does not
  // spend its user activation on module loading.
  useEffect(() => {
    const idle = (window as any).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 800));
    idle(() => warmWalletPath());
  }, []);
  useEffect(() => {
    (window as any).__gotitRefreshLive = refreshLive;
  }, []);
  useEffect(() => {
    (window as any).__gotitChain = chain;
  }, [chain]);
  const [operatorOpen, setOperatorOpen] = useState(false);
  const [laceReady, setLaceReady] = useState(() => isLaceAvailable());
  /** Live connection phase, so the gate can narrate instead of spinning. */
  const [connectPhase, setConnectPhase] = useState<ConnectionPhase | null>(null);
  const [connecting, setConnecting] = useState(false);
  useEffect(() => {
    // extensions inject after page load — re-check on focus and briefly after mount
    const recheck = () => setLaceReady(isLaceAvailable());
    const t1 = setTimeout(recheck, 1500);
    const t2 = setTimeout(recheck, 5000);
    window.addEventListener("focus", recheck);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("focus", recheck); };
  }, []);

  // keep ledger in sync with storage events (demo)
  useEffect(() => {
    const onStorage = () => setLedger(loadLedger());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const displayLedger = live?.snapshot ?? ledger;
  const [demoFallback, setDemoFallback] = useState(false);
  const cuts = useMemo(() => allCuts(), []);
  const activeCut = useMemo(() => cuts.find((c) => cutKeyString(c) === activeCutKey) ?? cuts[0], [cuts, activeCutKey]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const connectChain = async () => {
    setConnectPhase({ kind: "detecting", detail: "Looking for a Midnight wallet…" });
    setConnecting(true);
    try {
      const { connectGotIt } = await midnightLib();
      // Narrated connect: a locked extension never settles its promise, so the
      // old `await connect()` hung forever with no message. This races it against
      // a clock and reports each phase, so the dialog can tell the user to go
      // unlock their wallet instead of appearing broken.
      const { connectWithProgress } = await walletLib();
      const connected = await connectWithProgress({
        networkId: NETWORK_ID,
        onPhase: setConnectPhase,
      });
      const providers = await connectGotIt(NETWORK_ID, connected as any);
      setChain({ providers });
      setShowGate(false);
      showToast(`Wallet connected — ${NETWORK_ID}`);
    } catch (e: any) {
      // A locked wallet gets its own phase: the connection technically succeeded
      // and then the wallet refused to answer, so "connection failed" would send
      // the user looking in the wrong place.
      const locked = /lock/i.test(String(e?.name ?? "")) || /lock/i.test(String(e?.message ?? ""));
      const phase = e?.phase ?? {
        kind: (locked ? "needs-attention" : "error") as ConnectionPhase["kind"],
        detail: String(e?.message ?? e),
        hint: locked
          ? "Nothing was sent to the network. Unlock Lace, then press Connect again."
          : undefined,
      };
      setConnectPhase(phase);
      // Stay open: the dialog renders the phase and the next step, which is more
      // use than a toast that disappears.
    } finally {
      setConnecting(false);
    }
  };

  const [showGate, setShowGate] = useState(false);
  const requireWallet = (next: () => void) => {
    if (chain) { next(); return; }
    if (laceReady) { setShowGate(true); return; }
    setShowGate(true);
  };

  return (
    <div>
      <header className="topbar">
        <div className="container topbar-inner">
          {/*
            The brand is a home link. Arriving at #report from a shared URL left
            no way back — the header's only controls were Report/Verify/Contribute,
            none of which return to the landing page.
          */}
          <button
            className="brand"
            onClick={() => {
              setView("browse");
              try { history.replaceState(null, "", location.pathname); } catch {}
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            title="Back to the start"
          >
            <div className="brand-mark">◐</div>
            <div>
              <div style={{ lineHeight: 1, fontSize: 16 }}>GotIt</div>
              <div className="small mono brand-tagline" style={{ color: "var(--muted)", marginTop: 2 }}>provable · unlinkable · suppressible</div>
            </div>
          </button>
          <div className="row">
            <span className="badge">
              <span className="mono small">epoch</span> <strong>{displayLedger.epoch}</strong> · <span className="mono small">k≥{K_ANONYMITY}</span>
            </span>
            {view === "browse" && !live && (
              <button
                className="btn btn-ghost small"
                onClick={() => { resetLedger(); setLedger(loadLedger()); showToast("Sample data reset"); }}
                title="Clears the local illustrative dataset. Only affects this browser."
              >
                Reset sample data
              </button>
            )}
            {/*
              The wallet state is ONE badge, styled like every other badge in the
              header, and the instruction lives in the button's tooltip and in the
              dialog. Before this the hint was loose amber text next to an amber
              button — two things in the same colour saying the same thing, which
              read as a rendering bug.
            */}
            {!chain && walletHint(connectPhase, laceReady) && (
              <span
                className="badge"
                title={walletHint(connectPhase, laceReady) ?? undefined}
                style={
                  connectPhase?.kind === "needs-attention" || connectPhase?.kind === "rejected"
                    ? { borderColor: "#713f12", background: "#1a1500" }
                    : undefined
                }
              >
                <span
                  className="mono small"
                  style={connectPhase?.kind === "needs-attention" ? { color: "#fcd34d" } : undefined}
                >
                  wallet
                </span>{" "}
                <strong>
                  {connectPhase?.kind === "needs-attention"
                    ? "needs attention"
                    : connectPhase?.kind === "rejected"
                      ? "declined"
                      : "not connected"}
                </strong>
              </span>
            )}
            {chain ? (
              <span className="badge" title={contractAddress ?? "no contract yet"}>
                <span className="mono small">chain</span> <strong>Preprod ✓</strong>
              </span>
            ) : laceReady ? (
              <button
                className="btn small"
                onClick={() => (connecting ? setShowGate(true) : setShowGate(true))}
                title={walletHint(connectPhase, laceReady) ?? "Connect a Midnight wallet to contribute"}
              >
                {connecting ? phaseLabel(connectPhase ?? { kind: "requesting", detail: "", waitedMs: 0 }) : "Connect wallet"}
              </button>
            ) : (
              <a className="btn small" href="https://www.lace.io/" target="_blank" rel="noreferrer"
                 title="Install the Lace extension (with Midnight support), then reload this page">
                Get Lace
              </a>
            )}
            {chain && (
              <button className="btn btn-ghost small" onClick={() => setOperatorOpen(true)} title="Deploy / enroll / epoch">Operator</button>
            )}
            {view !== "browse" && (
              <button className="btn btn-ghost small" onClick={() => {
                setView("browse");
                try { history.replaceState(null, "", location.pathname); } catch {}
              }} title="Back to the start">
                ← Home
              </button>
            )}
            <button className="btn btn-ghost small" onClick={() => setView("report")} title="Art. 9 pay gap report, built from live chain state">
              Report
            </button>
            <button className="btn btn-ghost small" onClick={() => setView("guide")} title="How to set up a wallet and contribute">
              Setup
            </button>
            <button className="btn btn-ghost small" onClick={() => setView("verify")} title="Check a published report against chain state">
              Verify
            </button>
            <button className="btn btn-primary small" onClick={() => requireWallet(() => setView("contribute"))}>Contribute</button>
          </div>
        </div>
      </header>

      {demoFallback && (
        <div className="container">
          <div className="notice" style={{ marginTop: 14, borderColor: "#854d0e", background: "#1a1500" }}>
            <strong>Demo mode:</strong> hosted prover temporarily unavailable — your last contribution was recorded locally and is <em>not</em> on-chain.{" "}
            <span className="small">Refresh or run locally (<span className="mono">pnpm dev:all</span>) for the full on-device privacy guarantee.</span>
          </div>
        </div>
      )}

      {/*
        A chain outage must not look like an empty chain. Shown on every view,
        because the report and verification pages depend on live reads too.
      */}
      {indexer && !indexer.live && (
        <div className="container" style={{ paddingTop: 14 }}>
          <div
            className="notice"
            style={{ borderColor: "#713f12", background: "#1a1500", lineHeight: 1.55 }}
          >
            <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 420px" }}>
                <strong style={{ color: "#fcd34d" }}>
                  Live chain reads are unavailable &mdash; showing sample data
                </strong>
                <div className="small" style={{ marginTop: 4 }}>
                  {indexer.headline}
                </div>
                {indexer.action && (
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {indexer.action}
                  </div>
                )}
                <div className="small muted" style={{ marginTop: 4 }}>
                  network <code>{NETWORK_ID}</code> · indexer path{" "}
                  <code>{INDEXER_PATH}</code> · {networkCredentialsNote()}
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {indexer.status.kind === "decommissioned" && indexer.status.migrationUrl && (
                  <a className="btn small" href={indexer.status.migrationUrl} target="_blank" rel="noreferrer">
                    Migration guide
                  </a>
                )}
                <button
                  className="btn btn-ghost small"
                  onClick={() => {
                    navigator.clipboard?.writeText(
                      `indexer: ${indexer.url}\nstatus: ${indexer.status.kind}\n${indexer.headline}` +
                        (indexer.action ? `\n\n${indexer.action}` : ""),
                    );
                    showToast("Indexer status copied");
                  }}
                >
                  Copy status
                </button>
              </div>
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              The numbers below are a local illustrative dataset, not chain state. This is stated
              rather than hidden: a compliance report that silently substitutes figures is worse
              than one that says it cannot read the chain.
            </div>
          </div>
        </div>
      )}

      {view === "browse" && !laceReady && !chain && (
        <div className="container">
          <div className="notice" style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>
              <strong>Welcome.</strong> Browse every unlocked distribution right now — no wallet needed.
              To contribute on-chain, install the Lace wallet and connect.
            </span>
            <a className="btn small" href="https://www.lace.io/" target="_blank" rel="noreferrer">Get Lace</a>
          </div>
        </div>
      )}

      {view === "browse" && (
      <>
      <div className="container hero">
        <div className="hero-grid">
          <div className="card card-pad">
            <div className="kicker">For EU employers · Directive (EU) 2023/970</div>
            <h1 className="hero-title">
              Publish a pay gap report. <span style={{ color: "var(--accent)" }}>Never expose one employee.</span>
            </h1>
            <p className="hero-copy">
              From 7 June 2027, every EU company with 150+ employees must publish gender pay gap
              statistics — and the burden of proof is theirs. GotIt produces a report anyone can
              verify against the chain, without exposing a single individual.
            </p>
            <div className="trust">
              <span className="pill"><b>Provable</b> · verifiable against chain state</span>
              <span className="pill"><b>Unlinkable</b> · the salary is a private witness</span>
              <span className="pill"><b>Suppressible</b> · k-anonymity enforced in-circuit</span>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => setView("report")}>See the report</button>
              <button className="btn" onClick={() => setView("verify")}>Verify a report</button>
            </div>
            <div className="notice" style={{ marginTop: 14 }}>
              <strong>How it works.</strong> Each employee commits their job category, gender and
              base/variable pay from their own device. Only counts ever reach the ledger, and the read
              circuit returns nothing for any group below the anonymity threshold — so a small category
              cannot be published even by an employer override. Participation is voluntary: nobody,
              including the employer, can compel a disclosure.
            </div>
          </div>

          <div className="card card-pad">
            <div className="kicker" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              Network state
              {live ? (
                <span className="badge small" style={{ color: "var(--green)", borderColor: "#14301e", background: "var(--green-bg)" }}>● live on-chain</span>
              ) : (
                <span className="badge small">sample data</span>
              )}
            </div>
            <h3 style={{ margin: "6px 0 8px" }}>Read the report without a wallet</h3>
            <p className="small muted" style={{ lineHeight: 1.5 }}>
              The report and the verification page need no wallet, no account and no permission. A
              works council member or a regulator can confirm a filing is real without a court order
              forcing individual salaries into the open.
            </p>
            <div className="sep" />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary small" onClick={() => setView("report")}>Open the report</button>
              <button className="btn small" onClick={() => setView("verify")}>Verify a report</button>
            </div>
            <div className="sep" />
            <div className="small muted" style={{ lineHeight: 1.5, marginBottom: 2 }}>
              {live ? "Live ledger state" : "Sample dataset — not chain data"}
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="small muted">Verified submissions</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>
                  {live ? live.submissions : Object.values(displayLedger.histogram).reduce((a, b) => a + b, 0)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="small muted">Reporting period</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{live ? live.epoch : displayLedger.epoch}</div>
              </div>
            </div>
            <div className="notice" style={{ marginTop: 12 }}>
              {live ? (
                <>
                  <strong>Live on Midnight Preprod.</strong> A proof is generated on the employee's
                  own device, so the salary never reaches us or the ledger. Anyone can read the
                  aggregate without a wallet.
                </>
              ) : (
                <>
                  <strong>These figures are sample data.</strong> The figures above are a local
                  illustrative dataset, not chain state — the contract is live on Midnight
                  Preprod, but nobody has run a reporting period on it yet. A proof is generated on
                  the employee's own device, so a real salary never reaches us or the ledger.
                </>
              )}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn small" onClick={() => { navigator.clipboard.writeText(getSecretHex() ?? ""); showToast("Secret key copied — stored only on this device"); }}>Copy my secret key</button>
              <span className="small muted">Generated on this device · never uploaded</span>
            </div>
          </div>
        </div>
      </div>

      <div className="container" id="cuts" style={{ padding: "10px 0 18px" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 22 }}>Employee contribution tool</h2>
            <div className="small muted" style={{ marginTop: 4, maxWidth: 620, lineHeight: 1.5 }}>
              The Wave 1 surface: an open salary benchmark by role, level and region. Compliance
              reporting is the Art. 9 report above — this is the same privacy machinery pointed at a
              different question.
            </div>
          </div>
          <button className="btn small" onClick={() => setShowCuts((v) => !v)}>
            {showCuts ? "Hide" : `Show ${cuts.length} cuts`}
          </button>
        </div>

        {showCuts && (
        <div className="grid">
          {cuts.map((cut) => {
            const key = cutKeyString(cut);
            const hist = histogramForCut(displayLedger, cut);
            const total = hist.reduce((a, b) => a + b, 0);
            const unlocked = total >= K_ANONYMITY;
            const max = Math.max(1, ...hist);
            return (
              <div key={key} className="card cut-card" style={{ cursor: "pointer" }} onClick={() => { setActiveCutKey(key); setView("cut"); }}>
                <div className="cut-head">
                  <div>
                    <div className="cut-title" style={{ fontSize: 14 }}>{cutLabel(cut)}</div>
                    <div className="small mono muted">{key}</div>
                  </div>
                  <span className="badge small" style={{ color: unlocked ? "var(--green)" : "var(--muted)" }}>
                    {unlocked ? "✓" : "🔒"} {total}/{K_ANONYMITY}
                  </span>
                </div>

                <div className="hist">
                  {hist.map((n, i) => (
                    <div key={i} className="hist-col" title={`${n} in bucket ${i}`}>
                      <div className="hist-bar" style={{ height: `${Math.round((n / max) * 100)}%`, opacity: n > 0 ? 1 : 0.15 }} />
                    </div>
                  ))}
                </div>

                {unlocked ? (
                  <div className="small muted">Open — click to view the distribution.</div>
                ) : (
                  <div className="small muted">
                    <b>Locked</b> · needs {K_ANONYMITY - total} more verified contributors
                  </div>
                )}

                <div className="row small muted" style={{ marginTop: "auto" }}>
                  <span className="mono">{total} submissions</span>
                  <span>·</span>
                  <span>bucketed histogram</span>
                </div>
              </div>
            );
          })}
        </div>
        )}
      </div>
      </>
      )}

      {view === "cut" && activeCut && (
        <CutDetail
          cut={activeCut}
          ledger={displayLedger}
          onContribute={() => setView("contribute")}
          onBack={() => setView("browse")}
        />
      )}

      {view === "contribute" && activeCut && (
        <ContributeWizard
          cut={activeCut}
          cuts={cuts}
          onCutChange={setActiveCutKey}
          onClose={() => setView("browse")}
          onSuccess={(cut, bucket) => {
            // reload ledger + refresh live chain data after successful submit
            setLedger(loadLedger());
            refreshLive();
            setActiveCutKey(cutKeyString(cut));
            setView("result");
            // store last result for percentile view
            (window as any).__gotitLast = { cut, bucket };
          }}
          onDemoFallback={setDemoFallback}
          ledger={displayLedger}
        />
      )}

      {view === "result" && (
        <ResultView
          ledger={displayLedger}
          onBack={() => setView("cut")}
          onBrowse={() => setView("browse")}
        />
      )}

      {view === "report" && (
        <Suspense fallback={<div className="container" style={{ padding: "40px 20px" }}><div className="muted">Loading report…</div></div>}>
          <ReportPage />
        </Suspense>
      )}
      {view === "guide" && (
        <Suspense fallback={<div className="container" style={{ padding: "40px 20px" }}><div className="muted">Loading the setup guide…</div></div>}>
          <GuidePage onBack={() => setView("browse")} />
        </Suspense>
      )}

      {view === "verify" && (
        <Suspense fallback={<div className="container" style={{ padding: "40px 20px" }}><div className="muted">Loading…</div></div>}>
          <VerifyPage />
        </Suspense>
      )}

      <footer className="container footer">
        <div className="sep" />
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <span>Powered by Midnight Network — provable pay transparency</span>
          <span className="mono">provable · unlinkable · suppressible</span>
        </div>
        <div style={{ marginTop: 8 }} className="small">
          Built on <a className="link" href="https://midnight.network" target="_blank" rel="noreferrer">midnight.network</a> · Pre-release statistics are illustrative · One contribution per verified member per epoch, enforced by cryptography.
        </div>
      </footer>

      {toast && (
        <div style={{ position: "fixed", bottom: 18, left: "50%", transform: "translateX(-50%)", background: "#1f1f23", border: "1px solid var(--line2)", padding: "10px 14px", borderRadius: 999, boxShadow: "var(--shadow)", zIndex: 50 }}>
          {toast}
        </div>
      )}

      <WalletGate
        open={showGate}
        phase={connectPhase}
        installed={laceReady}
        busy={connecting}
        onConnect={connectChain}
        onBrowse={() => setShowGate(false)}
        onOpenGuide={() => {
          setShowGate(false);
          setView("guide");
        }}
      />

      {operatorOpen && (
        <OperatorPanel
          chain={chain}
          onClose={() => setOperatorOpen(false)}
          onToast={showToast}
          onAddress={setStoredContractAddress}
          onV2Address={setStoredV2ContractAddress}
        />
      )}
    </div>
  );
}

function CutDetail({ cut, ledger, onContribute, onBack }: { cut: any; ledger: any; onContribute: () => void; onBack: () => void }) {
  const hist = histogramForCut(ledger, cut);
  const total = hist.reduce((a: number, b: number) => a + b, 0);
  const unlocked = total >= K_ANONYMITY;
  const max = Math.max(1, ...hist);
  const myContribs = loadMyContribs();
  const mine = myContribs.find((c) => cutKeyString(c.cut) === cutKeyString(cut));
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", backdropFilter: "blur(6px)", zIndex: 40, overflow: "auto", padding: 18 }}>
      <div className="container" style={{ maxWidth: 760, marginTop: 18 }}>
        <div className="card">
          <div className="card-pad">
            <button className="btn small" onClick={onBack}>← Back to cuts</button>
            <div className="kicker" style={{ marginTop: 12 }}>Cut detail</div>
            <h2 style={{ margin: "4px 0 6px", fontSize: 26 }}>{cutLabel(cut)}</h2>
            <div className="mono small muted">{cutKeyString(cut)} · epoch {ledger.epoch}</div>

            {unlocked ? (
              <>
                <div className="hist" style={{ height: 96, marginTop: 14 }}>
                  {hist.map((v: number, i: number) => (
                    <div key={i} className={`hist-bar ${v === max && v > 0 ? "active" : ""}`} style={{ height: `${Math.max(8, (v / max) * 88)}px` }}>
                      <div className="tip mono">{BUCKETS[i].label}: {v} · {Math.round((v / total) * 100)}%</div>
                    </div>
                  ))}
                </div>
                <div className="row small muted" style={{ flexWrap: "wrap", marginTop: 6 }}>
                  {BUCKETS.map((b) => (
                    <span key={b.id} className="mono" style={{ fontSize: 11 }}>{b.label}</span>
                  ))}
                </div>
                <div className="sep" />
                <div className="small muted">
                  Verified submissions: <strong style={{ color: "var(--text)" }}>{total}</strong> · Each bar increments by 1 per verified contributor. No individual salary is recoverable — only the bucket is disclosed on-chain.
                </div>
                {mine && <div className="notice" style={{ marginTop: 10, borderColor: "#2a3d1a", background: "#0f1a0f" }}>You contributed to this cut in bucket <strong>{BUCKETS[mine.bucket]?.label}</strong> — percentile shown in your result.</div>}
              </>
            ) : (
              <div className="lock" style={{ marginTop: 12 }}>
                <div style={{ fontSize: 28 }}>🔒</div>
                <div><strong>Locked</strong> — {total}/{K_ANONYMITY} verified contributors</div>
                <div className="small muted">This cut stays hidden until it reaches k≥{K_ANONYMITY}. Be one of the first to unlock it.</div>
              </div>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={onContribute}>Contribute to this cut</button>
              <button className="btn" onClick={onBack}>Browse other cuts</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContributeWizard({ cut, cuts, onCutChange, onClose, onSuccess, onDemoFallback, ledger }: { cut: any; cuts: any[]; onCutChange: (k: string) => void; onClose: () => void; onSuccess: (cut: any, bucket: number) => void; onDemoFallback?: (active: boolean) => void; ledger: any }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [level, setLevel] = useState(cut.level);
  const [region, setRegion] = useState(cut.region);
  const [salary, setSalary] = useState<string>("150000");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedCut = useMemo(() => {
    const k = `${cut.family}:${level}:${region}`;
    return cuts.find((c) => cutKeyString(c) === k) ?? cut;
  }, [cut.family, level, region, cuts, cut]);

  const bucket = useMemo(() => {
    const n = Number(salary.replace(/[^0-9]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return null;
    return bucketForSalary(n);
  }, [salary]);

  const doRequest = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await requestCode(email);
      setDemoCode(r.demoCode);
      setStep(2);
    } catch (e: any) { setErr(e.message ?? "request failed"); } finally { setBusy(false); }
  };
  const doConfirm = async () => {
    setErr(null); setBusy(true);
    try {
      await confirmCode(email, code);
      setVerified(true);
      setStep(3);
    } catch (e: any) { setErr(e.message ?? "invalid code"); } finally { setBusy(false); }
  };
  const doEnrollAndSubmit = async () => {
    if (bucket == null) { setErr("enter a valid salary"); return; }
    setErr(null); setBusy(true);
    try {
      const secret = getOrCreateSecret();
      const leafHex = await enrollLeaf(email, secret);
      // optimistic local ledger enroll
      let snap = loadLedger();
      snap = enrollLocal(snap, leafHex);
      saveLedger(snap);

      const chainProps = (window as any).__gotitChain as { providers: GotItProviders } | undefined;
      const address = getStoredContractAddress();
      if (chainProps && address) {
        // REAL chain path: prove via Lace, submit on Preprod.
        const { cutKeyBytes } = await hashLib();
        const { submitOnChain, enrollOnChain } = await midnightLib();
        const issuerKey = getEffectiveIssuerKey();
        // Auto-enroll on-chain if not yet a member — makes the verified flow seamless.
        // This is what "enroll leaf first" means: one verified email = one on-chain leaf.
        // The demo script's verification step *is* the enroll step behind the scenes.
        if (issuerKey) {
          try {
            setErr("Enrolling your membership on-chain — please approve in Lace…");
            await enrollOnChain(chainProps.providers, address, {
              memberLeaf: hexToBytes(leafHex.replace(/^0x/, "").trim()),
              issuerKey: hexToBytes(issuerKey),
            });
            setErr(null);
            // Brief pause for the transaction to be indexed before the membership check in submit
            await new Promise((r) => setTimeout(r, 3500));
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (/already/i.test(msg)) {
              // Already a member — that's success, proceed silently
            } else if (/unlock|locked/i.test(msg)) {
              throw new Error("Lace is locked — click the Lace icon to unlock, then try Submit again.");
            } else {
              console.warn("[gotit] auto-enroll skipped:", msg.slice(0, 300));
              // Hosted prover 403 or other transient — still try submit; the submit's
              // fallback will handle it and show a friendly message.
            }
          }
        } else {
          console.warn("[gotit] no issuer key available — skipping on-chain enroll, will try submit anyway");
        }
        let chainSucceeded = false;
        try {
          await submitOnChain(chainProps.providers, address, {
            cutKey: cutKeyBytes(cutKeyString(selectedCut)),
            bucket,
            secret,
          });
          chainSucceeded = true;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          const isProverDown = /403|Failed to fetch|Load failed|proof-server|prove/i.test(msg);
          if (isProverDown) {
            console.warn("[gotit] hosted prover unavailable, entering demo mode:", msg.slice(0, 300));
            onDemoFallback?.(true);
            await new Promise((r) => setTimeout(r, 900));
            const res = await submitLocal(snap, secret, selectedCut, bucket);
            if (!res.ok) throw new Error(res.reason);
            onSuccess(selectedCut, bucket);
            return;
          }
          if (/not a member/i.test(msg)) {
            throw new Error("Enrollment is still pending — the on-chain enroll may still be confirming. Please wait ~10s and try again, or use the Operator panel to enroll this leaf.");
          }
          if (/email not verified/i.test(msg)) {
            throw new Error("Email not verified on the issuer — please restart verification from step 1.");
          }
          throw e;
        }
        if (chainSucceeded) {
          onDemoFallback?.(false);
          // Refresh live data after a real submit so the next browse shows the new state
          try { await (window as any).__gotitRefreshLive?.(); } catch {}
        }
      } else {
        // demo path: simulated proving, mock ledger
        await new Promise((r) => setTimeout(r, 900));
        const res = await submitLocal(snap, secret, selectedCut, bucket);
        if (!res.ok) throw new Error(res.reason);
      }
      onSuccess(selectedCut, bucket);
    } catch (e: any) { setErr(e.message ?? "submit failed"); } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(8px)", zIndex: 40, overflow: "auto", padding: 18 }}>
      <div className="container" style={{ maxWidth: 640, marginTop: 18 }}>
        <div className="card">
          <div className="card-pad">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn small" onClick={onClose}>✕ Close</button>
              <span className="mono small muted">Step {step}/4 · {["Verify", "Confirm", "Describe", "Submit"][step - 1]}</span>
            </div>
            <div className="steps">
              {[1, 2, 3, 4].map((s) => <div key={s} className={`step ${s <= step ? "on" : ""}`} />)}
            </div>

            {step === 1 && (
              <>
                <h2 style={{ margin: "6px 0 4px" }}>Verify you’re real</h2>
                <p className="small muted" style={{ lineHeight: 1.5 }}>
                  Enter your work email. We check it via the issuer and create a leaf that proves you’re a verified member — without giving the issuer your secret or your salary.
                </p>
                <div className="notice" style={{ margin: "10px 0" }}>
                  <strong>Trust boundary.</strong> The issuer learns who is a member (email → leaf), but never sees your secret, so it cannot link your future submission to you.
                </div>
                <label className="small muted">Work email</label>
                <input className="input" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginTop: 6 }} />
                {err && <div className="small" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" disabled={!email.includes("@") || busy} onClick={doRequest}>{busy ? "Sending…" : "Send code"}</button>
                  <span className="small muted">Beta: your code appears on the next screen instantly</span>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h2 style={{ margin: "6px 0 4px" }}>Enter the code</h2>
                {demoCode && <div className="code" style={{ margin: "8px 0" }}>Verification code for <b>{email}</b>: <span className="mono" style={{ fontSize: 16, color: "var(--accent)" }}>{demoCode}</span> — copy it below.</div>}
                <label className="small muted">6-digit code</label>
                <input className="input" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} style={{ marginTop: 6 }} />
                {err && <div className="small" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" disabled={code.length < 4 || busy} onClick={doConfirm}>{busy ? "Checking…" : "Verify"}</button>
                  <button className="btn" onClick={() => setStep(1)}>Back</button>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h2 style={{ margin: "6px 0 4px" }}>Describe your role</h2>
                <p className="small muted">One question per screen. Your exact salary is bucketed locally — on-chain, only the bucket index is disclosed.</p>
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <label className="small muted">Level</label>
                  <select className="select" value={level} onChange={(e) => { setLevel(e.target.value as any); onCutChange(`${cut.family}:${e.target.value}:${region}`); }}>
                    {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                  <label className="small muted">Region</label>
                  <select className="select" value={region} onChange={(e) => { setRegion(e.target.value as any); onCutChange(`${cut.family}:${e.target.value}:${level}`); }}>
                    {REGIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                  <label className="small muted">Total comp (USD, base + bonus + equity annualized)</label>
                  <input className="input" inputMode="numeric" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="150000" />
                  <div className="notice">
                    {bucket != null ? (
                      <>You’ll contribute to <strong>{cutLabel(selectedCut)}</strong> · bucket <strong>{BUCKETS[bucket].label}</strong> — the distribution, not your number, becomes public.</>
                    ) : (
                      <>Enter a salary to see your bucket.</>
                    )}
                    <div className="small muted" style={{ marginTop: 6 }}>Coarse buckets are a privacy/utility dial — they guarantee each increment reveals only a range.</div>
                  </div>
                </div>
                {err && <div className="small" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" disabled={bucket == null || busy} onClick={() => setStep(4)}>Continue</button>
                  <button className="btn" onClick={() => setStep(2)}>Back</button>
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <h2 style={{ margin: "6px 0 4px" }}>Submit anonymously</h2>
                <div className="notice">
                  <strong>What happens on submit:</strong> Your device derives a leaf from your secret (already enrolled), builds a membership proof, derives an epoch nullifier (one per verified person per epoch), and increments the bucket. Only <span className="mono">cutKey</span> and <span className="mono">bucket</span> are disclosed on-chain.
                </div>
                <div className="code" style={{ marginTop: 10 }}>
                  <div>cut: {cutKeyString(selectedCut)}</div>
                  <div>bucket: {bucket} · {bucket != null ? BUCKETS[bucket].label : "—"}</div>
                  <div>leaf: {(getSecretHex() ?? "").slice(0, 10)}… (derived locally)</div>
                  <div>epoch: {ledger.epoch} · k≥{K_ANONYMITY}</div>
                </div>
                <div className="notice" style={{ marginTop: 10, borderColor: verified ? "#2a3d1a" : undefined }}>
                  {verified ? "✓ Verified member" : "Not verified"} · {ledger.members.length} total members · {ledger.nullifiers.length} submissions this epoch
                </div>
                {err && <div className="small" style={{ color: "var(--red)", marginTop: 8 }}>{err}</div>}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" disabled={busy || bucket == null} onClick={doEnrollAndSubmit}>{busy ? "Proving & submitting…" : "Submit — generate ZK proof locally"}</button>
                  <button className="btn" onClick={() => setStep(3)}>Back</button>
                </div>
                <div className="small muted" style={{ marginTop: 8 }}>
                    {(import.meta as any).env?.VITE_HOSTED_PROVER === "true"
                      ? "Beta hosted demo: proof generation is routed through a hosted proving service over TLS. For full on-device privacy, run GotIt locally — see the repo docs."
                      : "Your device generates the zero-knowledge proof — your exact salary never leaves this browser."}
                  </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultView({ ledger, onBack, onBrowse }: { ledger: any; onBack: () => void; onBrowse: () => void }) {
  const last = (window as any).__gotitLast as { cut: any; bucket: number } | undefined;
  const cut = last?.cut;
  const bucket = last?.bucket;
  const pct = cut && bucket != null ? percentileForBucket(ledger, cut, bucket) : null;
  const hist = cut ? histogramForCut(ledger, cut) : null;
  const total = hist ? hist.reduce((a: number, b: number) => a + b, 0) : 0;

  if (!cut || bucket == null) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 40, padding: 18 }}>
        <div className="container" style={{ maxWidth: 560, marginTop: 24 }}>
          <div className="card card-pad">
            <p>No recent submission found.</p>
            <button className="btn" onClick={onBrowse}>Browse cuts</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(8px)", zIndex: 40, overflow: "auto", padding: 18 }}>
      <div className="container" style={{ maxWidth: 560, marginTop: 18 }}>
        <div className="card" style={{ borderColor: "#3a3a0a" }}>
          <div className="card-pad">
            <div className="kicker">Recorded · nobody can link this to you</div>
            <div className="percent-hero">
              <div className="percent-num">{pct != null ? `${pct}th` : "—"}</div>
              <div className="percent-label">percentile in {cutLabel(cut)}</div>
              <div className="small muted" style={{ marginTop: 4 }}>Bucket {BUCKETS[bucket].label} · {total} verified contributors</div>
            </div>

            {hist && (
              <div className="hist" style={{ height: 72, marginTop: 12 }}>
                {hist.map((v: number, i: number) => (
                  <div key={i} className={`hist-bar ${i === bucket ? "active" : ""}`} style={{ height: `${Math.max(6, (v / Math.max(1, ...hist)) * 64)}px` }} />
                ))}
              </div>
            )}
            <div className="small muted" style={{ textAlign: "center", marginTop: 6 }}>Your bucket highlighted · distribution is public, individual records never are</div>

            <div className="sep" />
            <div className="notice">
              <strong>What just happened.</strong> One bucket incremented by 1. No one watching the chain can recover your exact salary from the delta — only that “one verified person in bucket {bucket}” arrived. That’s the histogram-not-sum guarantee.
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={onBack}>View this cut</button>
              <button className="btn" onClick={onBrowse}>Browse all cuts</button>
              <button className="btn btn-ghost" onClick={() => { if (navigator.share) navigator.share({ title: "GotIt", text: `I'm in the ${pct}th percentile for ${cutLabel(cut)} — verified on GotIt.`, url: location.href }); else { navigator.clipboard.writeText(`I'm in the ${pct}th percentile for ${cutLabel(cut)} — verified on GotIt.`); } }}>Share percentile</button>
            </div>

            <div className="small muted" style={{ marginTop: 10 }}>
              Your data expires after this epoch ({ledger.epoch}) — you’ll be eligible to refresh it next quarter. That’s the retention loop, and it’s cryptographic.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OperatorPanel({
  chain,
  onClose,
  onToast,
  onAddress,
  onV2Address,
}: {
  chain: { providers: GotItProviders } | null;
  onClose: () => void;
  onToast: (msg: string) => void;
  /** Writes the v1 contract address (the Wave 1 ledger). */
  onAddress: (addr: string) => void;
  /** Writes the v2 contract address (the Art. 9 ledger the report reads). */
  onV2Address: (addr: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  /**
   * The last chain failure, unwrapped.
   *
   * Chain errors arrive as Effect FiberFailures whose `message` is empty, so a
   * toast saying "deploy failed" is all the operator gets. This holds the full
   * extracted report so the reason is readable on screen, in the surface where
   * the deploy was attempted, without opening devtools.
   */
  const [chainError, setChainError] = useState<{ op: string; report: string; raw: string } | null>(null);
  /**
   * The v2 contribution form.
   *
   * Nothing submitted to the v2 ledger until this existed: deployV2 was wired to
   * a button, submitV2 was not wired to anything, so a deployed contract could
   * never receive a figure and the report always said "nothing publishable".
   *
   * `seed` derives the person's secret, so the operator can put N distinct people
   * into the ledger by advancing it. It auto-increments after each submission to
   * make that one click per person.
   */
  const [v2Form, setV2Form] = useState({
    seed: "person-1",
    category: "engineering",
    gender: 0,
    component: 0,
    bucket: 4,
  });
  /**
   * The employer's category list, shared with the report page.
   *
   * The category is a HASH on chain, so a submission under "Entrepreneur" is
   * invisible to a report looking for "engineering" — both valid, different
   * hashes. Five submissions read as `no-data · 0 participants` for exactly that
   * reason. The list is now one list, and this form selects from it.
   */
  const [categories, setCategories] = useState<StoredCategory[]>(() => loadCategories());
  useEffect(() => {
    const refresh = () => setCategories(mergeCategories(loadCategories(), usedCategories()));
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const [v2Log, setV2Log] = useState<string[]>([]);
  const [issuerKeyHex, setIssuerKeyHex] = useState<string>(() => getStoredIssuerKey() ?? "");
  const [leafHex, setLeafHex] = useState<string>("");
  const [enrollEmail, setEnrollEmail] = useState<string>("");
  // v2 address is stored separately from v1 so a v2 deploy can never silently
  // repoint the live report at a contract with no data in it.
  const [v2Address, setV2Address] = useState<string | null>(() => getStoredV2ContractAddress());
  const address = getStoredContractAddress();
  const effectiveKey = getEffectiveIssuerKey() ?? issuerKeyHex.replace(/^0x/, "").trim();
  const keyValid = /^[0-9a-fA-F]{64}$/.test(effectiveKey);
  // Auto-save baked key on first load so the operator never has to paste
  useEffect(() => {
    const baked = getBakedIssuerKey();
    if (baked && !getStoredIssuerKey()) {
      try { localStorage.setItem("gotit:issuerKey", baked); if (!issuerKeyHex) setIssuerKeyHex(baked); } catch {}
    }
  }, []);

  const saveIssuerKey = () => {
    const clean = issuerKeyHex.replace(/^0x/, "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) { onToast(`issuer key must be 64 hex chars (got ${clean.length} chars)`); return; }
    try { localStorage.setItem("gotit:issuerKey", clean); } catch {}
    onToast("Issuer key saved (local only)");
  };

  const doDeploy = async () => {
    if (!chain) return;
    const clean = effectiveKey;
    if (!keyValid) { onToast(`issuer key invalid (${clean.length} chars) — paste 64 hex chars and Save`); return; }
    setBusy(true);
    try {
      const { deployGotIt, deployedAddress } = await midnightLib();
      const deployed = await deployGotIt(chain.providers, hexToBytes(clean));
      // Throws rather than falling back to "check Lace": a deploy that
      // succeeded but lost its address is worse than one that failed loudly,
      // because the operator cannot tell whether they have a contract.
      const addr = deployedAddress(deployed);
      onAddress(addr);
      onToast(`Deployed at ${addr}`);
    } catch (e: any) {
      console.error("[gotit] deploy failed:", failureReport(e), "\nraw:", e);
      onToast(`deploy failed: ${describeFailure(e)}`);
      setChainError({ op: "v1 deploy", report: failureReport(e), raw: safeStringify(e) });
    } finally { setBusy(false); }
  };

  const doDeployV2 = async () => {
    if (!chain) return;
    const clean = effectiveKey;
    if (!keyValid) { onToast(`issuer key invalid (${clean.length} chars) — paste 64 hex chars and Save`); return; }
    setBusy(true);
    try {
      const v2 = await import("./lib/midnight.v2");
      const { DEFAULT_K } = await import("@gotit/shared/paygap");

      // Check the prerequisites before touching the chain. A deploy that fails
      // inside midnight-js raises an Effect failure with an EMPTY message, so a
      // missing artefact or a stopped prover is indistinguishable from a wallet
      // problem. This turns that into a named cause.
      const pre = await preflightV2Deploy({
        origin: window.location.origin,
        walletConnected: Boolean(chain),
        issuerKeyOk: keyValid,
      });
      if (!pre.ok) {
        setChainError({
          op: "v2 deploy preflight",
          report: describePreflight(pre),
          raw: safeStringify(pre.checks),
        });
        onToast(`v2 deploy blocked: ${pre.summary}`);
        return;
      }

      const providers = v2.buildV2Providers({
        indexerUri: INDEXER_HTTP,
        indexerWsUri: INDEXER_WS,
        proverServerUri: `${window.location.origin}/proof-server`,
        walletProvider: (chain.providers as any).walletProvider,
        midnightProvider: (chain.providers as any).midnightProvider,
      });
      const addr = await v2.deployV2(providers, hexToBytes(clean), DEFAULT_K);
      if (!/^[0-9a-fA-F]{64}$/.test(addr.replace(/^0x/, ""))) {
        // Never store a malformed address: it would be read back later as a
        // contract that does not exist, and the report would blame the ledger.
        throw new Error(`deploy returned an unusable address (${JSON.stringify(addr)})`);
      }
      setV2Address(addr);
      setStoredV2ContractAddress(addr); // the report reads this key
      onToast(`v2 deployed at ${addr} (k=${DEFAULT_K}). Use it as the report source.`);
    } catch (e: any) {
      console.error("[gotit] v2 deploy failed:", failureReport(e), "\nraw:", e);
      onToast(friendlyChainError(e, "v2 deploy"));
      setChainError({ op: "v2 deploy", report: failureReport(e), raw: safeStringify(e) });
    } finally { setBusy(false); }
  };

  const doNextEpochV2 = async () => {
    if (!chain || !v2Address) return;
    if (!keyValid) { onToast("issuer key invalid — paste 64 hex chars and Save"); return; }
    setBusy(true);
    try {
      const v2 = await import("./lib/midnight.v2");
      const providers = v2.buildV2Providers({
        indexerUri: INDEXER_HTTP,
        indexerWsUri: INDEXER_WS,
        proverServerUri: `${window.location.origin}/proof-server`,
        walletProvider: (chain.providers as any).walletProvider,
        midnightProvider: (chain.providers as any).midnightProvider,
      });
      await v2.nextEpochV2(providers, v2Address, { issuerKey: hexToBytes(effectiveKey) });
      onToast("Reporting period advanced — everyone may contribute once more");
    } catch (e: any) {
      console.error("[gotit] v2 nextEpoch failed:", failureReport(e), "\nraw:", e);
      onToast(friendlyChainError(e, "v2 nextEpoch"));
      setChainError({ op: "v2 nextEpoch", report: failureReport(e), raw: safeStringify(e) });
    } finally { setBusy(false); }
  };

/**
 * A deterministic secret for a seeded contributor.
 *
 * The Operator panel seeds demo data, and each person needs a distinct secret.
 * Deriving it from a label rather than randomly means the operator can put
 * "person-1" into the ledger, write it down, and reproduce the same person later
 * — which is what makes the demo repeatable rather than a one-shot.
 *
 * This is a DEMO affordance, not the product path: a real employee's secret is
 * generated on their own device by getOrCreateSecret() and never derived from
 * anything guessable. Nothing here is used by the worker flow.
 */
async function secretFromSeed(seed: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`gotit:operator-seed:v2:${seed}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

const doEnrollV2 = async () => {
  if (!chain || !v2Address) { onToast("deploy v2 first"); return; }
  if (!keyValid) { onToast("issuer key invalid — paste 64 hex chars and Save"); return; }
  setBusy(true);
  try {
    const v2 = await import("./lib/midnight.v2");
    const { memberLeaf2 } = await import("@gotit/shared/hash");
    const providers = v2.buildV2Providers({
      indexerUri: INDEXER_HTTP,
      indexerWsUri: INDEXER_WS,
      proverServerUri: `${window.location.origin}/proof-server`,
      walletProvider: (chain.providers as any).walletProvider,
      midnightProvider: (chain.providers as any).midnightProvider,
    });
    const secret = await secretFromSeed(v2Form.seed);
    await v2.enrollV2(providers, v2Address, {
      leaf: memberLeaf2(secret),
      issuerKey: hexToBytes(effectiveKey),
      secret,
    });
    setV2Log((l) => [`enrolled ${v2Form.seed}`, ...l].slice(0, 12));
    onToast(`${v2Form.seed} enrolled on v2`);
  } catch (e: any) {
    console.error("[gotit] v2 enroll failed:", failureReport(e), "\nraw:", e);
    setChainError({ op: "v2 enroll", report: failureReport(e), raw: safeStringify(e) });
    onToast(friendlyChainError(e, "v2 enroll"));
  } finally { setBusy(false); }
};

const doSubmitV2 = async () => {
  if (!chain || !v2Address) { onToast("deploy v2 first"); return; }
  setBusy(true);
  try {
    const v2 = await import("./lib/midnight.v2");
    const { categoryKeyBytes } = await import("@gotit/shared/hash");
    const providers = v2.buildV2Providers({
      indexerUri: INDEXER_HTTP,
      indexerWsUri: INDEXER_WS,
      proverServerUri: `${window.location.origin}/proof-server`,
      walletProvider: (chain.providers as any).walletProvider,
      midnightProvider: (chain.providers as any).midnightProvider,
    });
    const secret = await secretFromSeed(v2Form.seed);
    // Record the label before submitting: if the report does not know to look for
    // it, the figures are on chain but unreadable, which is indistinguishable
    // from not having submitted at all.
    rememberUsedCategory(v2Form.category);
    setCategories(mergeCategories(loadCategories(), usedCategories()));
    await v2.submitV2(providers, v2Address, {
      categoryKey: categoryKeyBytes(v2Form.category),
      gender: v2Form.gender,
      component: v2Form.component,
      bucket: v2Form.bucket,
      secret,
    });
    setV2Log((l) =>
      [
        `submitted ${v2Form.seed}: ${v2Form.category} · ${
          v2Form.gender === 0 ? "women" : v2Form.gender === 1 ? "men" : "other"
        } · ${v2Form.component === 0 ? "base" : "variable"} · bucket ${v2Form.bucket}`,
        ...l,
      ].slice(0, 12),
    );
    // Advance the seed so one click is one person.
    setV2Form((f) => {
      const m = f.seed.match(/^(.*?)(\d+)$/);
      return { ...f, seed: m ? `${m[1]}${Number(m[2]) + 1}` : `${f.seed}-2` };
    });
    onToast(`submitted for ${v2Form.seed}`);
  } catch (e: any) {
    console.error("[gotit] v2 submit failed:", failureReport(e), "\nraw:", e);
    setChainError({ op: "v2 submit", report: failureReport(e), raw: safeStringify(e) });
    onToast(friendlyChainError(e, "v2 submit"));
  } finally { setBusy(false); }
};

  const doEnroll = async () => {
    if (!chain || !address) { onToast("deploy first"); return; }
    const clean = effectiveKey;
    if (!keyValid) { onToast(`issuer key invalid (${clean.length} chars) — paste 64 hex chars and Save`); return; }
    setBusy(true);
    try {
      const { enrollOnChain } = await midnightLib();
      await enrollOnChain(chain.providers, address, {
        memberLeaf: hexToBytes(leafHex.replace(/^0x/, "").trim()),
        issuerKey: hexToBytes(clean),
      });
      onToast("Member enrolled on-chain");
    } catch (e: any) {
      console.error("[gotit] enroll failed:", failureReport(e), "\nraw:", e);
      onToast(friendlyChainError(e, "enroll"));
      setChainError({ op: "enroll", report: failureReport(e), raw: safeStringify(e) });
    } finally { setBusy(false); }
  };

  const doEnrollMine = async () => {
    const secret = getOrCreateSecret();
    const { memberLeaf } = await hashLib();
    setLeafHex(bytesToHex(memberLeaf(secret)));
  };

  const doEnrollByEmail = async () => {
    // fetch the leaf the issuer computed for a verified email (issuer service keeps a map)
    try {
      const r = await fetch(`/issuer/leaf?email=${encodeURIComponent(enrollEmail)}`);
      const j = await r.json();
      if (j?.leafHex) setLeafHex(j.leafHex);
      else onToast("no leaf for that email");
    } catch { onToast("issuer service unreachable"); }
  };

  const doNextEpoch = async () => {
    if (!chain || !address) { onToast("deploy first"); return; }
    const clean = effectiveKey;
    if (!keyValid) { onToast(`issuer key invalid (${clean.length} chars) — paste 64 hex chars and Save`); return; }
    setBusy(true);
    try {
      const { nextEpochOnChain } = await midnightLib();
      await nextEpochOnChain(chain.providers, address, { issuerKey: hexToBytes(clean) });
      onToast("Epoch advanced — members can submit again");
    } catch (e: any) { onToast(e?.message ?? "nextEpoch failed"); } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", backdropFilter: "blur(8px)", zIndex: 40, overflow: "auto", padding: 18 }}>
      <div className="container" style={{ maxWidth: 640, marginTop: 18 }}>
        <div className="card">
          <div className="card-pad">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn small" onClick={onClose}>✕ Close</button>
              <span className="mono small muted">issuer console · Preprod</span>
            </div>
            <h2 style={{ margin: "6px 0 4px" }}>Issuer console</h2>
            <p className="small muted">
              The operator wallet holds the issuer key witness. It can enroll member leaves and advance the
              epoch — nothing else. It never sees contributor secrets or salaries.
            </p>

            <div className="row" style={{ justifyContent: "space-between" }}>
              <label className="small muted">Issuer secret key (hex, stays in this browser)</label>
              <span className="small" style={{ color: keyValid ? "var(--green)" : "var(--red)" }}>
                {keyValid ? "✓ key loaded" : "✗ no key"}
              </span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <input className="input" value={issuerKeyHex} onChange={(e) => setIssuerKeyHex(e.target.value)} placeholder="64 hex chars" />
              <button className="btn small" onClick={saveIssuerKey}>Save</button>
            </div>

            <div className="sep" />
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="small muted">Wave 1 contract (deployed)</div>
                <div className="mono small">{address ?? "not deployed"}</div>
              </div>
              <button className="btn small" disabled={busy || !chain} onClick={doDeploy}>
                {busy ? "Deploying…" : "Deploy v1"}
              </button>
            </div>

            <div className="sep" />
            <div>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div className="small muted">Wave 2 contract — Art. 9 dimensions</div>
                  <div className="mono small">{v2Address ?? "not deployed"}</div>
                </div>
                <button className="btn btn-primary small" disabled={busy || !chain} onClick={doDeployV2}>
                  {busy ? "Deploying…" : "Deploy v2"}
                </button>
              </div>
              <div className="small muted" style={{ marginTop: 6, lineHeight: 1.5 }}>
                v2 adds job category, gender and base/variable dimensions, and enforces the anonymity
                threshold inside the read circuit — <code>getHistogram</code> returns 0 for any group
                below k, so a small category cannot be published at all. Wave 1 keeps working untouched.
              </div>
              {chainError && (
                <div
                  className="notice"
                  style={{ marginTop: 12, borderColor: "#4c1d1d", background: "#160c0c", fontSize: 12 }}
                >
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <b style={{ color: "#fca5a5" }}>Last chain failure — {chainError.op}</b>
                    <div className="row" style={{ gap: 8 }}>
                      <button
                        className="btn btn-ghost small"
                        onClick={() => {
                          navigator.clipboard?.writeText(`${chainError.op}\n\n${chainError.report}\n\nraw:\n${chainError.raw}`);
                          onToast("Error detail copied");
                        }}
                      >
                        Copy detail
                      </button>
                      <button className="btn btn-ghost small" onClick={() => setChainError(null)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                  <pre
                    className="mono"
                    style={{ marginTop: 8, marginBottom: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5, maxHeight: 260, overflow: "auto" }}
                  >
                    {chainError.report}
                  </pre>
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted" style={{ cursor: "pointer" }}>raw error object</summary>
                    <pre
                      className="mono"
                      style={{ marginTop: 6, marginBottom: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 240, overflow: "auto" }}
                    >
                      {chainError.raw}
                    </pre>
                  </details>
                  <div className="muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
                    The wallet, the indexer and the proof server are three different services. The line above
                    naming a host or a path tells you which one answered.
                  </div>
                </div>
              )}

              {v2Address && (
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button
                    className="btn small"
                    onClick={() => {
                      // The report reads the V2 key. Writing the v1 key here — which is
                      // what this button used to do — left the report reading Wave 1
                      // state under a v2 heading.
                      onV2Address(v2Address);
                      onToast("Report will read the v2 contract");
                    }}
                  >
                    Use v2 as the report source
                  </button>
                  <button className="btn btn-ghost small" onClick={doNextEpochV2} disabled={busy}>
                    Advance reporting period
                  </button>
                </div>
              )}

              {v2Address && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                  <div className="small muted" style={{ marginBottom: 8, lineHeight: 1.5 }}>
                    <b style={{ color: "var(--fg)" }}>Contribute to v2.</b> One seed is one person.
                    Enroll then submit, and the seed advances so the next click is the next person.
                    The secret is derived from the seed, so a demo is reproducible.
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <input
                      className="input"
                      style={{ flex: "1 1 130px", minWidth: 120 }}
                      value={v2Form.seed}
                      onChange={(e) => setV2Form((f) => ({ ...f, seed: e.target.value }))}
                      placeholder="person-1"
                      title="Derives this contributor's secret"
                    />
                    <select
                      className="input"
                      style={{ flex: "1 1 150px", minWidth: 140 }}
                      value={v2Form.category}
                      onChange={(e) => setV2Form((f) => ({ ...f, category: e.target.value }))}
                      title="Job category. The ledger stores only its hash, so the report must be told the same label."
                    >
                      {categories.map((c) => (
                        <option key={c.id} value={c.label}>{c.label}</option>
                      ))}
                      {!categories.some((c) => c.label === v2Form.category) && (
                        <option value={v2Form.category}>{v2Form.category}</option>
                      )}
                    </select>
                    <select
                      className="input"
                      value={v2Form.gender}
                      onChange={(e) => setV2Form((f) => ({ ...f, gender: Number(e.target.value) }))}
                    >
                      <option value={0}>Women</option>
                      <option value={1}>Men</option>
                      <option value={2}>Other / not disclosed</option>
                    </select>
                    <select
                      className="input"
                      value={v2Form.component}
                      onChange={(e) => setV2Form((f) => ({ ...f, component: Number(e.target.value) }))}
                    >
                      <option value={0}>Base salary</option>
                      <option value={1}>Variable / complementary</option>
                    </select>
                    <select
                      className="input"
                      value={v2Form.bucket}
                      onChange={(e) => setV2Form((f) => ({ ...f, bucket: Number(e.target.value) }))}
                      title="Pay band. Base and variable use different scales."
                    >
                      {BUCKETS.map((b) => (
                        <option key={b.id} value={b.id}>{b.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <button className="btn small" disabled={busy || !chain} onClick={doEnrollV2}>
                      Enroll {v2Form.seed}
                    </button>
                    <button className="btn btn-primary small" disabled={busy || !chain} onClick={doSubmitV2}>
                      Submit to v2
                    </button>
                  </div>
                  {v2Log.length > 0 && (
                    <pre
                      className="mono small muted"
                      style={{ marginTop: 8, marginBottom: 0, whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 140, overflow: "auto" }}
                    >
                      {v2Log.join("\n")}
                    </pre>
                  )}
                </div>
              )}
            </div>

            <div className="sep" />
            <label className="small muted">Member leaf to enroll (hex)</label>
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <input className="input" value={leafHex} onChange={(e) => setLeafHex(e.target.value)} placeholder="leaf hex" />
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn small" onClick={doEnrollMine}>Load my leaf (this browser)</button>
              <input className="input" style={{ maxWidth: 220 }} placeholder="user@company.com" value={enrollEmail} onChange={(e) => setEnrollEmail(e.target.value)} />
              <button className="btn small" onClick={doEnrollByEmail}>Fetch by email</button>
              <button className="btn btn-primary small" disabled={busy || !address || !leafHex} onClick={doEnroll}>
                {busy ? "Enrolling…" : "Enroll on-chain"}
              </button>
            </div>

            <div className="sep" />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small muted">Advancing the epoch lets every member submit once more.</span>
              <button className="btn small" disabled={busy || !address} onClick={doNextEpoch}>Advance epoch</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
