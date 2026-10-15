/**
 * Preflight for a v2 deploy.
 *
 * A deploy touches four independent services — the wallet extension, the
 * indexer, the proof server, and the static file host serving the zk artefacts.
 * When one of them is wrong, midnight-js raises an Effect failure whose message
 * is the empty string, so the operator sees "deploy failed" and nothing else.
 *
 * This checks each prerequisite directly and reports which one failed and how.
 * The checks are deliberately cheap (HEAD/GET on static files, one health probe)
 * because the point is a clear answer in a second, not a thorough audit.
 *
 * The artefact check is the one that matters most in practice: the app bundles
 * the generated contract at build time and fetches keys at runtime, so a
 * recompile that moves one without the other produces exactly that empty-message
 * failure. `scripts/check-artifacts.mjs` catches it at build time; this catches it
 * when the deployed bundle is older than the artefacts it is being served.
 */

export type PreflightCheck = {
  name: string;
  ok: boolean;
  /** What was actually observed. */
  detail: string;
  /** What to do about it, when it failed. */
  fix?: string;
};

export type PreflightResult = {
  ok: boolean;
  checks: PreflightCheck[];
  /** Newline-joined summary of the failures, suitable for a toast. */
  summary: string;
};

/** Every circuit the v2 ledger exports, in the order the bundle expects them. */
export const V2_CIRCUITS = [
  "submit",
  "enroll",
  "nextEpoch",
  "getHistogram",
  "isPublishable",
  "readEpoch",
  "readK",
  "getGroupHistogram",
] as const;

async function head(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; note: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ctl.signal, cache: "no-store" });
    return { ok: res.ok, status: res.status, note: `${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, note: e instanceof Error ? e.message : "network error" };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verify every prerequisite for deploying v2 from the browser.
 *
 * Run before attempting the deploy so a failure names its cause. Never throws —
 * a failed check is data, not an exception.
 */
export async function preflightV2Deploy(opts: {
  /** Origin serving the app; artefacts are same-origin. */
  origin: string;
  /** True when a wallet is connected and exposing providers. */
  walletConnected: boolean;
  /** The issuer key the constructor will commit to, if already parsed. */
  issuerKeyOk: boolean;
}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  checks.push({
    name: "wallet",
    ok: opts.walletConnected,
    detail: opts.walletConnected ? "connected, providers available" : "no wallet connected",
    fix: "Open the Lace extension, switch to Preprod, and press Connect before deploying.",
  });

  checks.push({
    name: "issuer key",
    ok: opts.issuerKeyOk,
    detail: opts.issuerKeyOk ? "64 hex chars" : "missing or malformed",
    fix: "Paste 64 hex characters (32 bytes) and press Save. `openssl rand -hex 32` generates one.",
  });

  // The contract metadata the bundle was built with, versus what is served.
  const infoUrl = `${opts.origin}/zk/gotit/compiler/contract-info.json`;
  const info = await head(infoUrl);
  let servedCircuits: string[] | null = null;
  if (info.ok) {
    try {
      const body = await (await fetch(infoUrl, { cache: "no-store" })).json();
      servedCircuits = Array.isArray(body?.circuits) ? body.circuits.map((c: any) => c.name) : null;
    } catch {
      servedCircuits = null;
    }
  }

  checks.push({
    name: "zk artefacts served",
    ok: info.ok,
    detail: info.ok ? `contract-info.json reachable (${info.note})` : `cannot fetch ${infoUrl} (${info.note})`,
    fix: "The web app serves /zk/gotit itself. If this 404s, the deploy image is missing the artefacts — rebuild and redeploy the web app.",
  });

  if (servedCircuits) {
    // A served artefact set the bundled contract does not know about is the
    // signature of a stale bundle, which fails the deploy with an empty message.
    const missing = V2_CIRCUITS.filter((c) => !servedCircuits!.includes(c));
    const extra = servedCircuits.filter((c) => !(V2_CIRCUITS as readonly string[]).includes(c));
    checks.push({
      name: "artefacts match this bundle",
      ok: missing.length === 0 && extra.length === 0,
      detail:
        missing.length === 0 && extra.length === 0
          ? `${servedCircuits.length} circuits, all expected`
          : `served: [${servedCircuits.join(", ")}]` +
            (missing.length ? ` — missing ${missing.join(", ")}` : "") +
            (extra.length ? ` — unexpected ${extra.join(", ")}` : ""),
      fix:
        "The bundle was built against a different contract revision than the artefacts being " +
        "served. This is the mismatch that fails with an empty error message. Rebuild the web " +
        "app so it matches: pnpm --filter @gotit/contract build && pnpm --filter @gotit/contract sync:zk " +
        "&& pnpm --filter @gotit/web build, then redeploy.",
    });
  }

  // One prover key and one zkir, so a routing problem is visible without
  // fetching the whole set.
  const proverKey = `${opts.origin}/zk/gotit/keys/submit.prover`;
  const zkir = `${opts.origin}/zk/gotit/zkir/submit.zkir`;
  const [pk, zk] = await Promise.all([head(proverKey), head(zkir)]);
  checks.push({
    name: "prover key + zkir",
    ok: pk.ok && zk.ok,
    detail: `keys/submit.prover ${pk.note}, zkir/submit.zkir ${zk.note}`,
    fix: "Same cause as above: the artefacts are not being served. Check the deploy image contains public/zk.",
  });

  // The proof server, through the same same-origin proxy the deploy will use.
  const prover = await head(`${opts.origin}/proof-server/version`, 10_000);
  checks.push({
    name: "proof server",
    ok: prover.ok,
    detail: prover.ok ? "reachable through /proof-server" : `unreachable (${prover.note})`,
    fix:
      "The deploy proves the constructor, so the prover must be up. Start it with " +
      "`fly deploy -c fly.prover.toml`, or run a local proof server on :6300 and use the local dev flow.",
  });

  const failures = checks.filter((c) => !c.ok);
  return {
    ok: failures.length === 0,
    checks,
    summary: failures.length === 0 ? "all checks passed" : failures.map((f) => f.name).join(", "),
  };
}

/** Render a preflight result as plain text for the diagnostics panel. */
export function describePreflight(r: PreflightResult): string {
  return r.checks
    .map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}${c.ok || !c.fix ? "" : `\n    → ${c.fix}`}`)
    .join("\n");
}
