/**
 * Where the indexer lives. ONE place, because the network has moved twice.
 *
 *   1. `blockfrost.lw.iog.io/midnight-preprod`       -> 410, proxy retired (Sep 2026)
 *   2. `indexer.preprod.midnight.network/api/v4`     -> 410, decommissioned 2026-10-09
 *   3. `midnight-preprod.blockfrost.io/api/v0`       -> current, needs a project token
 *
 * The host is not in this file. The browser always talks to the app's own
 * `/indexer` prefix and Caddy proxies onward, which means:
 *
 *   - the Blockfrost token is injected server-side and never enters the bundle
 *     or anyone's devtools. The migration guide is explicit that a token in a
 *     browser URL is visible to whoever loads the page and spends your quota.
 *   - a host change is an environment variable, not a rebuild.
 *
 * The API PATH does have to be right in the browser, because Caddy only strips
 * the `/indexer` prefix and passes the rest through. So it is a build arg, and it
 * is the only thing to change when moving between a Midnight-hosted endpoint
 * (`/api/v4/graphql`, used by `preview`, which needs no token) and Blockfrost
 * (`/api/v0`, used by `preprod` and `mainnet`).
 *
 * Both are the same indexer API — the migration guide states Blockfrost "runs
 * the same indexer API that the Midnight-hosted endpoints served, so a DApp
 * moves to it by changing its endpoint URLs and adding a token, not by changing
 * code" — so this path is genuinely the only difference.
 */

const env = (import.meta as any).env ?? {};

/**
 * Which Midnight network this build targets.
 *
 * `preprod` and `mainnet` are served by Blockfrost and need a project token.
 * `preview` is Midnight-hosted and needs NO token, which makes it the only
 * network a fresh deployment can reach with no account or credential — and the
 * reason it is worth supporting explicitly rather than hardcoding `preprod`.
 *
 * The network ID also goes to midnight-js via `setNetworkId`, and it must match
 * the indexer: a `preprod` network ID with a `preview` indexer fails in the
 * address normalisation rather than at connect time, which is a confusing way to
 * find out.
 */
export const NETWORK_ID: string = env.VITE_MIDNIGHT_NETWORK || "preprod";

/** Human-readable note about credentials, for the diagnostics panel. */
export function networkCredentialsNote(): string {
  return NETWORK_ID === "preview"
    ? "Preview is Midnight-hosted and needs no indexer token."
    : `${NETWORK_ID} is served by Blockfrost and needs BLOCKFROST_PROJECT_ID set on the proxy.`;
}

/** Upstream API path for the configured indexer. `/api/v0` is Blockfrost. */
export const INDEXER_PATH: string = env.VITE_INDEXER_PATH || "/api/v0";

/** WebSocket path. Blockfrost uses `/api/v0/ws`; Midnight-hosted `/api/v4/graphql/ws`. */
export const INDEXER_WS_PATH: string = env.VITE_INDEXER_WS_PATH || "/api/v0/ws";

function origin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

/**
 * Same-origin indexer endpoints. The token is added by the proxy, not here.
 *
 * Both go through `/indexer` so there is exactly one place a credential can be
 * attached, and it is not the client.
 */
export const INDEXER_HTTP = `${origin()}/indexer${INDEXER_PATH}`;
export const INDEXER_WS = `${origin().replace(/^http/, "ws")}/indexer${INDEXER_WS_PATH}`;

/** Which upstream this build expects, for the diagnostics panel. */
export function indexerDescription(): string {
  const flavour =
    INDEXER_PATH.startsWith("/api/v0") && !INDEXER_PATH.startsWith("/api/v0/graphql")
      ? "Blockfrost (needs a project token, injected by the proxy)"
      : "Midnight-hosted (no token)";
  return `${INDEXER_PATH} — ${flavour}`;
}
