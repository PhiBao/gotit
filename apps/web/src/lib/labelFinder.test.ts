import { describe, it, expect } from "vitest";
import { probeLabel, searchLabels, groupCountsFromLedger, suggestedCandidates } from "./labelFinder";
import { categoryKeyBytes, groupKeyBytes, bytesToHex } from "@gotit/shared/hash";
import { GENDER, COMPONENT } from "@gotit/shared/paygap";

/**
 * The situation these tests are for: five submissions on a contract, and a report
 * looking for four labels that are not among them. `hash(label)` is one-way, so
 * the ledger cannot name what it holds — but a candidate can be TESTED, which is
 * what turns "no data" into "that label does exist, under Women/Base".
 */

/** Build the on-chain map a contract would have after these submissions. */
function chainWith(entries: Array<{ label: string; gender: number; component: number; n: number }>) {
  const m = new Map<string, number>();
  for (const e of entries) {
    const k = bytesToHex(groupKeyBytes(categoryKeyBytes(e.label), e.gender, e.component));
    m.set(k, (m.get(k) ?? 0) + e.n);
  }
  return m;
}

describe("probeLabel", () => {
  it("finds a label that is on chain, and says which groups exist", () => {
    const chain = chainWith([
      { label: "Entrepreneur/Dr..", gender: GENDER.FEMALE, component: COMPONENT.BASE, n: 5 },
    ]);
    const r = probeLabel("Entrepreneur/Dr..", chain);
    expect(r.matched).toBe(true);
    expect(r.participants).toBe(5);
    expect(r.groupsPresent).toBe(1);

    const womenBase = r.probes.find(
      (p) => p.gender === GENDER.FEMALE && p.component === COMPONENT.BASE,
    )!;
    expect(womenBase.size).toBe(5);
    // And the groups that are NOT there are reported as absent rather than omitted,
    // because "women have data, men do not" is the next thing the user needs.
    const menBase = r.probes.find((p) => p.gender === GENDER.MALE && p.component === COMPONENT.BASE)!;
    expect(menBase.present).toBe(false);
  });

  it("reports a miss without pretending it is an error", () => {
    const chain = chainWith([{ label: "engineering", gender: 0, component: 0, n: 9 }]);
    const r = probeLabel("salespeople", chain);
    expect(r.matched).toBe(false);
    expect(r.participants).toBe(0);
    expect(r.probes).toHaveLength(6); // still reports the split, all zero
  });

  it("is case-sensitive, because the hash is", () => {
    // "Sales" and "sales" are different hashes and therefore different groups.
    // Being lenient here would hide the exact mistake that causes the problem.
    const chain = chainWith([{ label: "Sales", gender: 0, component: 0, n: 4 }]);
    expect(probeLabel("Sales", chain).participants).toBe(4);
    expect(probeLabel("sales", chain).participants).toBe(0);
  });

  it("does not match a label the circuit would have rejected", () => {
    const chain = chainWith([{ label: "ok", gender: 0, component: 0, n: 1 }]);
    const r = probeLabel("x".repeat(40), chain);
    expect(r.matched).toBe(false);
    expect(r.probes).toEqual([]);
  });

  it("ignores surrounding whitespace, matching how the submit form trims", () => {
    const chain = chainWith([{ label: "sales", gender: 0, component: 0, n: 3 }]);
    expect(probeLabel("  sales  ", chain).participants).toBe(3);
  });
});

describe("searchLabels", () => {
  it("ranks the label that explains the data first", () => {
    const chain = chainWith([
      { label: "Entrepreneur/Dr..", gender: 0, component: 0, n: 5 },
    ]);
    const r = searchLabels(["engineering", "sales", "Entrepreneur/Dr.."], chain);
    expect(r[0].label).toBe("Entrepreneur/Dr..");
    expect(r[0].participants).toBe(5);
    expect(r.filter((x) => x.matched)).toHaveLength(1);
  });

  it("deduplicates candidates case-insensitively", () => {
    const chain = chainWith([{ label: "sales", gender: 0, component: 0, n: 1 }]);
    const r = searchLabels(["sales", " sales ", "Sales"], chain);
    // "sales" twice collapses; "Sales" is a distinct hash and is kept.
    expect(r.map((x) => x.label).sort()).toEqual(["Sales", "sales"]);
  });
});

describe("groupCountsFromLedger", () => {
  it("reads the generated map into hex keys", () => {
    const m = new Map<Uint8Array, bigint>();
    const key = groupKeyBytes(categoryKeyBytes("engineering"), 0, 0);
    m.set(key, 7n);
    const out = groupCountsFromLedger({ groupCount: m });
    expect(out.get(bytesToHex(key))).toBe(7);
  });

  it("unwraps boxed values and skips empties", () => {
    const key = groupKeyBytes(categoryKeyBytes("engineering"), 0, 0);
    const m = new Map<Uint8Array, any>([[key, { value: 4n }]]);
    const out = groupCountsFromLedger({ groupCount: m });
    expect(out.get(bytesToHex(key))).toBe(4);
    expect(out.size).toBe(1);
  });

  it("returns nothing for a ledger without groupCount, rather than throwing", () => {
    expect(groupCountsFromLedger({}).size).toBe(0);
    expect(groupCountsFromLedger(null).size).toBe(0);
  });
});

describe("suggestedCandidates", () => {
  it("includes configured labels and what was submitted on this device", () => {
    const s = suggestedCandidates(["engineering"], ["Entrepreneur/Dr.."]);
    expect(s).toContain("engineering");
    expect(s).toContain("Entrepreneur/Dr..");
  });

  it("offers case and plural variations, because those are the easy slips", () => {
    const s = suggestedCandidates(["sales"], []);
    expect(s).toContain("sales");
    expect(s).toContain("Sales");
    expect(s).toContain("saless".replace("saless", "sales" + "s"));
  });
});
