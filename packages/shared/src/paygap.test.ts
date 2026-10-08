import { describe, it, expect } from "vitest";
import {
  buildReport,
  meanInterval,
  medianInterval,
  medianGap,
  payGap,
  quartiles,
  renderReportMarkdown,
  reportToJson,
  variableShareInterval,
  NOT_DERIVABLE_REASON,
  emptyGroupHistograms,
  type CategoryInput,
  type GroupHistograms,
} from "./paygap.js";
import { BUCKET_COUNT, BUCKETS, bucketForSalary, K_ANONYMITY, type Histogram } from "./index.js";

/** Build a histogram from salaries so tests read like the domain they describe. */
function hist(salaries: number[]): Histogram {
  const h = Array(BUCKET_COUNT).fill(0);
  for (const s of salaries) h[bucketForSalary(s)]++;
  return h;
}

function group(total: number[], base: number[] = total): GroupHistograms {
  return { total: hist(total), base: hist(base), variable: hist(total.filter((s) => !base.includes(s))) };
}

describe("mean interval", () => {
  it("brackets the true mean of bucketed data", () => {
    // Everyone sits at the bottom of bucket 3 ($100-125k) except one at $124,900.
    const h = hist([100_000, 100_000, 100_000, 100_000, 124_900]);
    const m = meanInterval(h)!;
    const trueMean = (100_000 * 4 + 124_900) / 5;
    expect(m.low).toBeLessThanOrEqual(trueMean);
    expect(m.high).toBeGreaterThanOrEqual(trueMean);
  });

  it("is a single value when a bucket is exact-width and fully occupied", () => {
    // A synthetic histogram with one occupied bucket: bounds differ, so the
    // interval is the honest answer rather than a fabricated midpoint.
    const h = Array(BUCKET_COUNT).fill(0);
    h[4] = 10;
    const m = meanInterval(h)!;
    expect(m.low).toBe(BUCKETS[4].min);
    expect(m.high).toBe(BUCKETS[4].max);
  });

  it("returns null for an empty group", () => {
    expect(meanInterval(Array(BUCKET_COUNT).fill(0))).toBeNull();
  });

  it("handles the open-ended top bucket without producing NaN or Infinity", () => {
    const h = hist([400_000, 500_000]);
    const m = meanInterval(h)!;
    expect(Number.isFinite(m.low)).toBe(true);
    expect(Number.isFinite(m.high)).toBe(true);
  });
});

describe("median", () => {
  it("gives a tight interval for an even-sized group", () => {
    // 4 people: 100k, 100k, 200k, 200k -> median lies between the two middles.
    const m = medianInterval(hist([100_000, 100_000, 200_000, 200_000]))!;
    expect(m.low).toBeLessThanOrEqual(150_000);
    expect(m.high).toBeGreaterThanOrEqual(150_000);
    expect(m.low).toBeLessThanOrEqual(200_000);
  });

  it("returns the middle bucket's full range for an odd-sized group", () => {
    const m = medianInterval(hist([100_000, 100_000, 200_000]))!;
    expect(m.low).toBe(BUCKETS[bucketForSalary(100_000)].min);
    expect(m.high).toBe(BUCKETS[bucketForSalary(100_000)].max);
  });

  it("is null when there is no data", () => {
    expect(medianInterval(Array(BUCKET_COUNT).fill(0))).toBeNull();
  });
});

describe("quartiles", () => {
  it("splits a group into four parts at the right cumulative positions", () => {
    // 8 evenly spread people across buckets 2..5
    const h = hist([80_000, 80_000, 90_000, 90_000, 110_000, 110_000, 190_000, 190_000]);
    const q = quartiles(h)!;
    expect(q.q1.high).toBeLessThanOrEqual(q.q2.low + BUCKETS[2].max);
    expect(q.q2.high).toBeLessThanOrEqual(q.q3.low + BUCKETS[4].max);
  });

  it("needs at least 4 people to be meaningful", () => {
    expect(quartiles(hist([100_000, 110_000, 120_000]))).toBeNull();
  });
});

describe("pay gap", () => {
  it("detects that the comparison group earns more", () => {
    const r = payGap(hist([100_000, 100_000, 100_000, 100_000, 100_000]), hist([200_000, 200_000, 200_000, 200_000, 200_000]));
    expect(r!.direction).toBe("other-earns-more");
    expect(r!.gap.low).toBeGreaterThan(0);
  });

  it("detects that the comparison group earns less", () => {
    const r = payGap(hist([200_000, 200_000, 200_000, 200_000, 200_000]), hist([100_000, 100_000, 100_000, 100_000, 100_000]));
    expect(r!.direction).toBe("other-earns-less");
    expect(r!.gap.high).toBeLessThan(0);
  });

  it("reports no discernible gap when the interval straddles zero", () => {
    // Reference straddles buckets 3-4, comparison sits in 3: the true gap could
    // be positive or negative depending on where in each bucket people sit.
    const r = payGap(hist([100_000, 100_000, 100_000, 149_000, 149_000]), hist([100_000, 100_000, 100_000, 100_000, 100_000]));
    expect(r!.direction).toBe("no-discernible-gap");
    expect(r!.conclusive).toBe(false);
  });

  it("treats an interval ending exactly at zero as 'at most parity', not unknown", () => {
    // Reference sits entirely in $100-125k; comparison entirely in $75-100k. The
    // worst case for the comparison group is its bucket maximum ($100k) against
    // the reference's bucket minimum ($100k) — the gap reaches 0 but can never
    // exceed it. Reporting "no discernible gap" here would hide a real disparity
    // behind a boundary artifact.
    const r = payGap(
      hist(Array.from({ length: 10 }, () => 110_000)),
      hist(Array.from({ length: 10 }, () => 90_000)),
    )!;
    expect(r.gap.high).toBeLessThanOrEqual(0);
    expect(r.direction).toBe("other-earns-less");
    expect(r.conclusive).toBe(true);
  });

  it("stays inconclusive when the two groups genuinely overlap across buckets", () => {
    // Reference spans $100-125k, comparison spans $125-175k: the comparison
    // group's floor is below the reference's ceiling, so the sign is unknown.
    const r = payGap(
      hist([140_000, 145_000, 150_000, 155_000, 160_000, 165_000, 170_000, 175_000]),
      hist([120_000, 125_000, 130_000, 135_000, 140_000, 145_000, 150_000, 155_000]),
    )!;
    expect(r.gap.low).toBeLessThan(0);
    expect(r.gap.high).toBeGreaterThan(0);
    expect(r.conclusive).toBe(false);
    expect(r.direction).toBe("no-discernible-gap");
  });

  it("flags a proven gap that reaches the 5% joint-assessment threshold", () => {
    const r = payGap(hist(Array.from({ length: 10 }, () => 100_000)), hist(Array.from({ length: 10 }, () => 200_000)))!;
    expect(r.conclusive).toBe(true);
    expect(r.material).toBe(true);
  });

  it("does not flag a negligible gap as material", () => {
    const r = payGap(hist(Array.from({ length: 10 }, () => 50_000)), hist(Array.from({ length: 10 }, () => 52_000)))!;
    expect(r.material).toBe(false);
  });

  it("does not flag an inconclusive range as material, even when its midpoint looks large", () => {
    // $50k vs $52k both sit inside the $50-75k bucket, so the true gap could be
    // anywhere in [-33%, +50%]. The midpoint (+8.3%) exceeds 5%, but the sign
    // is not even provable — flagging this would trigger a joint pay assessment
    // on a category that may be perfectly compliant.
    const r = payGap(hist(Array.from({ length: 10 }, () => 50_000)), hist(Array.from({ length: 10 }, () => 52_000)))!;
    expect(r.conclusive).toBe(false);
    expect(Math.abs(r.indicative)).toBeGreaterThan(0.05);
    expect(r.material).toBe(false);
  });

  it("exposes an indicative magnitude for prioritisation", () => {
    const r = payGap(hist(Array.from({ length: 10 }, () => 100_000)), hist(Array.from({ length: 10 }, () => 200_000)))!;
    expect(r.indicative).toBeGreaterThan(0.5);
    expect(Number.isFinite(r.indicative)).toBe(true);
  });

  it("only calls a gap material when the proven bound, not the midpoint, reaches 5%", () => {
    // Reference straddles buckets 3-4 so its mean is loose; comparison sits in
    // bucket 5. The gap is certainly positive, but its lower bound is what we
    // can defend, so that is what gets compared to the threshold.
    const r = payGap(
      hist([100_000, 100_000, 100_000, 100_000, 124_000, 124_000, 124_000, 124_000, 124_000, 124_000]),
      hist(Array.from({ length: 10 }, () => 160_000)),
    )!;
    expect(r.conclusive).toBe(true);
    const defensible = Math.min(Math.abs(r.gap.low), Math.abs(r.gap.high));
    expect(r.material).toBe(defensible >= 0.05);
  });

  it("returns null when either group is empty", () => {
    expect(payGap(hist([100_000, 110_000]), Array(BUCKET_COUNT).fill(0))).toBeNull();
  });
});

describe("variable pay share (Art. 9(1)(e))", () => {
  const g = (base: number[], variable: number[]): GroupHistograms => ({
    total: base.map((_, i) => base[i] + variable[i]),
    base,
    variable,
  });

  it("bounds the share above by the smaller of the two cells", () => {
    // 4 paid base, 3 paid variable. At most 3 of the 4 can have both, so the
    // share is at most 75%. The model cannot say fewer, because a person could
    // have submitted variable without base.
    const r = variableShareInterval(g([1, 1, 1, 1], [0, 1, 1, 1]));
    expect(r.share!.high).toBeCloseTo(0.75);
    expect(r.share!.low).toBe(0);
    expect(r.precision).toBe("bounded");
  });

  it("bounds the share above by the base population when variable exceeds it", () => {
    // Everyone on variable pay, more variable submissions than base. At most all
    // of the base group can have received it.
    const r = variableShareInterval(g([1, 1], [0, 0, 4, 4]));
    expect(r.share!.high).toBe(1);
  });

  it("is not-derivable when the base group is empty — not 0%", () => {
    // An empty base group means no denominator. Printing 0% here would read as
    // a finding that nobody received variable pay, which is not what it says.
    const r = variableShareInterval(g([], [0, 1]));
    expect(r.precision).toBe("not-derivable");
    expect(r.share).toBeNull();
    expect(r.reason).toMatch(/no denominator/);
  });

  it("states why the interval cannot be tightened, on the record", () => {
    expect(NOT_DERIVABLE_REASON).toMatch(/cannot be derived as a point estimate/);
    expect(NOT_DERIVABLE_REASON).toMatch(/second nullifier/);
    expect(NOT_DERIVABLE_REASON).toMatch(/refused/);
  });
});

describe("median gap", () => {
  it("is a currency interval, not a percentage", () => {
    const g = medianGap(hist([100_000, 100_000, 100_000, 100_000]), hist([150_000, 150_000, 150_000, 150_000]));
    expect(g).not.toBeNull();
    expect(g!.low).toBeGreaterThan(0);
  });
});

describe("report building", () => {
  const cat = (category: string, ref: number[], cmp: number[]): CategoryInput => ({
    category,
    reference: group(ref),
    comparison: group(cmp),
  });

  it("emits a row when both sides clear k", () => {
    const r = buildReport(
      [cat("Engineering", [100_000, 110_000, 120_000, 130_000, 140_000], [90_000, 95_000, 100_000, 105_000, 110_000])],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.suppressed).toHaveLength(0);
    expect(r.rows[0].reference.size).toBe(5);
  });

  it("suppresses a category where either side is below k", () => {
    // 5 vs 2: publishing one side would reveal the other by subtraction.
    const r = buildReport(
      [cat("Design", [100_000, 110_000, 120_000, 130_000, 140_000], [90_000, 95_000])],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    expect(r.rows).toHaveLength(0);
    expect(r.suppressed).toHaveLength(1);
    expect(r.suppressed[0].reason).toBe("below-k-anonymity-threshold");
  });

  it("never discloses a single person's pay through a one-sided row", () => {
    const r = buildReport(
      [cat("Legal", [100_000, 110_000, 120_000, 130_000, 140_000, 150_000], [200_000])],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    expect(r.rows).toHaveLength(0);
    expect(r.suppressed).toHaveLength(1);
  });

  it("marks an entirely empty category distinctly from a small one", () => {
    const r = buildReport([cat("Newly formed", [], [])], { period: "FY2026", generatedAt: "2026-09-30" });
    expect(r.suppressed[0].reason).toBe("no-data");
  });

  it("counts participation including suppressed categories", () => {
    const r = buildReport(
      [
        cat("Engineering", [100_000, 110_000, 120_000, 130_000, 140_000], [90_000, 95_000, 100_000, 105_000, 110_000]),
        cat("Design", [100_000], [90_000]),
      ],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.suppressed).toHaveLength(1);
    expect(r.participatingCategories).toBe(2);
    expect(r.totalParticipants).toBe(12);
  });

  it("always carries the accuracy and participation notes", () => {
    const r = buildReport([], { period: "FY2026", generatedAt: "2026-09-30" });
    expect(r.notes.length).toBeGreaterThanOrEqual(2);
    expect(r.notes.join(" ")).toMatch(/interval/i);
    expect(r.notes.join(" ")).toMatch(/voluntary/i);
  });

  it("states plainly when nothing is publishable", () => {
    const r = buildReport([cat("Sales", [1, 2], [3])], { period: "FY2026", generatedAt: "2026-09-30" });
    const md = renderReportMarkdown(r);
    expect(md).toMatch(/No category met the anonymity threshold/);
  });

  it("renders a table with both groups side by side", () => {
    const r = buildReport(
      [cat("Engineering", [100_000, 110_000, 120_000, 130_000, 140_000], [90_000, 95_000, 100_000, 105_000, 110_000])],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    const md = renderReportMarkdown(r);
    expect(md).toContain("| Headcount | 5 | 5 |");
    expect(md).toContain("Mean pay gap");
    expect(md).toContain("Disclosure notes");
  });

  it("serialises to JSON without Infinity or NaN", () => {
    const r = buildReport(
      [cat("Engineering", [100_000, 110_000, 120_000, 130_000, 140_000], [400_000, 420_000, 440_000, 460_000, 480_000])],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    const json = reportToJson(r);
    expect(json).not.toMatch(/Infinity/);
    expect(json).not.toMatch(/NaN/);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("carries the Art. 9(4) materiality warning into the rendered report", () => {
    const mk = (v: number) => ({
      total: hist(Array.from({ length: 10 }, () => v)),
      base: hist(Array.from({ length: 10 }, () => v)),
      variable: hist([]),
    });
    const r = buildReport([{ category: "Engineering", reference: mk(100_000), comparison: mk(200_000) }], {
      period: "FY2026",
      generatedAt: "2026-09-30",
    });
    const md = renderReportMarkdown(r);
    expect(md).toContain("5% threshold");
    expect(md).toContain("joint pay assessment");
  });

  it("does not print a materiality warning for a negligible gap", () => {
    const mk = (v: number) => ({
      total: hist(Array.from({ length: 10 }, () => v)),
      base: hist(Array.from({ length: 10 }, () => v)),
      variable: hist([]),
    });
    const r = buildReport([{ category: "Support", reference: mk(50_000), comparison: mk(52_000) }], {
      period: "FY2026",
      generatedAt: "2026-09-30",
    });
    expect(renderReportMarkdown(r)).not.toContain("5% threshold");
  });
});

describe("disclosure regression", () => {
  it("withholds the whole report when a category is one person short of k", () => {
    const r = buildReport(
      [
        {
          category: "Executive",
          reference: { total: hist([500_000, 500_000, 500_000, 500_000]), base: hist([500_000, 500_000, 500_000, 500_000]), variable: hist([]) },
          comparison: { total: hist([480_000]), base: hist([480_000]), variable: hist([]) },
        },
      ],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    expect(r.rows).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("480");
  });

  it("uses the project's k threshold by default", () => {
    const r = buildReport(
      [
        {
          category: "Exactly k",
          reference: { total: hist(Array.from({ length: K_ANONYMITY }, () => 100_000)), base: hist(Array.from({ length: K_ANONYMITY }, () => 100_000)), variable: hist([]) },
          comparison: { total: hist(Array.from({ length: K_ANONYMITY }, () => 100_000)), base: hist(Array.from({ length: K_ANONYMITY }, () => 100_000)), variable: hist([]) },
        },
      ],
      { period: "FY2026", generatedAt: "2026-09-30" },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.k).toBe(K_ANONYMITY);
  });
});
