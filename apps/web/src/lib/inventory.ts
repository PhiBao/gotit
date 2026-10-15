/**
 * What is actually on the contract, independent of any label guess.
 *
 * THE QUESTION THIS ANSWERS. A report built from a category list shows zeros for
 * two very different reasons:
 *
 *   1. nobody submitted anything                       (an empty ledger)
 *   2. people submitted under labels the list does not contain
 *
 * Both render as `no-data · 0 participants`, and the report could not previously
 * tell them apart. That is intolerable in a compliance product: "we found nothing"
 * and "we looked in the wrong place" are different statements, and only one of
 * them is a finding.
 *
 * The ledger cannot resolve this by itself — it keys groups by `hash(label)` and
 * holds no names — but it CAN be counted. `groupCount` is a public map, so its
 * entries can be enumerated and totalled without knowing a single label. That
 * total is the evidence:
 *
 *   groups with data > 0, none matching the configured labels
 *      -> the submissions exist, under labels this report is not looking for
 *   groups with data == 0
 *      -> the contract really is empty, or it is not the contract that was
 *         submitted to
 *
 * So the diagnostic counts what is there. It cannot say which labels were used,
 * because that is one-way, which is exactly why the label list is published in
 * the report rather than derived.
 */

/** One reporting group found in raw ledger state. */
export type ChainGroup = {
  /** The group key, as stored: hash(categoryKey, gender, component). */
  keyHex: string;
  /** Participants in it. Public state, already visible in the indexer. */
  size: number;
};

export type ChainInventory = {
  /** Groups holding at least one submission. */
  groups: ChainGroup[];
  /** Total participants across every group, matching or not. */
  totalParticipants: number;
  /** How many of those groups clear the threshold. */
  publishable: number;
  /** Members enrolled on this contract. */
  members: number;
  /** Submissions recorded, which is what the nullifier set counts. */
  submissions: number;
  /** Period number. */
  epoch: number;
  /** Threshold the contract reports. */
  k: number;
};

/** Narrow view of the generated ledger, so this is testable without a chain. */
export type LedgerView = {
  groupCount: { [Symbol.iterator]?: unknown; entries?: () => Iterable<[Uint8Array, unknown]> };
  members?: { size?: () => bigint };
  nullifiers?: { size?: () => bigint };
};

function toNumber(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const inner = (v as any)?.value;
  if (typeof inner === "bigint") return Number(inner);
  if (typeof inner === "number") return inner;
  const n = Number(v as any);
  return Number.isFinite(n) ? n : 0;
}

/** Hex for a key that may arrive as bytes or already as a string. */
function keyHex(k: unknown): string {
  if (typeof k === "string") return k;
  if (k instanceof Uint8Array) {
    return Array.from(k).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return String(k);
}

/**
 * Enumerate every group the contract holds.
 *
 * Reads raw state, so it BYPASSES the anonymity gate — which is fine and is why
 * the result is used only to say "there are N groups with data, totalling M
 * participants". It must never become a source of a published figure. A group's
 * size is already public in the indexer for anyone who asks; the pay bands are
 * what the gate protects.
 */
export function inventoryChain(ledger: any, opts: { k: number; epoch: number }): ChainInventory {
  const groups: ChainGroup[] = [];
  let total = 0;
  let publishable = 0;

  const gc = ledger?.groupCount;
  if (gc) {
    // The generated `Map` exposes `entries`; fall back to iteration, because the
    // exact shape differs between the decoded ledger and a live object.
    let entries: Iterable<[unknown, unknown]> | null = null;
    try {
      if (typeof gc.entries === "function") entries = gc.entries();
      else if (typeof gc[Symbol.iterator] === "function") entries = gc as Iterable<[unknown, unknown]>;
    } catch {
      entries = null;
    }
    if (entries) {
      for (const [k, v] of entries) {
        const size = toNumber(v);
        if (size <= 0) continue;
        groups.push({ keyHex: keyHex(k), size });
        total += size;
        if (size >= opts.k) publishable += 1;
      }
    }
  }

  const sizeOf = (s: any): number => {
    try {
      return Number(typeof s?.size === "function" ? s.size() : 0);
    } catch {
      return 0;
    }
  };

  return {
    groups: groups.sort((a, b) => b.size - a.size),
    totalParticipants: total,
    publishable,
    members: sizeOf(ledger?.members),
    submissions: sizeOf(ledger?.nullifiers),
    epoch: opts.epoch,
    k: opts.k,
  };
}

export type InventoryVerdict = {
  /** Which of the two causes this looks like. */
  kind: "empty" | "label-mismatch" | "no-matching-data" | "unknown";
  /** One sentence a person can act on. */
  headline: string;
  /** What to do about it, when there is something. */
  action?: string;
};

/**
 * Turn an inventory into a verdict.
 *
 * The distinction that matters: `totalParticipants > 0` while no configured
 * group has data means the figures are there and unreadable, not absent. Telling
 * someone their ledger is empty when it holds twelve people is the kind of wrong
 * answer that gets a compliance product uninstalled.
 */
export function judgeInventory(
  inv: ChainInventory,
  configuredGroupsWithData: number,
): InventoryVerdict {
  if (inv.totalParticipants === 0) {
    return {
      kind: "empty",
      headline:
        "This contract holds no submissions at all — no reporting group has any participants.",
      action:
        "If you submitted and expected to see them here, check the contract address above: a " +
        "submission is only visible on the contract it was sent to.",
    };
  }

  if (configuredGroupsWithData === 0) {
    return {
      kind: "label-mismatch",
      headline:
        `This contract holds ${inv.groups.length} reporting group` +
        `${inv.groups.length === 1 ? "" : "s"} with ${inv.totalParticipants} participant` +
        `${inv.totalParticipants === 1 ? "" : "s"} in total, but none of them match the category ` +
        `labels this report is looking for.`,
      action:
        "The ledger keys a group by hash(label), so a submission filed under a different label is " +
        "a different group and is invisible here. Press Categories and add the label you submitted " +
        "under — or, if you no longer know it, submit again under a label from the list.",
    };
  }

  return {
    kind: "no-matching-data",
    headline:
      `${configuredGroupsWithData} configured reporting group` +
      `${configuredGroupsWithData === 1 ? "" : "s"} carr` +
      `${configuredGroupsWithData === 1 ? "ies" : "y"} data, but no category has both a women and ` +
      `a men group at or above k=${inv.k}.`,
    action:
      "Art. 9 compares women with men inside one category, so a category with data on one side " +
      "only cannot be reported — publishing one side would reveal the other by subtraction.",
  };
}
