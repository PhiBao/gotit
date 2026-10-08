/**
 * Chain state -> report rows, as a pure function.
 *
 * Extracted from `chainRead.ts` so the shaping can be tested against real
 * contract state — which is the only way to know the chain-to-report path works
 * before a v2 ledger is deployed. The I/O wrapper does the fetching.
 *
 * The rule this module exists to enforce: the engine's `total` is the population
 * of the row's own component. Getting that wrong is what made every Art. 9(1)(b)
 * variable-pay row report as "no data", and it cost a whole wave to find because
 * nothing tested the shape the app actually builds.
 */

/** A read-only view of the parts of the v2 ledger this function needs. */
export type V2LedgerView = {
  histogram: { lookup(key: Uint8Array): bigint | undefined };
  groupCount: { lookup(key: Uint8Array): bigint | undefined };
  kThreshold: bigint;
};

/** Look up a cell, treating a miss as 0 the way the ledger does. */
function cell(map: { lookup(key: Uint8Array): bigint | undefined }, key: Uint8Array): number {
  try {
    const v = map.lookup(key);
    return v === undefined || v === null ? 0 : Number(v);
  } catch {
    // `lookup` throws for a cell that was never written; it does not return 0.
    return 0;
  }
}

export type ChainRow = {
  /**
   * The employer's label with the component appended, e.g. "engineering · Base
   * salary". Carrying the component in the label matters: one category produces
   * TWO rows, and a lookup by category alone silently returns the first one —
   * which is how a test ends up asserting on the base population while
   * believing it is checking the variable one.
   */
  category: string;
  /** The raw label, for anyone who needs it. */
  label: string;
  component: 0 | 1;
  /** Histograms of counts, one per bucket. */
  reference: number[];
  comparison: number[];
  /** Participants on each side. */
  referenceSize: number;
  comparisonSize: number;
};

export type ShapedRows = {
  /** One row per (category, component), women vs men. */
  rows: ChainRow[];
  /** Groups the operator asked about but that hold nothing. */
  empty: string[];
};

/**
 * Shape every (category, gender, component) the caller asked about into the
 * engine's reference/comparison pairs.
 *
 * Deliberately includes groups with no data, so the caller can report them as
 * withheld rather than silently dropping them — a category that was never
 * configured is a different fact from one that was configured and came back
 * empty, and conflating the two hides coverage.
 */
export function shapeChainRows(
  led: V2LedgerView,
  opts: {
    categories: string[];
    bucketKeys: (categoryKey: Uint8Array, gender: number, component: number, bucket: number) => Uint8Array;
    groupKeys: (categoryKey: Uint8Array, gender: number, component: number) => Uint8Array;
    categoryKeys: (label: string) => Uint8Array;
  },
): ShapedRows {
  const { categories, bucketKeys, groupKeys, categoryKeys } = opts;
  const rows: ChainRow[] = [];
  const empty: string[] = [];

  for (const label of categories) {
    const ck = categoryKeys(label);
    for (const component of [0, 1] as const) {
      const read = (gender: number) => {
        const counts = Array.from({ length: 10 }, (_, b) =>
          cell(led.histogram, bucketKeys(ck, gender, component, b)),
        );
        const size = cell(led.groupCount, groupKeys(ck, gender, component));
        return { counts, size };
      };
      const women = read(0);
      const men = read(1);

      const suffix = component === 0 ? "Base salary" : "Variable / complementary";
      if (women.size + men.size === 0) empty.push(`${label} · ${suffix}`);
      rows.push({
        category: `${label} · ${suffix}`,
        label,
        component,
        reference: women.counts,
        comparison: men.counts,
        referenceSize: women.size,
        comparisonSize: men.size,
      });
    }
  }

  return { rows, empty };
}

/** The engine's shape for one row. See the module comment on why `total` is the component's own population. */
export function toEngineInput(
  row: ChainRow,
  component: 0 | 1,
  k: number,
): {
  category: string;
  reference: { total: number[]; base: number[]; variable: number[] };
  comparison: { total: number[]; base: number[]; variable: number[] };
  k: number;
} {
  const shape = (counts: number[]) =>
    component === 0
      ? { total: counts, base: counts, variable: new Array(10).fill(0) }
      : { total: counts, base: new Array(10).fill(0), variable: counts };
  return {
    category: row.category,
    reference: shape(row.reference),
    comparison: shape(row.comparison),
    k,
  };
}
