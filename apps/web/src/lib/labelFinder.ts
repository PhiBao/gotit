/**
 * Find which category labels the contract actually holds.
 *
 * THE PROBLEM. The ledger keys each group by `hash(label)` and stores no name, so
 * when a report finds nothing it cannot say which labels ARE present. Five
 * submissions under "Entrepreneur" are invisible to a report looking for
 * "engineering", and all the chain can tell you is that some hash exists.
 *
 * The hash is one-way, so the name cannot be recovered. But it CAN be tested:
 * hash a candidate label the same way the circuit does and ask whether that group
 * exists. One-way functions are not a barrier to guessing-and-checking, which is
 * the whole point of this module — a person who half-remembers the label they used
 * can be told, in a second, whether they are right.
 *
 * This is not a brute-force search of the label space (which would be infeasible
 * and pointless). It tests the handful of strings a person actually typed, and it
 * reports the gender and component split, because a label that exists for women
 * but not men is not yet reportable and the user needs to know which is which.
 */
import { GENDER, COMPONENT } from "@gotit/shared/paygap";
import { categoryKeyBytes, groupKeyBytes, bytesToHex } from "@gotit/shared/hash";

/** What the ledger holds for one (label, gender, component). */
export type LabelProbe = {
  label: string;
  gender: number;
  component: number;
  /** Participants in that group, or 0. */
  size: number;
  /** Present in the ledger at all. */
  present: boolean;
};

export type LabelSearchResult = {
  /** The label as given. */
  label: string;
  /** Total participants across every gender and component for this label. */
  participants: number;
  /** How many of the six (gender × component) groups exist. */
  groupsPresent: number;
  /** Per-group detail, including zeros, so the caller can show the split. */
  probes: LabelProbe[];
  /** True when this label explains some of the contract's data. */
  matched: boolean;
};

/** The gender and component values the ledger distinguishes. */
export const PROBE_GENDERS = [GENDER.FEMALE, GENDER.MALE, GENDER.OTHER] as const;
export const PROBE_COMPONENTS = [COMPONENT.BASE, COMPONENT.VARIABLE] as const;

/**
 * Test one candidate label against the contract's raw group counts.
 *
 * `rawGroupCounts` maps a group key (hex) to its size. That is exactly what
 * `inventoryChain` reads, so the caller passes what it already has rather than
 * fetching again.
 */
export function probeLabel(label: string, rawGroupCounts: Map<string, number>): LabelSearchResult {
  const trimmed = label.trim();
  const probes: LabelProbe[] = [];
  let participants = 0;
  let groupsPresent = 0;

  if (trimmed.length > 0) {
    let ck: Uint8Array;
    try {
      ck = categoryKeyBytes(trimmed);
    } catch {
      // A label the circuit would reject cannot be present, and guessing further
      // would only produce a confusing "no match" for a label that was never
      // valid in the first place.
      return { label: trimmed, participants: 0, groupsPresent: 0, probes: [], matched: false };
    }
    for (const gender of PROBE_GENDERS) {
      for (const component of PROBE_COMPONENTS) {
        const key = bytesToHex(groupKeyBytes(ck, gender, component));
        const size = rawGroupCounts.get(key) ?? 0;
        const present = size > 0;
        probes.push({ label: trimmed, gender, component, size, present });
        if (present) {
          groupsPresent += 1;
          participants += size;
        }
      }
    }
  }

  return {
    label: trimmed,
    participants,
    groupsPresent,
    probes,
    matched: participants > 0,
  };
}

/** Test several candidates at once, best match first. */
export function searchLabels(
  candidates: string[],
  rawGroupCounts: Map<string, number>,
): LabelSearchResult[] {
  const seen = new Set<string>();
  const out: LabelSearchResult[] = [];
  for (const c of candidates) {
    // Deduplicated on the EXACT string, not case-insensitively. "Sales" and
    // "sales" are different hashes and therefore different groups, so collapsing
    // them would make the tool unable to find the one the user actually used —
    // which is the mistake it exists to diagnose.
    const key = c.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(probeLabel(c, rawGroupCounts));
  }
  return out.sort((a, b) => b.participants - a.participants || a.label.localeCompare(b.label));
}

/** Group counts as a hex-keyed map, from whatever the decoder returns. */
export function groupCountsFromLedger(ledger: any): Map<string, number> {
  const out = new Map<string, number>();
  const gc = ledger?.groupCount;
  if (!gc) return out;

  let entries: Iterable<[unknown, unknown]> | null = null;
  try {
    if (typeof gc.entries === "function") entries = gc.entries();
    else if (typeof gc[Symbol.iterator] === "function") entries = gc as Iterable<[unknown, unknown]>;
  } catch {
    return out;
  }
  if (!entries) return out;

  for (const [k, v] of entries) {
    const key =
      typeof k === "string"
        ? k.toLowerCase()
        : k instanceof Uint8Array
          ? Array.from(k).map((x) => x.toString(16).padStart(2, "0")).join("")
          : String(k);
    const raw = typeof v === "bigint" ? v : ((v as any)?.value ?? v);
    const size = Number(raw);
    if (Number.isFinite(size) && size > 0) out.set(key, size);
  }
  return out;
}

/**
 * Labels worth testing without being asked.
 *
 * The Operator's form records what it submits, so on the device that submitted
 * this is empty-or-exact. It exists for the case that actually happened: the
 * submissions predate that recording, and the person is reconstructing a label
 * from memory. Offering the obvious variations costs nothing and saves a round
 * trip.
 */
export function suggestedCandidates(configured: string[], used: string[]): string[] {
  const base = new Set<string>([...used, ...configured]);
  const out = new Set<string>(base);
  for (const b of [...base]) {
    const t = b.trim();
    if (!t) continue;
    out.add(t.toLowerCase());
    out.add(t.charAt(0).toUpperCase() + t.slice(1));
    out.add(`${t}s`); // a plural is a different hash and an easy slip
  }
  return [...out];
}
