import { describe, it, expect } from "vitest";
import { BUCKET_COUNT, bucketForSalary } from "@gotit/shared";
import { buildReport, GENDER, COMPONENT, DEFAULT_K } from "@gotit/shared/paygap";
import { assertNoSmallCellLeak, assertSuppressedAreEmpty, assembleArt9Report, type ChainGroupReading } from "./art9";
import { allGroups, groupKeyHex, type JobCategory } from "./groups";
import { sampleArt9Report } from "./art9.sample";
import { getStoredContractAddress, getStoredV2ContractAddress } from "./session";

/**
 * Tests for the disclosure-control invariants.
 *
 * The contract already refuses to publish a group below k. These tests cover the
 * layer ABOVE it: that the read path and the report assembly cannot be talked
 * into publishing a small cell anyway. That is the failure mode worth defending
 * against, because it would be silent — a wrong number in a compliance filing
 * is worse than no number.
 */

const CATEGORIES: JobCategory[] = [
  { id: "ENG", label: "engineering", expectedHeadcount: 40 },
  { id: "SAL", label: "sales" },
];

function hist(n: number, bucket: number): number[] {
  const h = new Array(BUCKET_COUNT).fill(0);
  h[bucket] = n;
  return h;
}

function groupOf(label: string, gender: number, component: number) {
  return allGroups(CATEGORIES).find(
    (g) => g.categoryLabel === label && g.gender === gender && g.component === component,
  )!;
}

function readingFor(opts: {
  /** participants per "category:gender:component" */
  counts: Record<string, number>;
  k?: number;
  period?: number;
  members?: number;
  submissions?: number;
}): ChainGroupReading {
  const groups = allGroups(CATEGORIES);
  const histograms = new Map<string, number[]>();
  const sizes = new Map<string, number>();
  let total = 0;
  for (const g of groups) {
    const id = `${g.categoryId}:${g.gender}:${g.component}`;
    const n = opts.counts[id] ?? 0;
    sizes.set(groupKeyHex(g), n);
    histograms.set(groupKeyHex(g), hist(n, bucketForSalary(100_000, g.component)));
    total += n;
  }
  return {
    histograms,
    sizes,
    k: opts.k ?? DEFAULT_K,
    period: opts.period ?? 1,
    members: opts.members ?? total,
    submissions: opts.submissions ?? total,
    // Fabricated ledger inventory consistent with the sizes above.
    inventory: {
      groups: [...sizes.entries()]
        .filter(([, n]) => n > 0)
        .map(([keyHex, size]) => ({ keyHex, size })),
      totalParticipants: total,
      publishable: [...sizes.values()].filter((n) => n >= (opts.k ?? DEFAULT_K)).length,
      members: opts.members ?? total,
      submissions: opts.submissions ?? total,
      epoch: opts.period ?? 1,
      k: opts.k ?? DEFAULT_K,
    },
  };
}

describe("assertNoSmallCellLeak", () => {
  const clean = buildReport(
    [
      {
        category: "ok",
        reference: { total: hist(5, 3), base: hist(5, 3), variable: new Array(BUCKET_COUNT).fill(0) },
        comparison: { total: hist(6, 3), base: hist(6, 3), variable: new Array(BUCKET_COUNT).fill(0) },
      },
    ],
    { period: "p", generatedAt: "g" },
  );

  it("passes a report whose rows all clear k", () => {
    expect(() => assertNoSmallCellLeak(clean, DEFAULT_K)).not.toThrow();
  });

  it("throws when a row slipped through below the threshold", () => {
    const leaked = buildReport(
      [
        {
          category: "ENG · Base salary",
          reference: { total: hist(2, 3), base: hist(2, 3), variable: new Array(BUCKET_COUNT).fill(0) },
          comparison: { total: hist(6, 3), base: hist(6, 3), variable: new Array(BUCKET_COUNT).fill(0) },
        },
      ],
      // k=2 so the engine itself emits the row…
      { period: "p", generatedAt: "g", k: 2 },
    );
    expect(leaked.rows).toHaveLength(1);
    // …and the assertion catches it against the contract's real threshold.
    expect(() => assertNoSmallCellLeak(leaked, DEFAULT_K)).toThrow(/disclosure control violated/);
  });

  it("names the offending category and both group sizes, so the failure is diagnosable", () => {
    const leaked = buildReport(
      [
        {
          category: "ENG · Base salary",
          reference: { total: hist(2, 3), base: hist(2, 3), variable: new Array(BUCKET_COUNT).fill(0) },
          comparison: { total: hist(9, 3), base: hist(9, 3), variable: new Array(BUCKET_COUNT).fill(0) },
        },
      ],
      { period: "p", generatedAt: "g", k: 2 },
    );
    try {
      assertNoSmallCellLeak(leaked, DEFAULT_K);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("ENG · Base salary");
      expect(msg).toContain("2, 9");
      expect(msg).toContain("k=5");
    }
  });
});

describe("assertSuppressedAreEmpty", () => {
  it("flags a group marked empty that actually holds counts", () => {
    const report = buildReport(
      [
        {
          category: "ENG · Base salary",
          reference: { total: hist(9, 3), base: hist(9, 3), variable: new Array(BUCKET_COUNT).fill(0) },
          comparison: { total: hist(9, 3), base: hist(9, 3), variable: new Array(BUCKET_COUNT).fill(0) },
        },
      ],
      { period: "p", generatedAt: "g" },
    );
    const histograms = new Map([["ENG · Base salary", hist(9, 3)]]);
    // Sanity: the report has no suppressed rows, so nothing to check.
    expect(() => assertSuppressedAreEmpty(report, histograms)).not.toThrow();

    const withSuppressed = { ...report, suppressed: [{ category: "X", reason: "no-data" as const, size: 0 }] };
    expect(() => assertSuppressedAreEmpty(withSuppressed, new Map([["X", hist(3, 3)]]))).toThrow(
      /marked no-data but has counts/,
    );
  });

  it("does not flag a below-k suppression, which legitimately has data", () => {
    const report = buildReport(
      [
        {
          category: "ENG · Base salary",
          reference: { total: hist(9, 3), base: hist(9, 3), variable: new Array(BUCKET_COUNT).fill(0) },
          comparison: { total: hist(9, 3), base: hist(9, 3), variable: new Array(BUCKET_COUNT).fill(0) },
        },
      ],
      { period: "p", generatedAt: "g" },
    );
    const belowK = {
      ...report,
      suppressed: [{ category: "SAL", reason: "below-k-anonymity-threshold" as const, size: 2 }],
    };
    expect(() => assertSuppressedAreEmpty(belowK, new Map([["SAL", hist(2, 3)]]))).not.toThrow();
  });
});

describe("assembleArt9Report", () => {
  it("publishes a category where both genders clear k", () => {
    const bundle = assembleArt9Report({
      categories: CATEGORIES,
      reading: readingFor({
        counts: {
          [`${groupOf("engineering", GENDER.FEMALE, COMPONENT.BASE).categoryId}:${GENDER.FEMALE}:${COMPONENT.BASE}`]: 6,
          [`${groupOf("engineering", GENDER.MALE, COMPONENT.BASE).categoryId}:${GENDER.MALE}:${COMPONENT.BASE}`]: 7,
        },
      }),
      periodLabel: "FY2026",
      generatedAt: "2026-10-01",
    });

    expect(bundle.report.rows).toHaveLength(1);
    expect(bundle.report.rows[0].category).toContain("Base salary");
    expect(bundle.report.rows[0].reference.size).toBe(6);
    expect(bundle.report.rows[0].comparison.size).toBe(7);
    expect(bundle.publishableGroups).toBeGreaterThan(0);
  });

  it("withholds a category where one gender is below k", () => {
    const bundle = assembleArt9Report({
      categories: CATEGORIES,
      reading: readingFor({
        counts: {
          [`${groupOf("engineering", GENDER.FEMALE, COMPONENT.BASE).categoryId}:${GENDER.FEMALE}:${COMPONENT.BASE}`]: 8,
          [`${groupOf("engineering", GENDER.MALE, COMPONENT.BASE).categoryId}:${GENDER.MALE}:${COMPONENT.BASE}`]: 1,
        },
      }),
      periodLabel: "FY2026",
      generatedAt: "2026-10-01",
    });

    // One side of the comparison is below k, so nothing is published for it:
    // a one-sided row would reveal the other side by subtraction.
    expect(bundle.report.rows).toHaveLength(0);
    expect(bundle.report.suppressed.length).toBeGreaterThan(0);
    expect(bundle.suppressedGroups).toBeGreaterThan(0);
  });

  it("does not mix base salary with variable pay in the same comparison", () => {
    // Art. 9(1)(b) requires the split. If base and variable were combined, a
    // large base group would carry a small variable group across the threshold.
    const bundle = assembleArt9Report({
      categories: CATEGORIES,
      reading: readingFor({
        counts: {
          [`${groupOf("engineering", GENDER.FEMALE, COMPONENT.BASE).categoryId}:${GENDER.FEMALE}:${COMPONENT.BASE}`]: 9,
          [`${groupOf("engineering", GENDER.MALE, COMPONENT.BASE).categoryId}:${GENDER.MALE}:${COMPONENT.BASE}`]: 9,
          [`${groupOf("engineering", GENDER.FEMALE, COMPONENT.VARIABLE).categoryId}:${GENDER.FEMALE}:${COMPONENT.VARIABLE}`]: 1,
          [`${groupOf("engineering", GENDER.MALE, COMPONENT.VARIABLE).categoryId}:${GENDER.MALE}:${COMPONENT.VARIABLE}`]: 1,
        },
      }),
      periodLabel: "FY2026",
      generatedAt: "2026-10-01",
    });

    const baseRows = bundle.report.rows.filter((r) => r.category.includes("Base salary"));
    const variableRows = bundle.report.rows.filter((r) => r.category.includes("Variable"));
    expect(baseRows).toHaveLength(1);
    expect(variableRows).toHaveLength(0);
  });

  it("takes k from the contract, not from a constant", () => {
    const bundle = assembleArt9Report({
      categories: CATEGORIES,
      reading: readingFor({
        k: 8,
        counts: {
          [`${groupOf("engineering", GENDER.FEMALE, COMPONENT.BASE).categoryId}:${GENDER.FEMALE}:${COMPONENT.BASE}`]: 6,
          [`${groupOf("engineering", GENDER.MALE, COMPONENT.BASE).categoryId}:${GENDER.MALE}:${COMPONENT.BASE}`]: 6,
        },
      }),
      periodLabel: "FY2026",
      generatedAt: "2026-10-01",
    });
    expect(bundle.k).toBe(8);
    // 6 < 8 under this contract's threshold, so nothing is publishable.
    expect(bundle.report.rows).toHaveLength(0);
  });

  it("reports coverage so an empty category is not read as equality", () => {
    const bundle = assembleArt9Report({
      categories: CATEGORIES,
      reading: readingFor({ counts: {} }),
      periodLabel: "FY2026",
      generatedAt: "2026-10-01",
    });
    const notes = bundle.report.notes.join(" ");
    expect(notes).toMatch(/voluntary/i);
    expect(notes).toMatch(/not evidence that pay is equal/i);
    expect(bundle.configuredGroups).toBe(12); // 2 categories x 3 genders x 2 components
    expect(bundle.publishableGroups).toBe(0);
  });

  it("produces markdown and JSON that both serialise cleanly", () => {
    const bundle = assembleArt9Report({
      categories: CATEGORIES,
      reading: readingFor({
        counts: {
          [`${groupOf("engineering", GENDER.FEMALE, COMPONENT.BASE).categoryId}:${GENDER.FEMALE}:${COMPONENT.BASE}`]: 6,
          [`${groupOf("engineering", GENDER.MALE, COMPONENT.BASE).categoryId}:${GENDER.MALE}:${COMPONENT.BASE}`]: 6,
        },
      }),
      periodLabel: "FY2026",
      generatedAt: "2026-10-01",
    });
    expect(() => JSON.parse(bundle.json)).not.toThrow();
    expect(bundle.json).not.toMatch(/Infinity|NaN/);
    expect(bundle.markdown).toContain("Disclosure notes");
  });
});

describe("group model", () => {
  it("enumerates every Art. 9 group an employer configures", () => {
    const groups = allGroups(CATEGORIES);
    expect(groups).toHaveLength(2 * 3 * 2);
    expect(new Set(groups.map(groupKeyHex)).size).toBe(groups.length);
  });

  it("gives every group a distinct hash key", () => {
    const keys = allGroups(CATEGORIES).map(groupKeyHex);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the same category label on the same key across genders", () => {
    // The label hash is the category; gender is a separate ledger dimension. If
    // these drifted apart the report would file figures under the wrong heading.
    const w = groupOf("engineering", GENDER.FEMALE, COMPONENT.BASE);
    const m = groupOf("engineering", GENDER.MALE, COMPONENT.BASE);
    expect(w.categoryKeyHex).toBe(m.categoryKeyHex);
    expect(groupKeyHex(w)).not.toBe(groupKeyHex(m));
  });
});
describe("illustrative sample report", () => {
  it("is labelled unmistakably as not a filing", () => {
    const bundle = sampleArt9Report(CATEGORIES);
    const notes = bundle.report.notes.join(" ");
    expect(notes).toMatch(/ILLUSTRATIVE/i);
    expect(notes).toMatch(/NOT read from the ledger/i);
    expect(notes).toMatch(/never be filed/i);
    expect(bundle.report.period).toMatch(/SAMPLE/i);
  });

  it("still passes the disclosure-control assertion", () => {
    // Sample data must obey the same gate as live data. A demo that leaks a
    // small cell would be worse than no demo.
    const bundle = sampleArt9Report(CATEGORIES);
    expect(() => assertNoSmallCellLeak(bundle.report, bundle.k)).not.toThrow();
  });

  it("demonstrates the three things worth showing: a material gap, a suppression, and a split component", () => {
    const bundle = sampleArt9Report(CATEGORIES);

    // at least one publishable row, flagged at the 5% threshold
    expect(bundle.report.rows.length).toBeGreaterThan(0);
    expect(bundle.report.rows.some((r) => r.gap?.material)).toBe(true);
    // something withheld
    expect(bundle.report.suppressed.length).toBeGreaterThan(0);
    // base and variable are separate categories in the output
    expect(bundle.report.rows.some((r) => r.category.includes("Base salary"))).toBe(true);
  });
});

describe("v2 contract address is a separate key from v1", () => {
  // A v2 deploy must never repoint the live report. If these shared a key, one
  // `localStorage.setItem` would silently swap the report's source ledger.
  it("reads v2 from its own storage key, defaulting to null when unset", () => {
    expect(getStoredV2ContractAddress()).toBeNull();
    // v1 has a baked address in this build; v2 is not deployed yet.
    expect(getStoredV2ContractAddress()).not.toBe(getStoredContractAddress());
  });
});
