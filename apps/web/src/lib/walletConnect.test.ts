import { describe, it, expect, vi } from "vitest";
import {
  connectWithProgress,
  findConnectors,
  hasAnyConnector,
  phaseLabel,
  needsUserAction,
  ConnectError,
  type ConnectionPhase,
} from "./walletConnect";

/**
 * The bug: `connect()` on a LOCKED Lace extension never settles. The promise
 * neither resolves nor rejects, because the extension has an approval popup it
 * cannot show until it is unlocked. The old code awaited it forever, so the
 * button did nothing and said nothing.
 *
 * These tests use a fake clock and a connector that never settles, which is the
 * only way to test "the wallet is ignoring us" without waiting a minute.
 */

/** A wallet that answers. */
const answering = (result = { apiVersion: "4.0.1" }) => ({
  apiVersion: "4.0.1",
  connect: async () => result,
});

/** A wallet that never settles — the locked-extension case. */
const silent = () => ({ apiVersion: "4.0.1", connect: () => new Promise(() => {}) });

/** A wallet that refuses. */
const refusing = () => ({
  apiVersion: "4.0.1",
  connect: async () => {
    throw new Error("User rejected the request");
  },
});

function withMidnight<T>(value: unknown, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const prev = g.window;
  g.window = { ...(prev ?? {}), midnight: value };
  return fn().finally(() => {
    g.window = prev;
  });
}

describe("finding a connector", () => {
  it("finds a v4 connector with connect()", () => {
    expect(findConnectors({ a: { apiVersion: "4.0.1", connect: () => {} } })).toHaveLength(1);
  });

  it("finds a legacy connector with enable()", () => {
    expect(findConnectors({ a: { enable: () => {} } })).toHaveLength(1);
  });

  it("ignores objects that are not connectors", () => {
    expect(findConnectors({ a: { apiVersion: "4.0.1" }, b: "nope", c: null })).toHaveLength(0);
    expect(hasAnyConnector({ a: { apiVersion: "4.0.1" } })).toBe(false);
  });

  it("handles a missing window.midnight without throwing", () => {
    expect(findConnectors(undefined)).toEqual([]);
    expect(findConnectors(null)).toEqual([]);
  });
});

describe("a wallet that answers", () => {
  it("connects and reports success", async () => {
    const phases: ConnectionPhase[] = [];
    const result = await withMidnight({ w: answering() }, () =>
      connectWithProgress({ networkId: "preprod", onPhase: (p) => phases.push(p) }),
    );
    expect(result).toEqual({ apiVersion: "4.0.1" });
    expect(phases.at(-1)?.kind).toBe("connected");
  });
});

describe("a wallet that does not answer — the locked extension", () => {
  it("escalates to needs-attention rather than hanging silently", async () => {
    vi.useFakeTimers();
    try {
      const phases: ConnectionPhase[] = [];
      const p = withMidnight({ w: silent() }, () =>
        connectWithProgress({
          networkId: "preprod",
          onPhase: (q) => phases.push(q),
          tickMs: 100,
          attentionAfterMs: 500,
          giveUpAfterMs: 60_000,
        }),
      );
      // Attach the rejection handler before advancing, so the eventual timeout
      // does not surface as an unhandled rejection mid-test.
      const guarded = p.catch((e) => e as ConnectError);
      await vi.advanceTimersByTimeAsync(1200);
      expect(phases.some((x) => x.kind === "requesting")).toBe(true);
      const attention = phases.find((x) => x.kind === "needs-attention");
      expect(attention).toBeDefined();
      expect(attention && "detail" in attention && attention.detail).toMatch(/unlock/i);
      await vi.advanceTimersByTimeAsync(60_000);
      const err = (await guarded) as ConnectError;
      expect(err.phase.kind).toBe("error");
      expect(err.phase.kind === "error" && err.phase.hint).toMatch(/unlock/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with an actionable message rather than waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const p = withMidnight({ w: silent() }, () =>
        connectWithProgress({ networkId: "preprod", tickMs: 50, giveUpAfterMs: 1_000 }),
      );
      const guarded = p.catch((e) => e as ConnectError);
      await vi.advanceTimersByTimeAsync(1_500);
      const err = (await guarded) as ConnectError;
      expect(err).toBeInstanceOf(ConnectError);
      expect(err.message).toMatch(/did not respond/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep ticking after the wallet answers", async () => {
    vi.useFakeTimers();
    try {
      const phases: ConnectionPhase[] = [];
      const p = withMidnight({ w: answering() }, () =>
        connectWithProgress({
          networkId: "preprod",
          onPhase: (q) => phases.push(q),
          tickMs: 100,
          attentionAfterMs: 200,
        }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await p;
      const afterConnect = phases.filter((q) => q.kind === "needs-attention");
      expect(afterConnect).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("no wallet installed", () => {
  it("says so immediately, and distinguishes it from an unresponsive wallet", async () => {
    const phases: ConnectionPhase[] = [];
    await expect(
      withMidnight(undefined, () =>
        connectWithProgress({ networkId: "preprod", onPhase: (p) => phases.push(p) }),
      ),
    ).rejects.toBeInstanceOf(ConnectError);
    expect(phases.at(-1)?.kind).toBe("no-wallet");
    expect(needsUserAction(phases.at(-1)!)).toBe(true);
  });
});

describe("the user declines", () => {
  it("reports a refusal as a refusal, not as a failure", async () => {
    const phases: ConnectionPhase[] = [];
    await expect(
      withMidnight({ w: refusing() }, () =>
        connectWithProgress({ networkId: "preprod", onPhase: (p) => phases.push(p) }),
      ),
    ).rejects.toBeInstanceOf(ConnectError);
    expect(phases.at(-1)?.kind).toBe("rejected");
    expect(phaseLabel(phases.at(-1)!)).toMatch(/declined/i);
  });
});

describe("legacy enable() connectors", () => {
  it("enables then connects", async () => {
    const connector = {
      apiVersion: "3.0.0",
      enable: async () => ({ apiVersion: "3.0.0", connect: async () => ({ ok: true }) }),
    };
    const result = await withMidnight({ old: connector }, () =>
      connectWithProgress({ networkId: "preprod" }),
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("phase helpers", () => {
  it("labels every phase", () => {
    const kinds: ConnectionPhase["kind"][] = [
      "detecting", "no-wallet", "requesting", "needs-attention", "connected", "rejected", "error",
    ];
    for (const kind of kinds) {
      const p = { kind, detail: "x" } as ConnectionPhase;
      expect(phaseLabel(p)).toBeTruthy();
    }
  });

  it("marks only the phases that need the user", () => {
    expect(needsUserAction({ kind: "connected", detail: "" })).toBe(false);
    expect(needsUserAction({ kind: "requesting", detail: "", waitedMs: 0 })).toBe(false);
    expect(needsUserAction({ kind: "needs-attention", detail: "", waitedMs: 9000 })).toBe(true);
  });
});
