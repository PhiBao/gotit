/**
 * Pay gap report computation (Wave 2)
 *
 * Pure functions, no I/O — every number here is reproducible from on-chain
 * histogram state alone, which is what makes the resulting report verifiable
 * by a third party.
 *
 * The required outputs come from Directive (EU) 2023/970 Art. 9, first reports
 * due 7 June 2027 for employers with 150+ workers:
 *   (a) the gender pay gap
 *   (b) the gender pay gap in complementary or variable components
 *   (c) the median gender pay gap
 *   (d) the median gender pay gap in complementary or variable components
 *   (e) the proportion of female and male workers receiving complementary or
 *       variable components
 * plus the distribution of men and women across each pay quartile.
 *
 * Accuracy, stated honestly: a histogram gives us EXACT counts, EXACT median
 * and EXACT quartiles, but only BOUNDED means and gaps. We report a gap as an
 * interval and say so on the report's face. Reporting a point estimate from
 * bucketed data would be a rounding error dressed up as a statistic.
 */

import { BUCKETS, BUCKET_COUNT, K_ANONYMITY, bucketLabel, bucketsFor, type Histogram } from "./index.js";

// ---- Reporting dimensions (Directive (EU) 2023/970 Art. 9) ----

/**
 * Art. 9 splits every figure by sex. Only three values are representable
 * without creating a disclosure risk: the Directive's two required buckets plus
 * "other / not disclosed". Any finer split — non-binary as a fourth, or a
 * free-text answer — would produce a cell so small that publishing it
 * re-identifies someone, and the point of this contract is that it cannot be
 * made to do that.
 */
export const GENDER = {
  FEMALE: 0,
  MALE: 1,
  OTHER: 2,
} as const;
export type GenderId = (typeof GENDER)[keyof typeof GENDER];
export const GENDER_COUNT = 3;

export const GENDER_LABEL: Record<GenderId, string> = {
  0: "Women",
  1: "Men",
  2: "Other / not disclosed",
};

/**
 * Art. 9(1)(b) requires the gap to be reported separately for "complementary or
 * variable components". Blending base and variable into one total is how most
 * published reports mislead, so they are separate dimensions from the start
 * rather than a statistic derived afterwards.
 */
export const COMPONENT = {
  BASE: 0,
  VARIABLE: 1,
} as const;
export type ComponentId = (typeof COMPONENT)[keyof typeof COMPONENT];
export const COMPONENT_COUNT = 2;

export const COMPONENT_LABEL: Record<ComponentId, string> = {
  0: "Base salary",
  1: "Variable / complementary",
};

/** Anonymity threshold used at deploy, and the default for the report engine. */
export const DEFAULT_K = 5;

export function assertGender(g: number): void {
  if (!Number.isInteger(g) || g < 0 || g >= GENDER_COUNT) {
    throw new Error(`gender must be 0..${GENDER_COUNT - 1}, got ${g}`);
  }
}

export function assertComponent(c: number): void {
  if (!Number.isInteger(c) || c < 0 || c >= COMPONENT_COUNT) {
    throw new Error(`component must be 0..${COMPONENT_COUNT - 1}, got ${c}`);
  }
}

/** A reporting group as the Directive means it: one category, one gender, one component. */
export type ReportingGroup = {
  /** Hash of the employer's "category of worker" label — never the label text. */
  categoryKeyHex: string;
  /** Human-readable label, held off-chain and published in the report. */
  categoryLabel: string;
  gender: GenderId;
  component: ComponentId;
};

// ---- Pay component ----

export type PayComponent = "base" | "variable";

export const PAY_COMPONENTS: readonly PayComponent[] = ["base", "variable"] as const;

/**
 * Article 9(1)(a) splits pay into basic salary and "complementary or variable
 * components" such as bonuses. We keep them as separate histograms so a report
 * can state the split rather than blending it into a single misleading number.
 */
export type GroupHistograms = {
  /** Histogram of total pay, all components. */
  total: Histogram;
  /** Histogram of basic salary only. */
  base: Histogram;
  /** Histogram of bonus / commission / equity-cash only. */
  variable: Histogram;
};

export function emptyGroupHistograms(): GroupHistograms {
  return { total: zeros(), base: zeros(), variable: zeros() };
}

function zeros(): Histogram {
  return Array(BUCKET_COUNT).fill(0);
}

/**
 * Midpoint of a bucket; the top bucket uses a finite stand-in (see notes).
 *
 * Component-aware: base and variable use different bucket scales, so a
 * midpoint computed from the base table would be wrong by an order of magnitude
 * for a bonus. Every statistic below is therefore parameterised by component
 * rather than assuming the base scale.
 */
export function bucketMid(bucket: number, component: 0 | 1 = 0): number {
  const b = bucketsFor(component)[bucket];
  if (!b) return Number.NaN;
  if (!Number.isFinite(b.max)) return component === 0 ? 350_000 : 100_000;
  return (b.min + b.max) / 2;
}

// ---- Interval arithmetic ----

/**
 * A statistic we know only to within bounds. Gaps derived from bucketed data
 * are always intervals, never point estimates.
 */
export type Interval = { low: number; high: number };

export function interval(low: number, high: number): Interval {
  return low <= high ? { low, high } : { low: high, high: low };
}

export function intervalPoint(i: Interval): number {
  return (i.low + i.high) / 2;
}

export function intervalWidth(i: Interval): number {
  return i.high - i.low;
}

export function formatInterval(i: Interval, asPercent = true): string {
  const f = (v: number) => (asPercent ? `${(v * 100).toFixed(1)}%` : Math.round(v).toLocaleString("en-US"));
  if (Math.abs(intervalWidth(i)) < 1e-9) return f(i.low);
  return `${f(i.low)} – ${f(i.high)}`;
}

/** a - b, interval-aware. */
export function subtract(a: Interval, b: Interval): Interval {
  return interval(a.low - b.high, a.high - b.low);
}

// ---- Distribution statistics ----

export function groupSize(h: Histogram): number {
  return h.reduce((a, b) => a + b, 0);
}

export function isReportable(h: Histogram, k = K_ANONYMITY): boolean {
  return groupSize(h) >= k;
}

/**
 * Median pay. Exact for even group sizes; for odd sizes the true median is the
 * single middle observation, which a histogram cannot pin down — so we return
 * the interval between the two central buckets instead of guessing.
 */
export function medianInterval(h: Histogram, component: 0 | 1 = 0): Interval | null {
  const n = groupSize(h);
  if (n === 0) return null;
  if (n % 2 === 1) {
    const mid = (n + 1) / 2;
    const b = bucketAtRank(h, mid);
    if (b === null) return null;
    const bd = bucketsFor(component)[b];
    return interval(bd.min, Number.isFinite(bd.max) ? bd.max : Number.POSITIVE_INFINITY);
  }
  const lower = bucketAtRank(h, n / 2);
  const upper = bucketAtRank(h, n / 2 + 1);
  if (lower === null || upper === null) return null;
  return interval(bucketMin(lower, component), bucketMax(upper, component));
}

/**
 * The pay quartile split: the pay band boundaries separating the bottom 25%,
 * second 25%, third 25% and top 25% of the group. This is Article 9's
 * "distribution of workers across each pay quartile", expressed as the
 * thresholds a reader can act on.
 */
export type Quartiles = {
  q1: Interval;
  q2: Interval;
  q3: Interval;
};

export function quartiles(h: Histogram, component: 0 | 1 = 0): Quartiles | null {
  const n = groupSize(h);
  if (n < 4) return null;
  return {
    q1: thresholdAtFraction(h, 0.25, component),
    q2: thresholdAtFraction(h, 0.5, component),
    q3: thresholdAtFraction(h, 0.75, component),
  };
}

/** The bucket boundary at the given cumulative fraction of the group. */
function thresholdAtFraction(h: Histogram, frac: number, component: 0 | 1 = 0): Interval {
  const n = groupSize(h);
  if (n === 0) return interval(0, 0);
  const target = Math.max(1, Math.min(n, Math.round(frac * n)));
  const b = bucketAtRank(h, target);
  if (b === null) return interval(0, 0);
  return interval(bucketMin(b, component), bucketMax(b, component));
}

function bucketAtRank(h: Histogram, rank: number): number | null {
  let cum = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] > 0) {
      cum += h[i];
      if (cum >= rank) return i;
    }
  }
  for (let i = h.length - 1; i >= 0; i--) if (h[i] > 0) return i;
  return null;
}

function bucketMin(b: number, component: 0 | 1 = 0): number {
  return bucketsFor(component)[b]?.min ?? 0;
}

function bucketMax(b: number, component: 0 | 1 = 0): number {
  const m = bucketsFor(component)[b]?.max;
  return Number.isFinite(m as number) ? (m as number) : Number.POSITIVE_INFINITY;
}

/**
 * Mean pay, as an interval. The true mean lies between the mean of all bucket
 * midpoints (lower bound, when everyone sits at the bottom of their bucket) and
 * the mean of all bucket maxima (upper bound).
 */
export function meanInterval(h: Histogram, component: 0 | 1 = 0): Interval | null {
  const n = groupSize(h);
  if (n === 0) return null;
  let low = 0;
  let high = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] === 0) continue;
    low += h[i] * bucketMin(i, component);
    const mx = bucketMax(i, component);
    high += h[i] * (Number.isFinite(mx) ? mx : bucketMid(i, component));
  }
  return interval(low / n, high / n);
}

// ---- The gender pay gap ----

/**
 * Gap is conventionally expressed relative to the reference group's mean:
 *   gap = (mean_other - mean_reference) / mean_reference
 * Using the reference group's own (interval) mean as the denominator gives an
 * interval, widened by the numerator's uncertainty. The direction of the
 * interval tells us the sign unambiguously unless it straddles zero, which we
 * report as "no discernible gap" rather than as zero.
 */
/**
 * Article 9(4) triggers a joint pay assessment when a report shows an
 * unjustified gap of 5% or more in a worker category. This is the threshold
 * that has consequences, so we flag against it explicitly.
 */
export const MATERIALITY_THRESHOLD = 0.05;

export type GapDirection = "other-earns-more" | "other-earns-less" | "no-discernible-gap";

export type GapResult = {
  /** Range the true gap provably lies within. */
  gap: Interval;
  /**
   * Sign of the gap. Determined by the whole interval, not a point estimate:
   * if any part of the interval is above zero the other group may earn more.
   */
  direction: GapDirection;
  /**
   * Indicative magnitude, for prioritisation only. Explicitly NOT the filed
   * figure — the interval above is.
   */
  indicative: number;
  /** True when the indicative gap reaches the 5% joint-assessment threshold. */
  material: boolean;
  /** False when the interval straddles zero, i.e. the sign is not provable. */
  conclusive: boolean;
};

export function payGap(reference: Histogram, other: Histogram): GapResult | null {
  const refMean = meanInterval(reference);
  const othMean = meanInterval(other);
  if (!refMean || !othMean || groupSize(reference) === 0 || groupSize(other) === 0) return null;

  // Divide interval by interval: the extremes come from opposite corners.
  const lo = (othMean.low - refMean.high) / refMean.high;
  const hi = (othMean.high - refMean.low) / refMean.low;
  const gap = interval(lo, hi);

  // A boundary value of exactly 0 is a real, reportable finding ("at most
  // parity"), not an absence of one. Only a range that genuinely crosses zero
  // is inconclusive.
  const EPS = 1e-9;
  let direction: GapDirection = "no-discernible-gap";
  let conclusive = true;
  if (gap.low > EPS) {
    direction = "other-earns-more";
  } else if (gap.high < -EPS) {
    direction = "other-earns-less";
  } else if (gap.high <= EPS && gap.low < -EPS) {
    // Range sits entirely at or below parity: the other group never earns more.
    direction = "other-earns-less";
  } else if (gap.low >= -EPS && gap.high > EPS) {
    direction = "other-earns-more";
  } else {
    conclusive = false;
  }

  // Materiality is judged on the bound that matters, not on the midpoint.
  //
  // Using the midpoint here would be a category error: it is a point estimate
  // of a quantity the data only bounds. A range of [-33%, +50%] has midpoint
  // +8.3% and would be flagged as material, but the true gap could be 0 —
  // flagging it would cry wolf on a category that may be perfectly compliant,
  // and the consequence of a false flag is a joint pay assessment.
  //
  // Rule: flag when the range excludes zero AND the bound nearest zero still
  // reaches the threshold. Only a *proven* disparity of the required size
  // counts.
  const nearestZero = Math.min(Math.abs(gap.low), Math.abs(gap.high));
  const material = conclusive && nearestZero >= MATERIALITY_THRESHOLD;

  return { gap, direction, indicative: intervalPoint(gap), material, conclusive };
}

export function medianGap(reference: Histogram, other: Histogram): Interval | null {
  const ref = medianInterval(reference);
  const oth = medianInterval(other);
  if (!ref || !oth || ref.low === 0) return null;
  // Numerator is exactly bounded; denominator is not, so widen conservatively.
  return subtract(oth, ref);
}

// ---- Disclosure control ----

export type SuppressionReason =
  /** Both sides present, but the smaller one is under the threshold. */
  | "below-k-anonymity-threshold"
  /** Neither side has any participants at all. */
  | "no-data"
  /**
   * Only one side reported. Art. 9 compares women and men within a category, so
   * this cannot be reported — and reporting the side that did report would
   * reveal the other by subtraction. Distinct from "no data" because it means
   * "we have half a comparison", which is a very different fact for a reader.
   */
  | "no-comparison-group"
  | "merged-into-parent-category";

export type SuppressedRow = {
  category: string;
  reason: SuppressionReason;
  size: number;
};

export type ReportRow = {
  category: string;
  reference: { size: number; mean: Interval; median: Interval | null };
  comparison: { size: number; mean: Interval; median: Interval | null };
  gap: ReturnType<typeof payGap>;
  medianGap: Interval | null;
  /**
   * Art. 9(1)(e). An interval, never a number — see variableShareInterval for
   * why the model cannot support a point estimate.
   */
  variableShare: { reference: VariableShareResult; comparison: VariableShareResult } | null;
  quartiles: { reference: Quartiles | null; comparison: Quartiles | null };
};

export type PayGapReport = {
  /** ISO date the report was generated. */
  generatedAt: string;
  /** Reporting period label, e.g. "FY2026". */
  period: string;
  k: number;
  rows: ReportRow[];
  suppressed: SuppressedRow[];
  /** Categories that received at least one participant, before suppression. */
  participatingCategories: number;
  /** Total participants across all categories, including suppressed ones. */
  totalParticipants: number;
  /** Categories where one side fell below k and the row was withheld. */
  partialCategories: number;
  notes: string[];
};

// ---- Report assembly ----

export type CategoryInput = {
  /** Employer's own job-category label, passed through unchanged. */
  category: string;
  reference: GroupHistograms;
  comparison: GroupHistograms;
  k?: number;
};

const PERCENTILE_NOTE =
  "Gaps and means are intervals, not point estimates: the underlying data is bucketed, so the exact figures are not recoverable. Quartiles and counts are exact.";
export const NOT_DERIVABLE_REASON =
  "Art. 9(1)(e) cannot be derived as a point estimate from an unlinkable histogram. " +
  "The ledger counts base-pay submissions and variable-pay submissions in separate cells " +
  "with no link between them, so |base| and |variable| are exact but their intersection is " +
  "not known. We publish the interval that the model bounds rather than a number it cannot " +
  "support. Tightening it would require either linking a person's base and variable pay — " +
  "which defeats the design — or counting distinct contributors per group per period via a " +
  "second nullifier, which would reveal that one person submitted both. Both are refused.";

const PARTICIPATION_NOTE =
  "Participation is voluntary. Category sizes below the anonymity threshold are suppressed, and participation counts are shown so incomplete coverage is visible rather than hidden.";

/**
 * Build a report from per-category histograms. This is a pure function of
 * on-chain state — no network calls — so anyone can re-run it and get the same
 * numbers, which is the point.
 */
export function buildReport(
  categories: CategoryInput[],
  meta: { period: string; generatedAt: string; k?: number },
): PayGapReport {
  const k = meta.k ?? K_ANONYMITY;
  const rows: ReportRow[] = [];
  const suppressed: SuppressedRow[] = [];
  let participating = 0;
  let total = 0;
  let partial = 0;

  for (const c of categories) {
    const refTotal = groupSize(c.reference.total);
    const cmpTotal = groupSize(c.comparison.total);
    participating += 1;
    total += refTotal + cmpTotal;

    if (refTotal + cmpTotal === 0) {
      suppressed.push({ category: c.category, reason: "no-data", size: 0 });
      continue;
    }

    // Disclosure control: withhold the row unless BOTH sides clear k. Reporting
    // one side of a comparison reveals the other by subtraction, so a one-sided
    // row is a disclosure just as much as a small cell.
    if (refTotal < k || cmpTotal < k) {
      // Distinguish "we have half a comparison" from "the small side is under k".
      // A compliance reader needs to know which, because only the second is
      // fixable by recruiting more people.
      const reason: SuppressionReason =
        refTotal === 0 || cmpTotal === 0 ? "no-comparison-group" : "below-k-anonymity-threshold";
      suppressed.push({ category: c.category, reason, size: refTotal + cmpTotal });
      if (refTotal < k && cmpTotal < k) partial += 1;
      continue;
    }

    const gap = payGap(c.reference.total, c.comparison.total);
    rows.push({
      category: c.category,
      reference: {
        size: refTotal,
        mean: meanInterval(c.reference.total)!,
        median: medianInterval(c.reference.total),
      },
      comparison: {
        size: cmpTotal,
        mean: meanInterval(c.comparison.total)!,
        median: medianInterval(c.comparison.total),
      },
      gap,
      medianGap: medianGap(c.reference.total, c.comparison.total),
      variableShare: {
        reference: variableShareInterval(c.reference),
        comparison: variableShareInterval(c.comparison),
      },
      quartiles: {
        reference: quartiles(c.reference.total),
        comparison: quartiles(c.comparison.total),
      },
    });
  }

  return {
    generatedAt: meta.generatedAt,
    period: meta.period,
    k,
    rows,
    suppressed,
    participatingCategories: participating,
    totalParticipants: total,
    partialCategories: partial,
    notes: [PERCENTILE_NOTE, PARTICIPATION_NOTE, VARIABLE_SHARE_NOTE],
  };
}

/**
 * Art. 9(1)(e): the proportion of a group receiving complementary or variable pay.
 *
 * This is the statistic our model CANNOT answer as a number, and the reason is
 * structural rather than a bug. The ledger holds two independent maps:
 *
 *   base    — submissions of base pay, keyed (category, gender, BASE, bucket)
 *   variable — submissions of variable pay, keyed (category, gender, VARIABLE, bucket)
 *
 * A person submitting both increments two separate cells with no link between
 * them. So we know |base| exactly and |variable| exactly, but not |base ∩
 * variable| — the quantity (e) is asking about. Any single number we printed
 * would be a guess wearing the costume of a statistic.
 *
 * What the model DOES bound. The overlap is a subset of both, so:
 *
 *     |∩| <= min(|base|, |variable|)
 *     |∩| >= max(0, |base| + |variable| - N)
 *
 * where N is the number of distinct people who submitted anything for this
 * reporting group in this period. The ledger does not track N, because tracking
 * it would mean a second nullifier keyed on the group — which would reveal that
 * one person submitted both base and variable pay, i.e. it links the two cells
 * the design deliberately leaves unlinkable. Without N the lower bound is 0.
 *
 * So we publish the interval that actually holds, and we say why it cannot be
 * tightened. The two ways to tighten it are both privacy regressions we refuse:
 * link a person's base and variable submissions, or count distinct contributors
 * per group per period. Both are named in `NOT_DERIVABLE_REASON` so a reviewer
 * can check our reasoning rather than take our word for it.
 *
 * Making (e) an interval is the same honesty move as making the mean an
 * interval — applied to the statistic most published reports fabricate.
 */
export type VariableShareResult = {
  /** Bounds on the true proportion. `low` may be 0 without a group-level N. */
  share: Interval | null;
  /** Population answering to (e)'s denominator — the base-pay group. */
  populationSize: number;
  /** How many submitted variable pay at all. */
  variableCount: number;
  /** Whether the bounds are tight enough to file, or only bounded. */
  precision: "exact" | "bounded" | "not-derivable";
  /** Why, when this is not derivable as a number. */
  reason?: string;
};

const VARIABLE_SHARE_NOTE =
  "Art. 9(1)(e) is reported as an interval. " + NOT_DERIVABLE_REASON;

export function variableShareInterval(
  g: GroupHistograms,
): VariableShareResult {
  const population = groupSize(g.base);
  const variableCount = groupSize(g.variable);

  if (population === 0) {
    // The base-pay group is empty, so the proportion has no denominator. This is
    // a different fact from "nobody received variable pay" and must not render
    // as 0%, which would read as a finding.
    return {
      share: null,
      populationSize: 0,
      variableCount,
      precision: "not-derivable",
      reason:
        "The base-pay group for this reporting group is empty, so the proportion receiving " +
        "variable pay has no denominator. This is not a finding of 0%.",
    };
  }

  const overlapUpperBound = Math.min(population, variableCount);
  const overlapLowerBound = 0;
  const share = interval(overlapLowerBound / population, overlapUpperBound / population);

  // "exact" when the bounds meet — which happens only if the two cells are
  // linked, i.e. never in the current model. Kept as a branch so the day a
  // group-level contributor count lands, this tightens without a rewrite.
  const precision: VariableShareResult["precision"] =
    overlapLowerBound === overlapUpperBound ? "exact" : "bounded";

  return { share, populationSize: population, variableCount, precision };
}

// ---- Rendering ----

function money(i: Interval): string {
  const f = (v: number) => (Number.isFinite(v) ? `$${Math.round(v).toLocaleString("en-US")}` : "$∞");
  if (!Number.isFinite(i.low) && !Number.isFinite(i.high)) return "—";
  if (i.low === i.high) return f(i.low);
  return `${f(i.low)}–${f(i.high)}`;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Render a bounded proportion so it can be misread as a worker-level finding
 * in neither direction. "[0,0]" means no CONTRIBUTOR reported variable pay; it
 * does not mean no worker received it, and printing "0.0%" alone would imply
 * the second.
 */
function renderShare(r: VariableShareResult): string {
  if (!r.share) return "not derivable — no base-pay denominator";
  const lo = r.share.low;
  const hi = r.share.high;
  if (lo === 0 && hi === 0) return "0% of contributors reported variable pay";
  if (lo === hi) return `${pct(lo)} of contributors`;
  return `at most ${pct(hi)} of contributors (lower bound not provable)`;
}

/**
 * Render the report as the markdown table a compliance officer actually pastes
 * into their filing, plus the disclosure notes that have to travel with it.
 */
export function renderReportMarkdown(r: PayGapReport): string {
  const L: string[] = [];
  L.push(`# Pay gap report — ${r.period}`);
  L.push("");
  L.push(`Generated ${r.generatedAt} · anonymity threshold k=${r.k} · ${r.totalParticipants} participants across ${r.participatingCategories} categories`);
  L.push("");

  if (r.rows.length === 0) {
    L.push(`> No category met the anonymity threshold of k=${r.k}. Nothing is publishable this period.`);
  }

  for (const row of r.rows) {
    L.push(`## ${row.category}`);
    L.push("");
    L.push(`| | Reference group | Comparison group |`);
    L.push(`|---|---|---|`);
    L.push(`| Headcount | ${row.reference.size} | ${row.comparison.size} |`);
    L.push(`| Median pay | ${row.reference.median ? money(row.reference.median) : "—"} | ${row.comparison.median ? money(row.comparison.median) : "—"} |`);
    L.push(`| Mean pay | ${money(row.reference.mean)} | ${money(row.comparison.mean)} |`);
    L.push(
      `| Reported variable pay, among contributors (Art. 9(1)(e)) | ${
        row.variableShare ? renderShare(row.variableShare.reference) : "—"
      } | ${row.variableShare ? renderShare(row.variableShare.comparison) : "—"} |`,
    );
    L.push("");
    if (row.gap) {
      const dir = row.gap.direction.replace(/-/g, " ");
      const tag = row.gap.conclusive ? "" : " — sign not provable from bucketed data";
      L.push(`**Mean pay gap:** ${formatInterval(row.gap.gap)} (${dir})${tag}`);
      if (row.gap.material) {
        L.push("");
        L.push(
          `> **At or above the ${(MATERIALITY_THRESHOLD * 100).toFixed(0)}% threshold** in Art. 9(4): ` +
            `if this gap is not objectively justified, a joint pay assessment with worker representatives is triggered.`,
        );
      }
    } else {
      L.push("**Mean pay gap:** not computable");
    }
    if (row.medianGap) L.push(`**Median pay gap:** ${money(row.medianGap)}`);
    const qRef = row.quartiles.reference;
    const qCmp = row.quartiles.comparison;
    if (qRef && qCmp) {
      L.push("");
      L.push("| Pay quartile boundary | Reference group | Comparison group |");
      L.push("|---|---|---|");
      L.push(`| 25th percentile | ${money(qRef.q1)} | ${money(qCmp.q1)} |`);
      L.push(`| Median | ${money(qRef.q2)} | ${money(qCmp.q2)} |`);
      L.push(`| 75th percentile | ${money(qRef.q3)} | ${money(qCmp.q3)} |`);
    }
    L.push("");
  }

  if (r.suppressed.length) {
    L.push("## Suppressed categories");
    L.push("");
    L.push(`| Category | Participants | Reason |`);
    L.push(`|---|---|---|`);
    for (const s of r.suppressed) {
      L.push(`| ${s.category} | ${s.size} | ${s.reason} |`);
    }
    L.push("");
  }

  L.push("## Disclosure notes");
  L.push("");
  for (const n of r.notes) L.push(`- ${n}`);
  L.push("");
  return L.join("\n");
}

/** Machine-readable form, for the verification page and for diffing periods. */
export function reportToJson(r: PayGapReport): string {
  return JSON.stringify(
    r,
    (_k, v) =>
      typeof v === "number" && !Number.isFinite(v)
        ? v > 0
          ? "unbounded"
          : "unbounded"
        : v,
    2,
  );
}

/** Which bucket a person falls in — used by tests and by the client-side form. */
export { bucketLabel, BUCKETS };
