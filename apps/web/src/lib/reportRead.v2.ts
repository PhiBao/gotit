/**
 * Live reads for the Wave 2 (v2) contract, and the report/verify surface built
 * on top of them.
 *
 * This is the ONLY place the app sources published figures for v2, and it makes
 * a deliberate split:
 *
 *   - SHAPE reads go through raw ledger state. They answer "which configured
 *     groups have data" and "how big are they" — needed because the report has
 *     to report coverage honestly.
 *   - PUBLISHED figures must come from `getHistogram`, the contract's own gated
 *     read circuit, which returns 0 below the anonymity threshold.
 *
 * `assertNoSmallCellLeak` runs after assembly as the backstop, so a mistake in
 * this split fails loudly instead of filing wrong numbers.
 */
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { asContractAddress } from "@midnight-ntwrk/midnight-js-types";
import { BUCKET_COUNT } from "@gotit/shared";
import { DEFAULT_K, GENDER, COMPONENT } from "@gotit/shared/paygap";
import {
  allGroups,
  categoryKey,
  categoryKeyHex,
  groupKeyHex,
  readGroupHistograms,
  readGroupSizes,
  type JobCategory,
} from "./groups";
import { assembleArt9Report, type Art9ReportBundle } from "./art9";
import { connectGatedReader } from "./midnight.v2";
import { crossCheckGroup } from "./gatedLogic";

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
const INDEXER_HTTP = `${ORIGIN}/indexer/api/v4/graphql`;
const INDEXER_WS = `${ORIGIN.replace(/^http/, "ws")}/indexer/api/v4/graphql/ws`;

const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

export type V2StateShape = {
  epoch: number;
  members: number;
  submissions: number;
  k: number;
};

/** Read the v2 ledger's shape. Uses the generated v2 decoder. */
export async function readV2Shape(contractAddress: string): Promise<V2StateShape> {
  const state = await withTimeout(
    provider.queryContractState(asContractAddress(contractAddress) as any),
    15_000,
  );
  if (!state) throw new Error("contract state not found on indexer");

  const led = (await import("@gotit/contract/managed/gotit/contract")).ledger(
    (state as any).data ?? state,
  );
  // A v1 contract has no groupCount / kThreshold. Detecting that here gives a
  // precise error instead of a confusing "cannot read property of undefined".
  if (!led || !(led as any).groupCount || (led as any).kThreshold === undefined) {
    throw new Error(
      "This contract has no v2 ledger state (no groupCount / kThreshold). " +
        "It is likely the Wave 1 contract, which predates the Art. 9 dimensions.",
    );
  }

  const raw = (state as any).data ?? state;
  return {
    epoch: Number(led.epochCount.lookup(new Uint8Array([101])) ?? 0),
    members: Number(led.members.size()),
    submissions: Number(led.nullifiers.size()),
    // lookup THROWS for an unwritten cell rather than returning 0.
    k: readKFromLedger(led),
    raw,
  } as V2StateShape & { raw: unknown };
}

function readKFromLedger(led: any): number {
  try {
    const v = (led as any).kThreshold;
    if (v === undefined) return DEFAULT_K;
    return Number(typeof v === "bigint" ? v : v?.value ?? v);
  } catch {
    return DEFAULT_K;
  }
}

/**
 * Build the Art. 9 report from live v2 state.
 *
 * Every PUBLISHED figure is read through the contract's `getHistogram` circuit,
 * which returns 0 for any group below the anonymity threshold. Raw ledger state
 * is used only to discover which groups exist and how large they are — the two
 * things the report needs in order to say what it withheld and why.
 *
 * That split is more than a convention here. `crossCheckGated` re-reads the
 * groups the raw state claims are publishable and asserts the two sources
 * agree. If a future change makes the app read raw state for a published figure
 * again, that check fails and the report throws instead of filing numbers that
 * bypass the gate. See art9.ts `assertNoSmallCellLeak` for the other half of
 * that backstop.
 */
export async function buildV2Report(
  contractAddress: string,
  categories: JobCategory[],
  periodLabel: string,
): Promise<{ bundle: Art9ReportBundle; fingerprint: string }> {
  const shape = (await readV2Shape(contractAddress)) as V2StateShape & { raw: unknown };
  const groups = allGroups(categories);

  // The threshold in force, from the contract's own circuit rather than a
  // constant, so the report states the number that was actually applied.
  const reader = await connectGatedReader(contractAddress, {
    indexerUri: INDEXER_HTTP,
    indexerWsUri: INDEXER_WS,
    proverServerUri: `${ORIGIN}/proof-server`,
  });
  const k = await reader.k();

  // PUBLISHED FIGURES: gated reads only.
  const gated = new Map<string, number[]>();
  const crossCheck = crossCheckGroups(shape.raw, groups, k);
  for (const g of groups) {
    const counts = crossCheckGroup({
      gated: await reader.histogram(categoryKey(g.categoryLabel), g.gender, g.component),
      raw: crossCheck.get(groupKeyHex(g)) ?? [],
      k,
      label: g.categoryLabel,
      gender: g.gender,
      component: g.component,
    });
    gated.set(groupKeyHex(g), counts);
  }

  const bundle = assembleArt9Report({
    categories,
    reading: {
      // gated histograms for the statistics.
      histograms: gated,
      // raw sizes for coverage and the suppression reason. Already public.
      sizes: readGroupSizes(shape.raw, groups),
      k,
      period: shape.epoch,
      members: shape.members,
      submissions: shape.submissions,
    },
    periodLabel,
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  const fingerprint = fingerprintV2({ ...shape, k }, groups, categories, gated);
  return { bundle, fingerprint };
}

function sum(h: number[]): number {
  return h.reduce((a, b) => a + b, 0);
}

/**
 * Raw-state counts for every group raw state claims clears k, keyed by group.
 *
 * Groups below k are deliberately absent: the contract returns 0 for them and
 * raw state returns the count, so the two cannot agree and there is nothing to
 * cross-check. The point of the exercise is to catch the opposite error — a
 * published figure sourced from raw state, which would be silently wrong.
 */
function crossCheckGroups(
  raw: unknown,
  groups: ReturnType<typeof allGroups>,
  k: number,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const sizes = readGroupSizes(raw, groups);
  for (const g of groups) {
    const size = sizes.get(groupKeyHex(g)) ?? 0;
    if (size < k) continue;
    const [counts] = readGroupHistograms(raw, [g]).values();
    if (counts) out.set(groupKeyHex(g), counts);
  }
  return out;
}

/**
 * Verification fingerprint over the exact inputs a report was built from.
 *
 * FNV-1a pair, hex. A checksum, not a security primitive: its job is to make
 * divergence between a published report and live chain state obvious and
 * trivially reproducible. Sorted so a re-read returning groups in a different
 * order still fingerprints identically.
 */
export function fingerprintV2(
  shape: V2StateShape,
  groups: ReturnType<typeof allGroups>,
  categories: JobCategory[],
  histograms?: Map<string, number[]>,
): string {
  const parts: string[] = [
    `epoch=${shape.epoch}`,
    `k=${shape.k}`,
    `members=${shape.members}`,
    `submissions=${shape.submissions}`,
  ];
  const rows: string[] = [];
  for (const g of groups) {
    const h = histograms?.get(groupKeyHex(g));
    rows.push(
      `${g.categoryId}:${g.gender}:${g.component}=[${(h ?? new Array(BUCKET_COUNT).fill(0)).join(",")}]`,
    );
  }
  rows.sort();
  parts.push(...rows);

  const s = parts.join("|");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export type V2Verification = {
  ok: boolean;
  expected: string;
  actual: string;
  period: number;
  submissions: number;
  k: number;
  checkedAt: string;
};

/** Re-read chain state and compare against a published report's fingerprint. */
export async function verifyV2Report(
  contractAddress: string,
  expectedFingerprint: string,
  categories: JobCategory[],
): Promise<V2Verification> {
  const shape = (await readV2Shape(contractAddress)) as V2StateShape & { raw: unknown };
  const groups = allGroups(categories);
  const reader = await connectGatedReader(contractAddress, {
    indexerUri: INDEXER_HTTP,
    indexerWsUri: INDEXER_WS,
    proverServerUri: `${ORIGIN}/proof-server`,
  });
  // Same source as the report: the gated read circuit. A verifier re-reads what
  // the report read, not a bypass path that happens to be cheaper.
  const histograms = new Map<string, number[]>();
  for (const g of groups) {
    histograms.set(
      groupKeyHex(g),
      await reader.histogram(categoryKey(g.categoryLabel), g.gender, g.component),
    );
  }
  const actual = fingerprintV2({ ...shape, k: await reader.k() }, groups, categories, histograms);
  return {
    ok: actual.toLowerCase() === expectedFingerprint.toLowerCase(),
    expected: expectedFingerprint,
    actual,
    period: shape.epoch,
    submissions: shape.submissions,
    k: shape.k,
    checkedAt: new Date().toISOString(),
  };
}

export { DEFAULT_K, GENDER, COMPONENT };
export { categoryKey, categoryKeyHex, groupKeyHex };
export type { JobCategory };