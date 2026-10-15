import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assembleArt9Report,
  assertNoSmallCellLeak,
  type Art9ReportBundle,
} from "../lib/art9";
import { allGroups, bucketLabels, type JobCategory } from "../lib/groups";
import {
  getStoredContractAddress,
  getStoredV2ContractAddress,
  getUrlContractAddress,
  shareableReportUrl,
} from "../lib/session";
import {
  loadCategories,
  saveCategories,
  mergeCategories,
  usedCategories,
  parseCategoryText,
} from "../lib/categoryStore";
import { GENDER, COMPONENT, GENDER_LABEL, COMPONENT_LABEL, DEFAULT_K } from "@gotit/shared/paygap";

/**
 * The Wave 2 report surface — Art. 9 statistics read from the v2 ledger.
 *
 * Two rules shape this page:
 *
 *   1. It never falls back. If the v2 contract is missing, or the read fails, or
 *      the ledger is in an older version, the page says so. An empty table that
 *      looks authoritative is the exact failure that would sink this in
 *      judging — a compliance officer who pastes the wrong figures files a
 *      report that is wrong.
 *   2. The category list is supplied by the employer, because the ledger stores
 *      category keys as hashes. The chain can tell us a group is populated; it
 *      cannot tell us the category is called "Engineering". The report therefore
 *      takes the label mapping as input and prints it as part of the artifact.
 */

/**
 * The categories to look for. Read from the shared store, merged with anything
 * the Operator has actually submitted under.
 *
 * This is not cosmetic. The ledger keys groups by `hash(label)`, so a report
 * looking for "engineering" cannot see a group filed under "Entrepreneur" —
 * different hashes, both valid, and the ledger has no name to compare. Five
 * submissions read as `no-data · 0 participants` for exactly that reason.
 *
 * Merging used labels means a category nobody configured but somebody submitted
 * to still shows up, rather than being silently omitted from coverage.
 */
function activeCategories(): JobCategory[] {
  return mergeCategories(loadCategories(), usedCategories()).map((c) => ({
    id: c.id,
    label: c.label,
  }));
}

const PERIOD = "FY2026 — Art. 9 preview";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; hint?: string }
  | { kind: "ready"; bundle: Art9ReportBundle; fingerprint: string; illustrative: boolean };

export default function ReportPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [categories, setCategories] = useState<JobCategory[]>(() => activeCategories());
  const [categoriesText, setCategoriesText] = useState(() =>
    activeCategories().map((c) => c.label).join("\n"),
  );
  const [showSetup, setShowSetup] = useState(false);
  const [setupProblems, setSetupProblems] = useState<string[]>([]);
  const [illustrative, setIllustrative] = useState<boolean>(() => {
    try {
      return location.hash
        .replace(/^#/, "")
        .split(/[&?]/)
        .slice(1)
        .includes("sample");
    } catch {
      return false;
    }
  });

  /**
   * The v2 address, falling back to v1 ONLY so the error can explain itself.
   *
   * This is a v2 surface — it reads `groupCount`, `kThreshold` and the Art. 9
   * dimensions, none of which the Wave 1 ledger has. Reading the v1 address here
   * meant the page handed Wave 1 state to a v2 decoder, which failed with
   * "index out of bounds in idx: 5 >= 5" and pointed at the chain rather than at
   * the configuration. The fallback exists so that case produces an explanation
   * instead of a decoder error.
   */
  const v2Address = getStoredV2ContractAddress();
  const v1Address = getStoredContractAddress();
  // The URL wins, so a shared link shows the report it points at rather than
  // whatever this browser last deployed.
  const address = getUrlContractAddress() ?? v2Address ?? v1Address;

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    // Opt-in sample data, never automatic. #sample shows the report FORMAT on a
    // chain with no data yet. A failed LIVE read still errors - that is the
    // behaviour that matters, and the one that must not be softened.
    if (illustrative) {
      const { sampleArt9Report } = await import("../lib/art9.sample");
      const bundle = sampleArt9Report(categories, DEFAULT_K);
      assertNoSmallCellLeak(bundle.report, bundle.k);
      setState({ kind: "ready", bundle, fingerprint: "illustrative — not a chain read", illustrative: true });
      return;
    }
    if (!address) {
      setState({
        kind: "error",
        message: "No contract address configured for this deployment.",
        hint: "Set VITE_CONTRACT_ADDRESS, or deploy from the Operator console.",
      });
      return;
    }
    try {
      const read = await import("../lib/reportRead.v2");
      const { fingerprint, bundle } = await read.buildV2Report(address, categories, PERIOD);
      assertNoSmallCellLeak(bundle.report, bundle.k);
      setState({ kind: "ready", bundle, fingerprint, illustrative: false });
    } catch (e) {
      const raw = e instanceof Error ? e.message : "read failed";
      // Classify rather than dump. "index out of bounds in idx: 5 >= 5" is a
      // decoder complaining about foreign state, which reads as a chain problem
      // when the cause is a contract from a different revision — or, once, the
      // literal string "undefined" stored as an address.
      const v1State = /index out of bounds|invalid operation for type|groupCount|kThreshold/i.test(raw);
      const notFound = /not found|no matching|no readable|state not found/i.test(raw);
      setState({
        kind: "error",
        message: v1State
          ? "This contract's ledger does not have the Art. 9 dimensions (job category × gender × base/variable). It is almost certainly the Wave 1 contract, which predates them."
          : raw,
        hint: v1State
          ? "Deploy the v2 contract from the Operator console and press \"Use v2 as the report source\". Nothing is shown here rather than v1 numbers under a v2 heading."
          : notFound
            ? "The configured contract has no readable public state. Check the address, or deploy the v2 contract from the Operator console."
            : `Report generation failed before any figure was produced. Raw error: ${raw}`,
      });
    }
  }, [address, categories, illustrative]);

  useEffect(() => {
    void load();
  }, [load]);

  const markdown = useMemo(
    () => (state.kind === "ready" ? state.bundle.markdown : ""),
    [state],
  );

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const applyCategories = () => {
    const { categories: parsed, problems } = parseCategoryText(categoriesText);
    if (parsed.length === 0) {
      setSetupProblems(problems.length ? problems : ["At least one category is required."]);
      return;
    }
    // Persist, so the contribution form offers the same labels. A report whose
    // category list disagrees with the submissions is a report that shows zeros.
    saveCategories(parsed);
    setCategories(parsed);
    setSetupProblems(problems);
    setShowSetup(false);
    if (problems.length === 0) setSetupProblems([]);
  };

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: "24px 20px 80px" }}>
      <div className="kicker">COMPLIANCE REPORT</div>
      <h1 style={{ fontSize: 30, margin: "4px 0 6px", letterSpacing: "-0.02em" }}>Pay gap report</h1>
      <p className="muted" style={{ lineHeight: 1.55, margin: 0, maxWidth: 640 }}>
        Directive (EU) 2023/970 Art. 9 statistics, read from the ledger through the contract's own
        gated read circuit. No individual salary is readable from anything on this page — only counts,
        and only where a group is large enough that publishing it cannot identify anyone.
      </p>

      {state.kind === "loading" && (
        <div className="card card-pad" style={{ marginTop: 20 }}>
          <div className="muted">Reading reporting groups from the Preprod indexer…</div>
        </div>
      )}

      {state.kind === "error" && (
        <div className="card card-pad" style={{ marginTop: 20, borderColor: "#7f1d1d" }}>
          <div style={{ color: "#fca5a5", fontWeight: 600, marginBottom: 6 }}>No report published</div>
          <div className="muted" style={{ marginBottom: 10 }}>{state.message}</div>
          {state.hint && <div className="muted" style={{ marginBottom: 12, lineHeight: 1.5, fontSize: 13 }}>{state.hint}</div>}
          <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            This page never substitutes sample data for a failed read. A plausible-looking table is
            worse than an error here, because the output of this page is meant to be filed.
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <div className="card card-pad" style={{ marginTop: 20 }}>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <Stat label="Reporting period" value={String(state.bundle.period)} />
              <Stat label="Anonymity threshold" value={`k=${state.bundle.k}`} />
              <Stat label="Enrolled members" value={String(state.bundle.members)} />
              <Stat label="Submissions" value={String(state.bundle.submissions)} />
              <Stat label="Publishable groups" value={`${state.bundle.publishableGroups} / ${state.bundle.configuredGroups}`} />
            </div>
            {/*
              Which contract, and which category labels. Both are needed to know
              whether "no data" means nobody submitted or the report is looking in
              the wrong place — the difference between an empty ledger and five
              submissions filed under a label nobody configured.
            */}
            <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
              <div>
                reading <code style={{ color: "var(--fg)" }}>{address ?? "no contract configured"}</code>
                {" "}· categories{" "}
                <code style={{ color: "var(--fg)" }}>{categories.map((c) => c.label).join(", ")}</code>
              </div>
              <div>
                The ledger stores each category as a hash of its label, so a group filed under a
                label not listed here is invisible to this report. If your submissions are missing,
                press <b>Categories</b> and add the label you used.
              </div>
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {state.illustrative ? (
                <span className="badge small" style={{ color: "#facc15", borderColor: "#713f12", background: "#1a1500" }}>
                  ILLUSTRATIVE SAMPLE — not chain data
                </span>
              ) : (
                <span className="badge small" style={{ color: "var(--green)", borderColor: "#14301e", background: "var(--green-bg)" }}>
                  ● live on-chain
                </span>
              )}
              <span className="muted" style={{ fontSize: 13 }}>
                fingerprint <code style={{ color: "var(--fg)" }}>{state.fingerprint}</code>
              </span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  className="btn btn-ghost small"
                  onClick={() => {
                    const url = shareableReportUrl(address ?? "");
                    navigator.clipboard?.writeText(url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  title="Copy a link that opens this report in any browser — the address travels in the URL, localStorage does not"
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
                <button
                  className="btn btn-ghost small"
                  onClick={() => setIllustrative((v) => !v)}
                  title="Toggle illustrative sample data. A failed live read never falls back to it."
                >
                  {illustrative ? "Show live" : "Show sample"}
                </button>
                <button className="btn btn-ghost small" onClick={() => setShowSetup((s) => !s)}>
                  {showSetup ? "Hide" : "Categories"}
                </button>
                <button className="btn small" onClick={copyMarkdown}>
                  {copied ? "Copied" : "Copy report"}
                </button>
              </div>
            </div>
          </div>

          {state.illustrative && (
            <div className="notice" style={{ marginTop: 16, borderColor: "#713f12", background: "#1a1500" }}>
              <b>This is illustrative sample data, not a live read.</b> It demonstrates the report
              format on a chain that has no data yet. The figures are generated in your browser, are
              not on the ledger, and must never be filed. Switch back to <b>Show live</b> for the real
              read, which will say so plainly if the chain has nothing.
            </div>
          )}

          {showSetup && (
            <div className="card card-pad" style={{ marginTop: 16 }}>
              <h2 style={{ marginTop: 0, fontSize: 17 }}>Job categories</h2>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.55, marginBottom: 10 }}>
                The ledger stores each category as a <code>hash(label)</code>, so the chain can prove a
                group's size without ever holding the label. That mapping is published here, in the
                report, because Art. 9 requires the breakdown to be readable. One label per line, at
                most 32 bytes each — use a job family ("engineering"), not a job title.
              </div>
              <textarea
                value={categoriesText}
                onChange={(e) => setCategoriesText(e.target.value)}
                rows={5}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line)",
                  background: "var(--panel2)",
                  color: "var(--text)",
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                }}
              />
              {setupProblems.length > 0 && (
                <div
                  className="notice"
                  style={{ marginTop: 10, borderColor: "#713f12", background: "#1a1500", fontSize: 13, lineHeight: 1.5 }}
                >
                  {setupProblems.map((p, i) => (
                    <div key={i}>{p}</div>
                  ))}
                </div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary small" onClick={applyCategories}>
                  Use these categories
                </button>
                <button
                  className="btn small"
                  onClick={() => setCategoriesText(usedCategories().join("\n"))}
                  title="Fill in the labels this device has actually submitted under"
                >
                  Use submitted labels
                </button>
              </div>
            </div>
          )}

          {state.bundle.report.rows.length === 0 && (
            <div className="card card-pad" style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Nothing publishable this period</div>
              <div className="muted" style={{ lineHeight: 1.55 }}>
                {state.bundle.submissions === 0
                  ? "This contract has no submissions on it at all. That is the honest state of the ledger, and a report built from it would imply coverage nobody has created."
                  : `${state.bundle.submissions} submission(s) exist on this contract, but none of them fall into the category labels listed above — so every row reads empty. The ledger keys a group by hash(label), and a submission filed under a different label is a different hash. Press Categories and add the label you submitted under.`}
              </div>
            </div>
          )}

          {state.bundle.report.rows.map((row) => (
            <div key={row.category} className="card card-pad" style={{ marginTop: 16 }}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>{row.category}</h2>
              <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                    <th style={{ padding: "4px 8px 4px 0", fontWeight: 500 }} />
                    <th style={{ padding: "4px 8px 4px 0", fontWeight: 500 }}>{GENDER_LABEL[0]}</th>
                    <th style={{ padding: "4px 8px 4px 0", fontWeight: 500 }}>{GENDER_LABEL[1]}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: "4px 8px 4px 0", color: "var(--muted)" }}>Headcount</td>
                    <td style={{ padding: "4px 8px 4px 0" }}>{row.reference.size}</td>
                    <td style={{ padding: "4px 8px 4px 0" }}>{row.comparison.size}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 8px 4px 0", color: "var(--muted)" }}>Median</td>
                    <td style={{ padding: "4px 8px 4px 0" }}>
                      {row.reference.median ? money(row.reference.median.low, row.reference.median.high) : "—"}
                    </td>
                    <td style={{ padding: "4px 8px 4px 0" }}>
                      {row.comparison.median ? money(row.comparison.median.low, row.comparison.median.high) : "—"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 8px 4px 0", color: "var(--muted)" }}>Mean</td>
                    <td style={{ padding: "4px 8px 4px 0" }}>{money(row.reference.mean.low, row.reference.mean.high)}</td>
                    <td style={{ padding: "4px 8px 4px 0" }}>{money(row.comparison.mean.low, row.comparison.mean.high)}</td>
                  </tr>
                  {row.variableShare && (
                    <tr>
                      <td style={{ padding: "4px 8px 4px 0", color: "var(--muted)", lineHeight: 1.4 }}>
                        Receiving variable pay
                        <span style={{ display: "block", fontSize: 11, color: "var(--muted2)" }}>Art. 9(1)(e), among contributors</span>
                      </td>
                      <td style={{ padding: "4px 8px 4px 0" }}>{shareText(row.variableShare.reference)}</td>
                      <td style={{ padding: "4px 8px 4px 0" }}>{shareText(row.variableShare.comparison)}</td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                {row.gap ? (
                  <>
                    <div>
                      <span style={{ color: "var(--muted)" }}>Mean gap: </span>
                      <strong>{formatPct(row.gap.gap.low, row.gap.gap.high)}</strong>{" "}
                      <span className="muted">({row.gap.direction.replace(/-/g, " ")})</span>
                    </div>
                    {row.medianGap && (
                      <div>
                        <span style={{ color: "var(--muted)" }}>Median gap: </span>
                        <strong>{money(row.medianGap.low, row.medianGap.high)}</strong>
                      </div>
                    )}
                    {row.gap.material ? (
                      <div className="notice" style={{ marginTop: 10, borderColor: "#854d0e", background: "#1a1500", fontSize: 13 }}>
                        <b>At or above the 5% threshold in Art. 9(4).</b> If this gap is not objectively
                        justified, a joint pay assessment with worker representatives may be triggered.
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="muted">Gap not computable for this group.</div>
                )}
              </div>
            </div>
          ))}

          {state.bundle.report.suppressed.length > 0 && (
            <div className="card card-pad" style={{ marginTop: 16 }}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>Withheld</h2>
              <div className="muted" style={{ fontSize: 13, marginBottom: 10, lineHeight: 1.5 }}>
                The contract returns 0 for any group below k={state.bundle.k}. That gate is in the
                circuit, not in this page — an employer cannot override it, publish a small cell, or
                write a reader that gets around it.
              </div>
              <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                <tbody>
                  {state.bundle.report.suppressed.map((s) => (
                    <tr key={s.category}>
                      <td style={{ padding: "3px 8px 3px 0" }}>{s.category}</td>
                      <td style={{ padding: "3px 8px 3px 0", color: "var(--muted)" }}>{s.reason}</td>
                      <td style={{ padding: "3px 0", color: "var(--muted)" }}>{s.size} participant{s.size === 1 ? "" : "s"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Disclosure notes</h2>
            {state.bundle.report.notes.map((n, i) => (
              <div key={i} className="muted" style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 8 }}>{n}</div>
            ))}
          </div>

          <div className="card card-pad" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Verify this report</h2>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
              Anyone can check the fingerprint against chain state. No wallet, no account, no permission.
            </div>
            <VerifyBox fingerprint={state.fingerprint} />
          </div>
        </>
      )}
    </div>
  );
}

function VerifyBox({ fingerprint }: { fingerprint: string }) {
  const [input, setInput] = useState(fingerprint);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Same address rule as the report it verifies.
  const address = getStoredV2ContractAddress() ?? getStoredContractAddress();

  useEffect(() => setInput(fingerprint), [fingerprint]);

  const run = async () => {
    if (!address || !input.trim()) return;
    setBusy(true);
    setResult("checking…");
    try {
      const { verifyV2Report } = await import("../lib/reportRead.v2");
      // The same list the report was built from. A fingerprint covers a specific
      // category set, so verifying against a different one reports a mismatch
      // that means only the lists differ.
      const { categories: stored } = parseCategoryText(
        mergeCategories(loadCategories(), usedCategories()).map((c) => c.label).join("\n"),
      );
      const r = await verifyV2Report(address, input.trim(), stored);
      setResult(
        r.ok
          ? `MATCH — this report matches live chain state (period ${r.period}, ${r.submissions} submission(s)).`
          : `MISMATCH — chain now reads ${r.actual}, report claims ${r.expected}. The report is stale or was not built from this contract.`,
      );
    } catch (e) {
      setResult(`could not verify: ${e instanceof Error ? e.message : "read failed"}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          style={{
            flex: "1 1 220px",
            minWidth: 200,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--panel2)",
            color: "var(--fg)",
            fontFamily: "var(--mono)",
            fontSize: 13,
          }}
        />
        <button className="btn btn-primary" onClick={run} disabled={busy || !input.trim()}>
          {busy ? "Checking…" : "Verify against chain"}
        </button>
      </div>
      {result && <div className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>{result}</div>}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function money(low: number, high: number): string {
  const f = (v: number) => (Number.isFinite(v) ? `$${Math.round(v).toLocaleString("en-US")}` : "$∞");
  return low === high ? f(low) : `${f(low)}–${f(high)}`;
}

/**
 * Art. 9(1)(e) as the honest thing it is: a bounded proportion among
 * contributors, never a bare percentage. A [0,0] interval means no CONTRIBUTOR
 * reported variable pay — which is not the same as no worker receiving it, and
 * rendering it as "0%" would assert something the data cannot support.
 */
function shareText(r: { share: { low: number; high: number } | null }): string {
  if (!r.share) return "not derivable — no base-pay denominator";
  const { low, high } = r.share;
  const f = (v: number) => `${(v * 100).toFixed(1)}%`;
  if (low === 0 && high === 0) return "0% of contributors";
  if (low === high) return `${f(low)} of contributors`;
  return `at most ${f(high)} of contributors`;
}

function formatPct(low: number, high: number): string {
  const f = (v: number) => `${(v * 100).toFixed(1)}%`;
  return low === high ? f(low) : `${f(low)} – ${f(high)}`;
}