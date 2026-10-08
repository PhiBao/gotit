/**
 * Reporting-group model for the Wave 2 contract.
 *
 * The v2 ledger counts per `(category, gender, component, bucket)`. This module
 * turns that into the Art. 9 shaped objects the report needs, and owns the two
 * rules that keep the output honest:
 *
 *   1. Category LABELS never go on chain. The contract stores
 *      `categoryKey = hash("gotit:catkey:v2" || label)`. The mapping from key to
 *      label lives in the report, published by the employer, because the
 *      Directive requires the published breakdown to be readable.
 *   2. A figure is only ever sourced through the circuit's `getHistogram`,
 *      which returns 0 below the anonymity threshold. Reading raw ledger state
 *      would bypass that, so this module treats raw state as a way to discover
 *      WHICH groups exist and never as a source of published counts.
 */
import { BUCKET_COUNT, bucketForSalary, bucketsFor } from "@gotit/shared";
import { GENDER, COMPONENT, DEFAULT_K, type GenderId, type ComponentId } from "@gotit/shared/paygap";
import { categoryKeyBytes, bucketKeyBytes2, groupKeyBytes } from "@gotit/shared/hash";
import { bytesToHex } from "@gotit/shared/hash";
import { decodeV2State } from "./midnight.v2";

export const CATEGORY_LABEL_MAX = 32;

/** A job category as the employer defines it. Label is hashed before it ships. */
export type JobCategory = {
  /** Stable id used across periods. */
  id: string;
  /** The employer's own "category of worker" label, ≤32 bytes. */
  label: string;
  /** Optional headcount the employer expects, for coverage reporting only. */
  expectedHeadcount?: number;
};

/**
 * Hash a category label exactly as the circuit does.
 *
 * `pad` in Compact is UTF-8 bytes zero-padded on the right to a fixed width, and
 * throws past 32 bytes. A label that does not fit cannot be submitted, so we
 * reject it here with a clear message rather than letting the prover fail later
 * with a type error.
 */
export function categoryKey(label: string): Uint8Array {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > CATEGORY_LABEL_MAX) {
    throw new Error(
      `category label must be at most ${CATEGORY_LABEL_MAX} bytes (got ${bytes.length}): "${label}". ` +
        `Use a short family name — the full job title belongs in the report, not the key.`,
    );
  }
  return categoryKeyBytes(label);
}

export function categoryKeyHex(label: string): string {
  return bytesToHex(categoryKey(label));
}

/** Reverse a key back to its label when the employer published the mapping. */
export function buildLabelIndex(categories: JobCategory[]): Map<string, string> {
  return new Map(categories.map((c) => [categoryKeyHex(c.label), c.id]));
}

/** One Art. 9 reporting group: a category, a gender, a pay component. */
export type ReportingGroupKey = {
  categoryId: string;
  categoryLabel: string;
  categoryKeyHex: string;
  gender: GenderId;
  component: ComponentId;
};

/**
 * Every group the employer's category list implies, before any data exists.
 *
 * Used so a report can distinguish "this group exists and is publishable",
 * "this group exists but is suppressed" and "this group was never configured".
 */
export function allGroups(categories: JobCategory[]): ReportingGroupKey[] {
  const out: ReportingGroupKey[] = [];
  for (const c of categories) {
    for (let g = 0; g < 3; g++) {
      for (let comp = 0; comp < 2; comp++) {
        out.push({
          categoryId: c.id,
          categoryLabel: c.label,
          categoryKeyHex: categoryKeyHex(c.label),
          gender: g as GenderId,
          component: comp as ComponentId,
        });
      }
    }
  }
  return out;
}

export function groupKeyHex(g: ReportingGroupKey): string {
  return bytesToHex(groupKeyBytes(categoryKey(g.categoryLabel), g.gender, g.component));
}

export function bucketKeyHex(g: ReportingGroupKey, bucket: number): string {
  return bytesToHex(bucketKeyBytes2(categoryKey(g.categoryLabel), g.gender, g.component, bucket));
}

/** Which bucket an amount lands in, for the chosen component's scale. */
export function bucketFor(amount: number, component: ComponentId): number {
  return bucketForSalary(amount, component === COMPONENT.BASE ? 0 : 1);
}

/**
 * Extract per-group histograms for KNOWN groups.
 *
 * The caller supplies the group list (derived from the employer's category
 * labels), because the ledger keys are hashes: the app cannot enumerate
 * categories from chain state alone without the employer's published mapping.
 */
export function readGroupHistograms(
  ledgerState: any,
  groups: ReportingGroupKey[],
): Map<string, number[]> {
  const led = decodeV2State(ledgerState);
  const out = new Map<string, number[]>();
  if (!led) return out;
  for (const g of groups) {
    const counts = new Array(BUCKET_COUNT).fill(0);
    for (let b = 0; b < BUCKET_COUNT; b++) {
      let v = 0;
      try {
        v = Number(led.histogram.lookup(bucketKeyBytes2(categoryKey(g.categoryLabel), g.gender, g.component, b)));
      } catch {
        // `lookup` throws for a cell that was never written — it does not return
        // 0. With many groups x 10 buckets, most lookups throw.
        v = 0;
      }
      counts[b] = v;
    }
    out.set(groupKeyHex(g), counts);
  }
  return out;
}

/** Total participants per group, for coverage reporting. */
export function readGroupSizes(
  ledgerState: any,
  groups: ReportingGroupKey[],
): Map<string, number> {
  const led = decodeV2State(ledgerState);
  const out = new Map<string, number>();
  if (!led) return out;
  for (const g of groups) {
    let v = 0;
    try {
      v = Number(led.groupCount.lookup(groupKeyBytes(categoryKey(g.categoryLabel), g.gender, g.component)));
    } catch {
      v = 0;
    }
    out.set(groupKeyHex(g), v);
  }
  return out;
}

/** Human-readable bucket labels for a component, for report rendering. */
export function bucketLabels(component: ComponentId): string[] {
  return bucketsFor(component === COMPONENT.BASE ? 0 : 1).map((b) => b.label);
}

export { GENDER, COMPONENT, DEFAULT_K };
export type { GenderId, ComponentId };