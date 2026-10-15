import { describe, it, expect } from "vitest";
import { inventoryChain, judgeInventory, type ChainInventory } from "./inventory";

/**
 * The case these tests exist for: five submissions were made, and the report
 * showed `no-data · 0 participants` for every group. Both "nobody submitted" and
 * "everybody submitted under a label this report is not looking for" render
 * identically, and the report could not tell them apart.
 *
 * The inventory counts what is on the contract without knowing a single label,
 * because `groupCount` is a public map whose entries can be enumerated.
 */

/** A fake decoded ledger with the shape the generated decoder produces. */
function ledger(groups: Array<[string, number]>, members = 0, nullifiers = 0) {
  const map = new Map<string, bigint>();
  for (const [k, v] of groups) map.set(k, BigInt(v));
  return {
    groupCount: map,
    members: { size: () => BigInt(members) },
    nullifiers: { size: () => BigInt(nullifiers) },
  };
}

describe("inventoryChain", () => {
  it("counts groups and participants without knowing any label", () => {
    // The point: no label is involved. hash(label) is one-way, but the count is
    // public, and the count is what distinguishes the two causes.
    const inv = inventoryChain(
      ledger([["aa", 5], ["bb", 7], ["cc", 3]], 12, 15),
      { k: 5, epoch: 1 },
    );
    expect(inv.groups).toHaveLength(3);
    expect(inv.totalParticipants).toBe(15);
    expect(inv.publishable).toBe(2); // aa and bb clear k=5, cc does not
    expect(inv.members).toBe(12);
    expect(inv.submissions).toBe(15);
  });

  it("is empty for a contract nobody has touched", () => {
    const inv = inventoryChain(ledger([]), { k: 5, epoch: 1 });
    expect(inv.groups).toEqual([]);
    expect(inv.totalParticipants).toBe(0);
  });

  it("ignores zero-valued cells rather than counting empty groups", () => {
    const inv = inventoryChain(ledger([["aa", 0], ["bb", 4]]), { k: 5, epoch: 1 });
    expect(inv.groups).toHaveLength(1);
    expect(inv.totalParticipants).toBe(4);
  });

  it("sorts by size, so the largest groups are readable first", () => {
    const inv = inventoryChain(ledger([["a", 2], ["b", 9], ["c", 5]]), { k: 5, epoch: 1 });
    expect(inv.groups.map((g) => g.size)).toEqual([9, 5, 2]);
  });

  it("survives a ledger with no such fields instead of throwing", () => {
    // A v1 contract has no groupCount; the caller needs to be told "nothing
    // here", not to crash while finding out.
    expect(() => inventoryChain({}, { k: 5, epoch: 1 })).not.toThrow();
    expect(inventoryChain({}, { k: 5, epoch: 1 }).totalParticipants).toBe(0);
  });

  it("handles boxed values, which is how the decoder returns them", () => {
    const boxed = {
      groupCount: new Map<string, any>([["aa", { value: 6n }]]),
      members: { size: () => 6n },
      nullifiers: { size: () => 6n },
    };
    expect(inventoryChain(boxed, { k: 5, epoch: 1 }).totalParticipants).toBe(6);
  });
});

describe("judgeInventory", () => {
  const inv = (over: Partial<ChainInventory> = {}): ChainInventory => ({
    groups: [],
    totalParticipants: 0,
    publishable: 0,
    members: 0,
    submissions: 0,
    epoch: 1,
    k: 5,
    ...over,
  });

  it("says empty only when the contract really holds nothing", () => {
    const v = judgeInventory(inv(), 0);
    expect(v.kind).toBe("empty");
    expect(v.headline).toMatch(/no submissions at all/);
    // And points at the address, because the other cause of a truly empty read
    // is reading the wrong contract.
    expect(v.action).toMatch(/contract address/i);
  });

  it("NAMES THE REAL CAUSE when figures exist under other labels", () => {
    // This is the diagnosis that was missing: 15 participants on chain, none
    // matching the configured labels.
    const v = judgeInventory(
      inv({ groups: [{ keyHex: "aa", size: 9 }, { keyHex: "bb", size: 6 }], totalParticipants: 15, publishable: 2 }),
      0,
    );
    expect(v.kind).toBe("label-mismatch");
    expect(v.headline).toMatch(/2 reporting groups/);
    expect(v.headline).toMatch(/15 participants/);
    expect(v.headline).toMatch(/none of them match the category labels/);
    expect(v.action).toMatch(/hash\(label\)/);
  });

  it("does not claim a label mismatch when configured groups do match", () => {
    const v = judgeInventory(
      inv({ groups: [{ keyHex: "aa", size: 9 }], totalParticipants: 9, publishable: 1 }),
      1,
    );
    expect(v.kind).toBe("no-matching-data");
    expect(v.headline).toMatch(/both a women and a men group/);
  });

  it("uses the singular correctly, because a report is read by people", () => {
    const v = judgeInventory(
      inv({ groups: [{ keyHex: "aa", size: 1 }], totalParticipants: 1, publishable: 0 }),
      0,
    );
    expect(v.headline).toMatch(/1 reporting group with 1 participant in total/);
  });
});
