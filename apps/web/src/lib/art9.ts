/**
 * Builds an Art. 9 report from the v2 contract, with disclosure control as a
 * checked invariant rather than a convention.
 *
 * The single most important function here is `assertNoSmallCellLeak`: it takes
 * the finished report and re-derives what should have been suppressed. If a
 * below-threshold row ever reaches the output — because of a bug in the read
 * path, a bad threshold, or a future refactor — this throws rather than
 * publishing it. Defence in depth on top of the circuit's own gate.
 */
import { BUCKET_COUNT } from "@gotit/shared";
import {
  buildReport as engineBuildReport,
  renderReportMarkdown as engineRenderMarkdown,
  reportToJson as engineReportToJson,
  DEFAULT_K,
  GENDER_LABEL,
  COMPONENT_LABEL,
  GENDER,
  COMPONENT,
  type GenderId,
  type ComponentId,
  type CategoryInput,
  type GroupHistograms,
  type PayGapReport,
} from "@gotit/shared/paygap";
import {
  allGroups,
  bucketLabels,
  groupKeyHex,
  readGroupHistograms,
  readGroupSizes,
  type JobCategory,
  type ReportingGroupKey,
} from "./groups";

export type ChainGroupReading = {
  /** Bucket counts per group, as returned by the contract read path. */
  histograms: Map<string, number[]>;
  /** Participants per group. */
  sizes: Map<string, number>;
  /** The threshold the contract itself reports via readK(). */
  k: number;
  /** The period/period number from readEpoch(). */
  period: number;
  /** Members and submissions, for coverage. */
  members: number;
  submissions: number;
};

export type Art9ReportBundle = {
  report: PayGapReport;
  markdown: string;
  json: string;
  k: number;
  period: number;
  /** Groups the employer configured, before data. */
  configuredGroups: number;
  /** Groups that cleared the threshold and are publishable. */
  publishableGroups: number;
  /** Groups suppressed for being under k. */
  suppressedGroups: number;
  members: number;
  submissions: number;
};

/**
 * Fail loudly if a row below the anonymity threshold made it into the report.
 *
 * The circuit already returns 0 for such groups, so this can only fire if the
 * read path bypassed the gate (e.g. reading raw ledger state by mistake). That
 * is exactly the mistake worth an assertion.
 */
export function assertNoSmallCellLeak(report: PayGapReport, k: number): void {
  for (const row of report.rows) {
    const sizes = [row.reference.size, row.comparison.size];
    if (sizes.some((n) => n < k)) {
      throw new Error(
        `disclosure control violated: report row "${row.category}" has group sizes ` +
          `[${sizes.join(", ")}], below k=${k}. Refusing to publish. ` +
          `This means the read path bypassed the contract's getHistogram gate.`,
      );
    }
  }
}

/** Fail if a suppressed group somehow carries counts. */
export function assertSuppressedAreEmpty(report: PayGapReport, histograms: Map<string, number[]>): void {
  for (const s of report.suppressed) {
    const h = histograms.get(s.category);
    if (h && h.some((n) => n > 0) && s.reason === "no-data") {
      throw new Error(`disclosure control violated: "${s.category}" marked no-data but has counts`);
    }
  }
}

/**
 * Turn per-group readings into Art. 9 comparison rows.
 *
 * Art. 9 compares women and men within the same category and component, so the
 * engine's reference/comparison pair is (women, men) of one group. A cell with
 * only one gender present is not a comparison and is dropped by the engine's
 * two-sided suppression — which is the correct outcome, not a bug.
 */
/**
 * Map a reporting group onto the engine's reference/comparison shape.
 *
 * `total` is the population of THE COMPONENT THIS ROW IS ABOUT, not of all pay.
 * That distinction was the bug here: for a variable-pay row we used to set
 * `total` to zeros, and `buildReport` reads `total` for both the group size and
 * the anonymity gate — so every variable row was suppressed as `no-data` with
 * 0 participants. Art. 9(1)(b) and 9(1)(d), the variable-pay gaps, were
 * unreachable in the shipped app. Only `.base` and `.variable` keep the split;
 * `total` is the denominator the row's own statistics need.
 */
function toCategories(groups: ReportingGroupKey[], reading: ChainGroupReading): CategoryInput[] {
  const byCategoryComponent = new Map<string, { women?: ReportingGroupKey; men?: ReportingGroupKey }>();

  for (const g of groups) {
    const ck = `${g.categoryId}::${g.component}`;
    const slot = byCategoryComponent.get(ck) ?? {};
    if (g.gender === GENDER.FEMALE) slot.women = g;
    else if (g.gender === GENDER.MALE) slot.men = g;
    byCategoryComponent.set(ck, slot);
  }

  const out: CategoryInput[] = [];
  for (const [ck, slot] of byCategoryComponent) {
    const [categoryId, componentRaw] = ck.split("::");
    const component = Number(componentRaw) as ComponentId;
    const hist = (g?: ReportingGroupKey): number[] =>
      g ? (reading.histograms.get(gk(g)) ?? new Array(BUCKET_COUNT).fill(0)) : new Array(BUCKET_COUNT).fill(0);

    const womenH = hist(slot.women);
    const menH = hist(slot.men);
    const shape = (h: number[]): GroupHistograms =>
      component === COMPONENT.BASE
        ? { total: [...h], base: [...h], variable: new Array(BUCKET_COUNT).fill(0) }
        : { total: [...h], base: new Array(BUCKET_COUNT).fill(0), variable: [...h] };

    out.push({
      category: `${categoryId} · ${COMPONENT_LABEL[component]}`,
      reference: shape(womenH),
      comparison: shape(menH),
      // The circuit threshold is authoritative. Passing the same k here keeps the
      // report engine's own two-sided suppression aligned with the chain gate, so
      // a group that the chain would refuse to publish is never rendered.
      k: reading.k,
    });
  }
  return out;
}

/** Stable key for a reporting group — the same key the contract's groupCount uses. */
function gk(g: ReportingGroupKey): string {
  return groupKeyHex(g);
}

/**
 * Assemble the report.
 *
 * `k` comes from the contract's own `readK()`, not from a constant, so the
 * report states the threshold that is actually in force rather than the one the
 * app happens to believe is configured.
 */
export function assembleArt9Report(opts: {
  categories: JobCategory[];
  reading: ChainGroupReading;
  periodLabel: string;
  generatedAt: string;
}): Art9ReportBundle {
  const { categories, reading, periodLabel, generatedAt } = opts;
  const groups = allGroups(categories);
  const k = reading.k > 0 ? reading.k : DEFAULT_K;

  const cats = toCategories(groups, reading);
  const report = engineBuildReport(cats, { period: periodLabel, generatedAt, k });

  assertNoSmallCellLeak(report, k);
  assertSuppressedAreEmpty(report, reading.histograms);

  // Coverage notes. Participation is voluntary, so the report says how much of
  // the configured population actually appears rather than implying full coverage.
  const sizes = readGroupSizesFrom(reading, groups);
  const totalConfigured = groups.length;
  const publishable = sizes.filter((n) => n >= k).length;
  const populated = sizes.filter((n) => n > 0).length;

  report.notes.unshift(
    `Built from the Wave 2 ledger at reporting period ${reading.period}, anonymity threshold k=${k} ` +
      `(read from the contract). ${reading.submissions} verified submission(s), ${reading.members} enrolled member(s).`,
  );
  report.notes.push(
    `Coverage: ${populated} of ${totalConfigured} configured reporting groups have any data, and ` +
      `${publishable} clear the anonymity threshold. The remainder are withheld. ` +
      `Participation is voluntary, so an empty category is not evidence that pay is equal within it.`,
  );
  report.notes.push(
    "Figures are published from the contract's own read circuit, which returns 0 for any group below k. " +
      "Raw ledger state is used only to enumerate configured groups and report coverage, never as the " +
      "source of a published figure.",
  );

  return {
    report,
    markdown: engineRenderMarkdown(report),
    json: engineReportToJson(report),
    k,
    period: reading.period,
    configuredGroups: totalConfigured,
    publishableGroups: publishable,
    suppressedGroups: totalConfigured - publishable,
    members: reading.members,
    submissions: reading.submissions,
  };
}

function readGroupSizesFrom(reading: ChainGroupReading, groups: ReportingGroupKey[]): number[] {
  return groups.map((g) => reading.sizes.get(gk(g)) ?? 0);
}

/**
 * Read the whole v2 state into the shape `assembleArt9Report` expects.
 *
 * Reads raw ledger state (which bypasses the k-gate) — so the caller must
 * treat the result as "shape and coverage" only. `assertNoSmallCellLeak` is the
 * backstop that keeps raw counts out of the published report.
 */
export function readingFromLedger(
  ledgerState: any,
  categories: JobCategory[],
  opts: { k: number; period: number; members: number; submissions: number },
): ChainGroupReading {
  const groups = allGroups(categories);
  return {
    histograms: readGroupHistograms(ledgerState, groups),
    sizes: readGroupSizes(ledgerState, groups),
    k: opts.k,
    period: opts.period,
    members: opts.members,
    submissions: opts.submissions,
  };
}

export { GENDER_LABEL, COMPONENT_LABEL, GENDER, COMPONENT, DEFAULT_K, bucketLabels };
export type { GenderId, ComponentId, JobCategory };