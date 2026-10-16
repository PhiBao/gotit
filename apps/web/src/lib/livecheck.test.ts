import { describe, it, expect } from "vitest";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";

/**
 * Exercises the app's real read path against the LIVE deployed contract.
 *
 * Skipped unless MIDNIGHT_INDEXER is set, because a unit suite must not depend on
 * a network. Run it deliberately with:
 *
 *   MIDNIGHT_INDEXER=... MIDNIGHT_INDEXER_WS=... pnpm --filter @gotit/web test livecheck
 */
const INDEXER = process.env.MIDNIGHT_INDEXER;
const ADDRESS = process.env.CHECK_CONTRACT ?? "";

describe.skipIf(!INDEXER || !ADDRESS)("live contract read path", () => {
  it("reads group sizes through the same code the report uses", async () => {
    const provider = indexerPublicDataProvider(INDEXER!, INDEXER!.replace(/^https/, "wss"));
    const state = await provider.queryContractState(ADDRESS as any);
    expect(state).toBeTruthy();

    const { decodeV2State } = await import("./midnight.v2");
    const led = decodeV2State((state as any).data ?? state) as any;
    console.log("decoded ledger:", led === null ? "NULL <-- the bug" : Object.keys(led));
    expect(led).not.toBeNull();

    const { allGroups, readGroupSizes, groupKeyHex } = await import("./groups");
    const groups = allGroups([
      { id: "engineering", label: "engineering" },
      { id: "sales", label: "sales" },
    ]);
    const sizes = readGroupSizes((state as any).data ?? state, groups);
    const nonZero: string[] = [];
    for (const g of groups) {
      const n = sizes.get(groupKeyHex(g)) ?? 0;
      if (n > 0) nonZero.push(`${g.categoryLabel}/${g.gender}/${g.component}=${n}`);
    }
    console.log("groups with data:", nonZero.length ? nonZero.join(", ") : "(none)");
    expect(nonZero.length).toBeGreaterThan(0);
  }, 60_000);
});
