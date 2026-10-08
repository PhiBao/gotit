/**
 * Tests for the gated read path — the thing the design claims and, previously,
 * did not do.
 *
 * The audit that preceded these found every "read through the contract's gated
 * circuit" function defined and never called: the report read raw ledger state,
 * which bypasses `getHistogram`'s anonymity gate entirely, while the contract,
 * the deck, the SPEC and the app's own docstrings all said the gate was
 * enforced in-circuit. 40 web tests passed throughout.
 *
 * These tests hold both halves down:
 *
 *   1. `gatedLogic.ts` — the cross-check rule, pure, so it can be tested without
 *      a chain. If raw state calls a group publishable, the gated read must
 *      agree, or the report throws.
 *   2. The gate's own semantics, modelled exactly as the circuit implements them.
 */
import { describe, it, expect } from "vitest";
import { BUCKET_COUNT } from "@gotit/shared";
import { GENDER, COMPONENT, DEFAULT_K } from "@gotit/shared/paygap";
import {
  crossCheckGroup,
  shouldCrossCheck,
  GatedMismatchError,
  type GatedCrossCheckInput,
} from "./gatedLogic";

// ---- the gate, modelled exactly as gotit.compact implements it --------------

/**
 * Mirrors `getHistogram` in packages/contract/src/gotit.compact:
 * `groupCount.lookup(gKey) < kThreshold` returns 0. Written out here rather
 * than calling the contract so the semantics are pinned in one readable place;
 * the contract's own 21 tests cover the real thing.
 */
function gatedRead(groupTotal: number, k: number, bucketCounts: number[]): number[] {
  if (groupTotal < k) return new Array(BUCKET_COUNT).fill(0);
  return [...bucketCounts];
}

describe("the gate's semantics, modelled as the circuit enforces them", () => {
  it("returns zero for a group below k even though raw state holds the count", () => {
    // The exact property the contract exists to provide. If the report ever
    // reads raw state for this group, the pay bands of a 3-person category are
    // published — the failure the whole design is against.
    const cells = [0, 0, 0, 0, 0, 0, 3, 0, 0, 0]; // 3 people in bucket 6
    expect(gatedRead(3, DEFAULT_K, cells)).toEqual(new Array(BUCKET_COUNT).fill(0));
  });

  it("returns the real counts once the group clears k", () => {
    const cells = [0, 0, 0, 0, 0, 0, 6, 2, 0, 0];
    const gated = gatedRead(8, DEFAULT_K, cells);
    expect(gated[6]).toBe(6);
    expect(gated[7]).toBe(2);
    expect(gated.reduce((a, b) => a + b, 0)).toBe(8);
  });

  it("evaluates the threshold per group, not globally", () => {
    // A large team in one category must not lift a small group in another above
    // the line. groupCount is keyed on (category, gender, component) precisely
    // so a global counter cannot do this.
    expect(gatedRead(40, DEFAULT_K, [0, 0, 0, 0, 0, 0, 40, 0, 0, 0])[6]).toBe(40);
    expect(gatedRead(2, DEFAULT_K, [0, 0, 2, 0, 0, 0, 0, 0, 0, 0])).toEqual(
      new Array(BUCKET_COUNT).fill(0),
    );
  });

  it("gates each component independently", () => {
    expect(gatedRead(9, DEFAULT_K, [0, 0, 0, 9, 0, 0, 0, 0, 0, 0])[3]).toBe(9);
    expect(gatedRead(2, DEFAULT_K, [0, 0, 0, 0, 0, 2, 0, 0, 0, 0])).toEqual(
      new Array(BUCKET_COUNT).fill(0),
    );
  });

  it("k=1 is rejected at deploy, so a group of one is never readable", () => {
    // The constructor asserts k >= 2; see gotit.compact and its test.
    expect(DEFAULT_K).toBeGreaterThanOrEqual(2);
    expect(gatedRead(1, 2, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual(new Array(BUCKET_COUNT).fill(0));
  });
});

// ---- the cross-check that makes the claim real ------------------------------

const input = (over: Partial<GatedCrossCheckInput> = {}): GatedCrossCheckInput => ({
  gated: [0, 0, 0, 0, 0, 0, 7, 2, 0, 0],
  raw: [0, 0, 0, 0, 0, 0, 7, 2, 0, 0],
  k: DEFAULT_K,
  label: "engineering",
  gender: GENDER.FEMALE,
  component: COMPONENT.BASE,
  ...over,
});

describe("shouldCrossCheck", () => {
  it("checks a group raw state calls publishable", () => {
    expect(shouldCrossCheck([0, 0, 0, 0, 0, 0, 7, 0, 0, 0], 5)).toBe(true);
  });

  it("skips a group below k, where gate and raw state disagree by design", () => {
    // There the gate returns 0 and raw state returns the count, so asserting
    // equality would fail on correct behaviour.
    expect(shouldCrossCheck([0, 0, 0, 0, 0, 0, 3, 0, 0, 0], 5)).toBe(false);
  });

  it("skips an empty group", () => {
    expect(shouldCrossCheck(new Array(BUCKET_COUNT).fill(0), 5)).toBe(false);
  });
});

describe("crossCheckGroup", () => {
  it("returns the gated counts when the two agree", () => {
    const gated = [0, 0, 0, 0, 0, 0, 7, 2, 0, 0];
    expect(crossCheckGroup(input({ gated }))).toEqual(gated);
  });

  it("throws when a publishable group's gated read disagrees with raw state", () => {
    // The regression this guards: the app reading raw state as a published
    // figure. The gate would return 0 or a different total, and without this
    // check the report would publish the raw number silently.
    expect(() => crossCheckGroup(input({ gated: new Array(BUCKET_COUNT).fill(0) }))).toThrow(
      GatedMismatchError,
    );
  });

  it("names the group and both totals so the failure is diagnosable", () => {
    try {
      crossCheckGroup(input({ gated: [99, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("engineering");
      expect(msg).toContain("gender 0");
      expect(msg).toContain("component 0");
      expect(msg).toContain("returned 99");
      expect(msg).toContain("raw ledger state holds 9");
      expect(msg).toContain("Refusing to publish");
    }
  });

  it("returns the gated zeros for a below-k group without cross-checking", () => {
    // A suppressed group's gate read is 0 and its raw read is 3 (below k=5).
    // Correct behaviour, so no error — and the published counts are the gated
    // ones, so a small category's pay bands never reach the report either way.
    const zeros = new Array(BUCKET_COUNT).fill(0);
    expect(crossCheckGroup(input({ gated: zeros, raw: [0, 0, 0, 0, 0, 0, 3, 0, 0, 0] }))).toEqual(zeros);
  });

  it("does not mutate its input", () => {
    const gated = [0, 0, 0, 0, 0, 0, 7, 2, 0, 0];
    const snapshot = [...gated];
    crossCheckGroup(input({ gated }));
    expect(gated).toEqual(snapshot);
  });
});
