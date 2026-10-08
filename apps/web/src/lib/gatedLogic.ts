/**
 * The gated-cross-check rule, as a pure function.
 *
 * Extracted from `reportRead.v2.ts` because this is the invariant that makes the
 * disclosure-control claim true rather than aspirational, and an invariant that
 * important should be testable without a chain, a prover, or an indexer.
 *
 * The rule: for every group that RAW LEDGER STATE says clears the anonymity
 * threshold, the contract's `getHistogram` circuit must return the same total.
 * If it does not, something is reading raw state as a published figure — which
 * is exactly the regression that made the gate decorative in the first place —
 * and the caller must refuse to publish.
 *
 * Deliberately NOT checked for groups below k. There the gate returns 0 and raw
 * state returns the count, so the two disagree by design and asserting equality
 * would fail on correct behaviour.
 */

export type GatedCrossCheckInput = {
  /** Bucket counts read through `getHistogram`. */
  gated: number[];
  /** Bucket counts from raw ledger state. */
  raw: number[];
  /** The anonymity threshold the contract reports via readK(). */
  k: number;
  /** Group identity, used only to make the error diagnosable. */
  label: string;
  gender: number;
  component: number;
};

export class GatedMismatchError extends Error {
  readonly input: GatedCrossCheckInput;
  constructor(input: GatedCrossCheckInput) {
    super(
      `disclosure-control check failed for "${input.label}" ` +
        `(gender ${input.gender}, component ${input.component}): the contract's gated read ` +
        `circuit returned ${sum(input.gated)} across ${input.gated.length} buckets, but raw ` +
        `ledger state holds ${sum(input.raw)} for a group above k=${input.k}. ` +
        `The read path is not going through the gate. Refusing to publish.`,
    );
    this.name = "GatedMismatchError";
    this.input = input;
  }
}

function sum(h: number[]): number {
  return h.reduce((a, b) => a + b, 0);
}

/** Should this group be cross-checked at all? Only if raw state calls it publishable. */
export function shouldCrossCheck(raw: number[], k: number): boolean {
  return sum(raw) >= k;
}

/**
 * Validate one group, returning the counts to publish.
 *
 * The published counts are the GATED ones, always — including in the failure
 * path, where they are all zeros and the error tells the caller why.
 */
export function crossCheckGroup(input: GatedCrossCheckInput): number[] {
  if (!shouldCrossCheck(input.raw, input.k)) return [...input.gated];
  if (sum(input.gated) !== sum(input.raw)) throw new GatedMismatchError(input);
  return [...input.gated];
}
