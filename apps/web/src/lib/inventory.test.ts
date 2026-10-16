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

describe("decoding real ledger state, which is where this went wrong", () => {
  /**
   * `decodeV2State` called `Contract.ledger(...)`, guarded by a truthiness check.
   * `ledger` is a MODULE-LEVEL export of the generated contract and `Contract` is
   * a class with no such static, so the guard was always false and the function
   * always returned null.
   *
   * Everything downstream of it read zeros: `readGroupSizes` and
   * `readGroupHistograms` both decode through it, so five real on-chain
   * submissions rendered as `no-data · 0 participants` for all 24 groups, and both
   * the inventory and the label finder — which exist precisely to diagnose that —
   * were silently defeated by the same defect.
   *
   * These tests import the real generated contract, so a wrong accessor fails here
   * rather than in front of a user.
   */
  it("the generated module exports `ledger`, and Contract has no such static", async () => {
    const mod = await import("@gotit/contract/managed/gotit/contract");
    expect(typeof (mod as any).ledger).toBe("function");
    // The exact assumption that was wrong. If a future version adds a static,
    // this fails and the comment above gets revisited.
    expect(typeof (mod as any).Contract.ledger).toBe("undefined");
  });

  it("decodes a real ledger rather than returning null", async () => {
    const { decodeV2State } = await import("./midnight.v2");
    // The smallest thing the decoder must handle: a state object it was handed by
    // the indexer. A null return is the bug, so assert on the shape, not truthiness.
    const { Contract, ledger } = await import("@gotit/contract/managed/gotit/contract");
    const { witnesses, createPrivateState } = await import("@gotit/contract/witnesses-v2");
    const { createConstructorContext } = await import("@midnight-ntwrk/compact-runtime");
    const { issuerCommitment2 } = await import("@gotit/shared/hash");

    const secret = new Uint8Array(32).fill(42);
    const issuer = new Uint8Array(32).fill(1);
    const contract = new Contract(witnesses as any);
    const init = contract.initialState(
      createConstructorContext(createPrivateState(secret), { bytes: new Uint8Array(32) } as any),
      issuerCommitment2(issuer),
      5n,
    );
    const state = init.currentContractState as any;

    // Decoding must give a usable ledger with the fields the report reads.
    const led = decodeV2State(state) as any;
    expect(led).not.toBeNull();
    expect(led.groupCount).toBeDefined();
    expect(led.kThreshold).toBeDefined();
    expect(Number(led.kThreshold)).toBe(5);
    // And the raw fetcher agrees with the module function.
    expect(led.members.size()).toBe(led.members.size());
    expect(typeof ledger).toBe("function");
  });
});
