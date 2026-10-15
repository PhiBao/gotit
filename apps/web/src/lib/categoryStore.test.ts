import { describe, it, expect } from "vitest";
import {
  validateLabel,
  parseCategoryText,
  mergeCategories,
  labelBytes,
  DEFAULT_CATEGORIES,
  CATEGORY_LABEL_MAX_BYTES,
} from "./categoryStore";

/**
 * The failure these tests exist for: five submissions filed under
 * "Entrepreneur/Dr.." while the report searched for engineering, sales,
 * operations and management. Every row read `no-data · 0 participants`, and
 * nothing was broken — the two screens disagreed about a name, and the ledger
 * cannot report that because it never stored the name, only its hash.
 */

describe("validateLabel", () => {
  it("accepts a normal job family", () => {
    expect(validateLabel("engineering")).toEqual({ ok: true, label: "engineering" });
  });

  it("trims, so 'sales ' and 'sales' are one group and not two", () => {
    // Two labels differing only in whitespace are two different hashes, which
    // would split a headcount and could push a category under k.
    expect(validateLabel("  sales  ")).toEqual({ ok: true, label: "sales" });
  });

  it("rejects an empty label", () => {
    const r = validateLabel("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects anything over 32 bytes and says how long it was", () => {
    const long = "x".repeat(CATEGORY_LABEL_MAX_BYTES + 1);
    const r = validateLabel(long);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/33 bytes/);
    expect(r.ok === false && r.reason).toMatch(/at most 32/);
  });

  it("counts bytes, not characters, because the circuit counts bytes", () => {
    // 11 characters, 33 bytes in UTF-8. A character count would let this through
    // and it would fail in the prover instead.
    const emoji = "é".repeat(17);
    expect(emoji.length).toBe(17);
    expect(labelBytes(emoji)).toBe(34);
    expect(validateLabel(emoji).ok).toBe(false);
  });

  it("accepts exactly 32 bytes", () => {
    expect(validateLabel("x".repeat(32)).ok).toBe(true);
  });

  it("accepts the label that caused the confusion", () => {
    // "Entrepreneur/Dr.." is a perfectly valid category. The bug was never that
    // it was invalid — it was that the report was not looking for it.
    expect(validateLabel("Entrepreneur/Dr..")).toEqual({ ok: true, label: "Entrepreneur/Dr.." });
  });
});

describe("parseCategoryText", () => {
  it("splits on newlines and commas", () => {
    const { categories } = parseCategoryText("engineering\nsales, operations");
    expect(categories.map((c) => c.label)).toEqual(["engineering", "sales", "operations"]);
  });

  it("deduplicates case-insensitively, because two casings are two hashes", () => {
    const { categories } = parseCategoryText("Sales\nsales\nSALES");
    expect(categories).toHaveLength(1);
  });

  it("reports problems instead of silently dropping bad labels", () => {
    const { categories, problems } = parseCategoryText(`ok\n${"x".repeat(40)}`);
    expect(categories.map((c) => c.label)).toEqual(["ok"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/at most 32/);
  });

  it("returns nothing for empty input rather than a broken entry", () => {
    expect(parseCategoryText("   \n , \n").categories).toEqual([]);
  });
});

describe("mergeCategories", () => {
  it("keeps configured categories and adds ones that were actually used", () => {
    // A category with real people in it that nobody configured must still appear,
    // or the report understates coverage by omitting a group silently.
    const merged = mergeCategories(DEFAULT_CATEGORIES, ["Entrepreneur/Dr.."]);
    expect(merged.map((c) => c.label)).toContain("Entrepreneur/Dr..");
    expect(merged.map((c) => c.label)).toContain("engineering");
  });

  it("does not duplicate a used category that is already configured", () => {
    const merged = mergeCategories(DEFAULT_CATEGORIES, ["engineering", "Engineering"]);
    expect(merged.filter((c) => c.label.toLowerCase() === "engineering")).toHaveLength(1);
  });

  it("ignores an unusable used label rather than throwing", () => {
    const merged = mergeCategories(DEFAULT_CATEGORIES, ["x".repeat(40), "fine"]);
    expect(merged.map((c) => c.label)).toContain("fine");
    expect(merged.some((c) => c.label.length > 40)).toBe(false);
  });
});

describe("the defaults agree with the contribution form", () => {
  it("is the list a first-time run should expect", () => {
    // The two screens must not disagree out of the box; that was the bug.
    expect(DEFAULT_CATEGORIES.map((c) => c.label)).toEqual([
      "engineering",
      "sales",
      "operations",
      "management",
    ]);
  });

  it("gives every default a usable label", () => {
    for (const c of DEFAULT_CATEGORIES) {
      expect(validateLabel(c.label).ok).toBe(true);
    }
  });
});
