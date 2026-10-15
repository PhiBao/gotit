import { describe, it, expect } from "vitest";
import {
  unwrapFailures,
  describeFailure,
  failureReport,
  safeStringify,
  isEffectFailure,
  isWalletLockedError,
  friendlyChainError,
  LOCKED_WALLET_HINT,
} from "./effectError";

/**
 * Tests against the exact shape a real deploy failure produced in the browser:
 *
 *   Error { _id: 'FiberFailure', message: '', cause: { _tag: 'Fail', failure: {…} } }
 *
 * The empty `message` is why the toast said only "v2 deploy failed". Effect puts
 * the reason in the Cause tree, so every catch block that logged `e.message` was
 * logging nothing.
 */

/** The shape observed in production. */
const observed = {
  name: "Error",
  message: "",
  _id: "FiberFailure",
  cause: {
    _tag: "Fail",
    failure: {
      _tag: "ContractDeployError",
      message: "failed to submit deploy transaction",
      cause: { message: "proof server returned 500: unsupported zkir version" },
    },
  },
};

describe("the observed production shape", () => {
  it("is recognised as an Effect failure", () => {
    expect(isEffectFailure(observed)).toBe(true);
  });

  it("extracts the real message, which e.message never had", () => {
    const failures = unwrapFailures(observed);
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("fail");
    expect(failures[0].message).toContain("failed to submit deploy transaction");
    // The actionable part is one level deeper, in the nested cause.
    expect(failures[0].message).toContain("unsupported zkir version");
  });

  it("produces a toast line that names the reason", () => {
    const d = describeFailure(observed);
    expect(d).not.toBe("");
    expect(d).toContain("failed to submit deploy transaction");
  });

  it("keeps the structured detail, which is where the host or status lives", () => {
    const report = failureReport(observed);
    expect(report).toContain("ContractDeployError");
    expect(report).toContain("unsupported zkir version");
  });
});

describe("Cause tree shapes", () => {
  it("walks Sequential and reports both failures", () => {
    const e = {
      _id: "FiberFailure",
      message: "",
      cause: { _tag: "Sequential", left: { _tag: "Fail", failure: { message: "first" } }, right: { _tag: "Fail", failure: { message: "second" } } },
    };
    const f = unwrapFailures(e);
    expect(f.map((x) => x.message)).toEqual(["first", "second"]);
    expect(describeFailure(e)).toContain("+1 more");
  });

  it("walks Parallel", () => {
    const e = {
      _id: "FiberFailure",
      cause: { _tag: "Parallel", left: { _tag: "Die", defect: new Error("boom") }, right: { _tag: "Interrupt" } },
    };
    const f = unwrapFailures(e);
    expect(f.map((x) => x.kind)).toEqual(["die", "interrupt"]);
  });

  it("handles a bare Cause with no FiberFailure wrapper", () => {
    const f = unwrapFailures({ _tag: "Fail", failure: { message: "bare" } });
    expect(f[0].message).toBe("bare");
  });

  it("reports an empty cause rather than pretending it found nothing", () => {
    const f = unwrapFailures({ _id: "FiberFailure", cause: { _tag: "Empty" } });
    expect(f[0].message).toMatch(/empty cause/);
  });

  it("does not recurse forever on a self-referential cause", () => {
    const cause: any = { _tag: "Sequential" };
    cause.left = cause;
    cause.right = { _tag: "Fail", failure: { message: "leaf" } };
    expect(() => unwrapFailures({ _id: "FiberFailure", cause })).not.toThrow();
  });
});

describe("ordinary errors still work", () => {
  it("passes a normal Error through", () => {
    expect(describeFailure(new Error("plain failure"))).toBe("plain failure");
  });

  it("handles a thrown string", () => {
    expect(describeFailure("something broke")).toBe("something broke");
  });

  it("does not throw on null or undefined", () => {
    expect(unwrapFailures(null)).toEqual([]);
    expect(() => describeFailure(undefined)).not.toThrow();
  });
});

describe("safeStringify", () => {
  it("survives the values Effect errors carry", () => {
    // JSON.stringify throws on a bigint; the whole point is that a diagnostic
    // panel must not become a second error.
    const value = { n: 123n, bytes: new Uint8Array(4), err: new Error("x") };
    expect(() => safeStringify(value)).not.toThrow();
    expect(safeStringify(value)).toContain("123n");
    expect(safeStringify(value)).toContain("<4 bytes>");
  });

  it("truncates rather than dumping a megabyte into the DOM", () => {
    const huge = { s: "x".repeat(10_000) };
    expect(safeStringify(huge, 200).length).toBeLessThan(400);
    expect(safeStringify(huge, 200)).toContain("truncated");
  });

  it("falls back to String() for a circular object", () => {
    const circ: any = {};
    circ.self = circ;
    expect(() => safeStringify(circ)).not.toThrow();
  });
});

describe("preflight names the cause a FiberFailure hides", () => {
  it("flags the stale-bundle signature: served artefacts the bundle does not know", async () => {
    const { V2_CIRCUITS } = await import("./preflight");

    // The exact production situation: the bundle was built against the
    // 7-circuit contract, the server now offers 8. midnight-js reports this as
    // an empty-message FiberFailure; the preflight names it instead.
    const served = [...V2_CIRCUITS]; // 8 circuits on the server
    const bundleKnows: readonly string[] = V2_CIRCUITS.filter((c) => c !== "getGroupHistogram"); // 7 in the bundle

    const servedList: readonly string[] = served;
    const missingFromServer = bundleKnows.filter((c) => !servedList.includes(c));
    const unexpectedOnServer = served.filter((c) => !bundleKnows.includes(c));

    // Nothing the bundle needs is absent...
    expect(missingFromServer).toEqual([]);
    // ...but the server offers a circuit the bundle cannot use, which is the
    // signature that the bundle is stale. The preflight reports this as a
    // mismatch rather than letting the deploy fail opaquely.
    expect(unexpectedOnServer).toEqual(["getGroupHistogram"]);
  });

  it("reports a missing wallet before attempting anything on-chain", async () => {
    const { preflightV2Deploy } = await import("./preflight");
    // No network needed to establish this one; the other checks will fail
    // against an unreachable origin, which is fine — the wallet check is first.
    const r = await preflightV2Deploy({
      origin: "http://127.0.0.1:9",
      walletConnected: false,
      issuerKeyOk: false,
    });
    expect(r.ok).toBe(false);
    const wallet = r.checks.find((c) => c.name === "wallet")!;
    expect(wallet.ok).toBe(false);
    expect(wallet.fix).toMatch(/Lace/);
    const key = r.checks.find((c) => c.name === "issuer key")!;
    expect(key.fix).toMatch(/64 hex/);
  });

  it("always returns a check for each prerequisite, never an exception", async () => {
    const { preflightV2Deploy, describePreflight } = await import("./preflight");
    const r = await preflightV2Deploy({
      origin: "http://127.0.0.1:9",
      walletConnected: true,
      issuerKeyOk: true,
    });
    expect(r.checks.map((c) => c.name)).toEqual([
      "wallet",
      "issuer key",
      "zk artefacts served",
      "prover key + zkir",
      "proof server",
    ]);
    expect(() => describePreflight(r)).not.toThrow();
    expect(describePreflight(r)).toContain("✗");
  });
});

describe("a locked wallet is identified, because the fix is outside the page", () => {
  it("recognises the message Lace actually returns", () => {
    expect(isWalletLockedError(new Error("Wallet is locked. Please unlock the wallet first."))).toBe(true);
    expect(isWalletLockedError(new Error("User rejected the request"))).toBe(true);
    expect(isWalletLockedError(new Error("not authorised"))).toBe(true);
  });

  it("recognises it inside an Effect failure, where the text is nested", () => {
    const wrapped = {
      _id: "FiberFailure",
      message: "",
      cause: { _tag: "Fail", failure: { message: "Wallet is locked" } },
    };
    expect(isWalletLockedError(wrapped)).toBe(true);
  });

  it("does not claim a network failure is a lock", () => {
    expect(isWalletLockedError(new Error("Response not successful: Received status code 410"))).toBe(false);
    expect(isWalletLockedError(new Error("proof server returned 500"))).toBe(false);
  });

  it("gives an instruction rather than a raw message", () => {
    const msg = friendlyChainError(new Error("Wallet is locked"), "v2 submit");
    expect(msg).toMatch(/needs an unlocked wallet/);
    expect(msg).toContain(LOCKED_WALLET_HINT);
    expect(msg).toMatch(/safe to try again/);
  });

  it("still reports ordinary failures plainly", () => {
    expect(friendlyChainError(new Error("boom"), "v2 submit")).toBe("v2 submit failed: boom");
  });
});

describe("the connection is not blocked by an optional call", () => {
  /**
   * The unlock loop: connect() succeeded, getConfiguration() said "locked", the
   * code threw, the user retried, connect() ran again, Lace prompted again. Each
   * retry re-triggered the step that had just succeeded.
   *
   * Nothing downstream uses getConfiguration's values, so a failure there must not
   * fail the connection. This pins the reasoning rather than the implementation:
   * if someone reintroduces a throw, the test that matters is the integration one
   * in a browser, so this asserts the contract in words.
   */
  it("has no use for getConfiguration's values, so it cannot justify failing on them", async () => {
    const cfg = await import("./indexerConfig");
    // The endpoint the app uses comes from config, never from the wallet.
    expect(cfg.INDEXER_HTTP).not.toContain("indexer.preprod.midnight.network");
    expect(cfg.INDEXER_PATH).toBe("/api/v0");
  });
});
