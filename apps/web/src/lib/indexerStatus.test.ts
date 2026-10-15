import { describe, it, expect } from "vitest";
import {
  classifyIndexerResponse,
  describeIndexerStatus,
  actionFor,
  reportFrom,
} from "./indexerStatus";

/**
 * Tests built from real responses captured on 2026-10-15, when the Midnight
 * indexer was decommissioned and moved to Blockfrost. The bodies are verbatim.
 *
 * The distinction these tests protect is the one that matters: "the chain has no
 * data yet" and "we cannot reach the chain" are different facts, and a
 * compliance product that shows the same empty state for both is hiding an
 * outage behind a plausible page.
 */

/** The exact body the decommissioned endpoint returned. */
const DECOMMISSIONED_BODY = JSON.stringify({
  errors: [
    {
      message:
        "indexer.preprod.midnight.network was decommissioned on 2026-10-09. The Midnight " +
        "indexer is now provided by Blockfrost. Migration guide: " +
        "https://docs.midnight.network/guides/networks-and-environments#blockfrost-the-mainnet-indexer-and-rpc-provider",
      extensions: {
        code: "ENDPOINT_DECOMMISSIONED",
        migrationGuide:
          "https://docs.midnight.network/guides/networks-and-environments#blockfrost-the-mainnet-indexer-and-rpc-provider",
      },
    },
  ],
  data: null,
});

/** The exact body Blockfrost returned without a token. */
const MISSING_TOKEN_BODY = JSON.stringify({
  error: "Forbidden",
  message: "Missing project token. Please include project_id in your request.",
  status_code: 403,
});

const BAD_TOKEN_BODY = JSON.stringify({
  error: "Forbidden",
  message: "Invalid project token.",
  status_code: 403,
});

describe("the decommissioned Midnight endpoint", () => {
  it("is classified as decommissioned, not as unreachable", () => {
    const s = classifyIndexerResponse(410, DECOMMISSIONED_BODY);
    expect(s.kind).toBe("decommissioned");
  });

  it("carries the migration link out of the response body", () => {
    // Taken from the response rather than hardcoded, so the UI points at
    // whatever the operator is meant to read rather than a URL we guessed.
    const s = classifyIndexerResponse(410, DECOMMISSIONED_BODY);
    expect(s.kind === "decommissioned" && s.migrationUrl).toContain("docs.midnight.network");
  });

  it("reports it as not live, so the page never claims chain data", () => {
    const r = reportFrom(classifyIndexerResponse(410, DECOMMISSIONED_BODY), "https://x/indexer");
    expect(r.live).toBe(false);
    expect(r.headline).toMatch(/decommissioned/);
    expect(r.action).toMatch(/BLOCKFROST_PROJECT_ID/);
  });

  it("survives a 410 with a non-JSON body", () => {
    const s = classifyIndexerResponse(410, "<html>gone</html>");
    expect(s.kind).toBe("decommissioned");
    expect(describeIndexerStatus(s)).toMatch(/decommissioned/);
  });
});

describe("Blockfrost without credentials", () => {
  it("is classified as unauthorised, not as an empty chain", () => {
    const s = classifyIndexerResponse(403, MISSING_TOKEN_BODY);
    expect(s.kind).toBe("unauthorised");
    expect(s.kind === "unauthorised" && s.message).toMatch(/Missing project token/);
  });

  it("tells the operator to set the secret", () => {
    const r = reportFrom(classifyIndexerResponse(403, MISSING_TOKEN_BODY), "https://x/indexer");
    expect(r.live).toBe(false);
    expect(r.action).toMatch(/fly secrets set BLOCKFROST_PROJECT_ID/);
  });

  it("also catches an invalid token, which is a different fix from a missing one", () => {
    const s = classifyIndexerResponse(403, BAD_TOKEN_BODY);
    expect(s.kind).toBe("unauthorised");
    expect(s.kind === "unauthorised" && s.message).toMatch(/Invalid project token/);
  });
});

describe("other failures are distinguished from each other", () => {
  it("treats 404 as incompatible rather than down", () => {
    // A reachable host not serving this API is a routing or version problem,
    // which is someone else's fix than a network outage.
    const s = classifyIndexerResponse(404, "");
    expect(s.kind).toBe("incompatible");
    expect(actionFor(s)).toMatch(/strip_prefix|API version/);
  });

  it("treats 5xx as unreachable", () => {
    expect(classifyIndexerResponse(502, "").kind).toBe("unreachable");
    expect(classifyIndexerResponse(503, "").kind).toBe("unreachable");
  });

  it("treats 200 as ok", () => {
    expect(classifyIndexerResponse(200, "{}").kind).toBe("ok");
    expect(classifyIndexerResponse(204, "").kind).toBe("ok");
  });
});

describe("the report never claims live without a 2xx", () => {
  it("is not live for any failure status", () => {
    for (const [code, body] of [
      [410, DECOMMISSIONED_BODY],
      [403, MISSING_TOKEN_BODY],
      [404, ""],
      [500, ""],
      [0, ""],
    ] as Array<[number, string]>) {
      const r = reportFrom(classifyIndexerResponse(code, body), "https://x/indexer");
      expect(r.live).toBe(false);
      expect(r.headline).toMatch(/unavailable|decommissioned/);
    }
  });

  it("is live only for a 2xx", () => {
    const r = reportFrom(classifyIndexerResponse(200, "{}"), "https://x/indexer");
    expect(r.live).toBe(true);
    expect(r.action).toBeUndefined();
  });
});
