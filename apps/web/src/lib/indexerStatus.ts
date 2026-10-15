/**
 * Indexer availability, as something the UI can state rather than swallow.
 *
 * Why this exists. On 2026-10-09 `indexer.preprod.midnight.network` was
 * decommissioned and the Midnight indexer moved to Blockfrost, which
 * authenticates with a project token. Every live read in the app goes through
 * that endpoint, so overnight every read started failing — and the app did what
 * it was built to do: it stopped showing live data and displayed sample data
 * with a label.
 *
 * That behaviour was correct and it was not enough. "Sample dataset — not chain
 * data" tells a reader that the numbers are not from the chain. It does not tell
 * them whether nobody has run a reporting period yet, or the network moved, or
 * this deployment is misconfigured. Those are three different facts with three
 * different responses, and a compliance product that conflates them is hiding an
 * outage behind a plausible-looking page.
 *
 * So every indexer failure is classified into one of these, and the app says
 * which. The classification is deliberately based on the response, not on
 * assumptions about the host: the decommissioned endpoint answers 410 with a
 * migration link in the body, and Blockfrost answers 403 when the proxy has no
 * token configured.
 */

export type IndexerStatus =
  | { kind: "ok" }
  /**
   * The upstream endpoint is gone. `migrationUrl` is taken from the response
   * body, so the UI can link to whatever the operator is meant to read rather
   * than a URL we hardcoded and will forget to update.
   */
  | { kind: "decommissioned"; message: string; migrationUrl?: string }
  /** Reached Blockfrost but it refused the request: the proxy has no token. */
  | { kind: "unauthorised"; message: string }
  /** Nothing answered: DNS, TLS, timeout, or the app's proxy is down. */
  | { kind: "unreachable"; message: string }
  /** We reached an indexer but it does not understand the query. */
  | { kind: "incompatible"; message: string };

export type IndexerReport = {
  status: IndexerStatus;
  /** The URL that was probed, for the diagnostics panel. */
  url: string;
  /** True when the app can read live chain state right now. */
  live: boolean;
  /** One sentence for a banner. */
  headline: string;
  /** What the operator should do about it, when there is something. */
  action?: string;
};

/** Turn a probe response into a status. Pure, so it is testable. */
export function classifyIndexerResponse(status: number, body: string): IndexerStatus {
  if (status >= 200 && status < 300) return { kind: "ok" };

  // 410 with a migration note is the exact shape the decommissioned Midnight
  // endpoint returns, so read the link out of the body rather than guessing.
  if (status === 410) {
    let message = "the indexer endpoint has been decommissioned";
    let migrationUrl: string | undefined;
    try {
      const parsed = JSON.parse(body);
      const first = parsed?.errors?.[0];
      if (typeof first?.message === "string") message = first.message;
      if (typeof first?.extensions?.migrationGuide === "string") {
        migrationUrl = first.extensions.migrationGuide;
      }
    } catch {
      // A non-JSON 410 still means gone; the default message stands.
    }
    return { kind: "decommissioned", message, migrationUrl };
  }

  // Blockfrost without a token, or with a bad one.
  if (status === 401 || status === 403) {
    let message = "the indexer refused the request";
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.message === "string") message = parsed.message;
    } catch {
      /* keep the default */
    }
    return { kind: "unauthorised", message };
  }

  // A reachable host that does not serve this API. 404 here usually means the
  // proxy path or the API version is wrong rather than the network being down,
  // and that distinction changes who has to fix it.
  if (status === 404 || status === 405) {
    return {
      kind: "incompatible",
      message: `the endpoint answered ${status}; it is reachable but not serving the expected API`,
    };
  }

  return { kind: "unreachable", message: `the indexer answered ${status}` };
}

/** Render a status as the banner the app shows. */
export function describeIndexerStatus(status: IndexerStatus): IndexerReport["headline"] {
  switch (status.kind) {
    case "ok":
      return "chain reads are live";
    case "decommissioned":
      return `live reads are unavailable: ${status.message}`;
    case "unauthorised":
      return `live reads are unavailable: ${status.message}`;
    case "unreachable":
      return `live reads are unavailable: ${status.message}`;
    case "incompatible":
      return `live reads are unavailable: ${status.message}`;
  }
}

export function actionFor(status: IndexerStatus): string | undefined {
  switch (status.kind) {
    case "ok":
      return undefined;
    case "decommissioned":
      return (
        "The network moved its indexer. Point INDEXER_URL at the replacement and set " +
        "BLOCKFROST_PROJECT_ID as a Fly secret; the app's own proxy injects the token so it " +
        "never reaches the browser."
      );
    case "unauthorised":
      return (
        "The proxy reached the indexer but has no project token. Set BLOCKFROST_PROJECT_ID on " +
        "the web app (fly secrets set BLOCKFROST_PROJECT_ID=...) and redeploy."
      );
    case "unreachable":
      return "Check the app's `/indexer` proxy and that the upstream host is up.";
    case "incompatible":
      return "The API version or proxy path is wrong; check INDEXER_URL and the Caddyfile strip_prefix.";
  }
}

/**
 * Build the report from a raw probe.
 *
 * `live` is false for every non-ok status, which is what makes the landing page
 * state "not chain data" rather than quietly rendering sample figures as if a
 * reporting period had run.
 */
export function reportFrom(status: IndexerStatus, url: string): IndexerReport {
  return {
    status,
    url,
    live: status.kind === "ok",
    headline: describeIndexerStatus(status),
    action: actionFor(status),
  };
}
