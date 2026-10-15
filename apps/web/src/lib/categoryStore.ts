/**
 * The employer's job-category list, shared by every screen that needs it.
 *
 * WHY THIS EXISTS. The ledger does not store category names. It stores
 * `persistentHash("gotit:catkey:v2" || label)`, because the chain should carry a
 * proof of a group's size without holding the group's name. The label→hash
 * mapping lives off-chain, and that has one sharp consequence:
 *
 *   A submission filed under "Entrepreneur" is invisible to a report looking for
 *   "engineering". Both are valid categories; they are simply different hashes.
 *
 * Which is what happened — five submissions landed under one label while the
 * report searched for four others, so every row read `no-data · 0 participants`.
 * Nothing was broken. The two screens disagreed about a name, and the ledger
 * cannot tell you that because it never knew the name in the first place.
 *
 * So the list is stored once and read by both:
 *
 *   - the Operator's contribution form selects from it
 *   - the report page looks up exactly these labels
 *   - the report page is where it is edited, because that is the artefact that
 *     has to publish the mapping
 *
 * It is localStorage rather than the chain on purpose: the mapping is part of the
 * published report, not part of the ledger. A verifier needs the report and the
 * address, not a registry.
 */

/** At most 32 UTF-8 bytes, because Compact's `pad` is fixed-width. */
export const CATEGORY_LABEL_MAX_BYTES = 32;

export type StoredCategory = {
  id: string;
  label: string;
};

const KEY = "gotit:categories";

/**
 * What a report looks for when nobody has configured anything.
 *
 * Deliberately the same default the contribution form starts from, so the two
 * agree out of the box and a first-time run works without anyone discovering
 * this file exists.
 */
export const DEFAULT_CATEGORIES: StoredCategory[] = [
  { id: "engineering", label: "engineering" },
  { id: "sales", label: "sales" },
  { id: "operations", label: "operations" },
  { id: "management", label: "management" },
];

/** Byte length, because that is the limit that matters. */
export function labelBytes(label: string): number {
  return new TextEncoder().encode(label).length;
}

/**
 * Normalise a label as the ledger sees it, or explain why it cannot be used.
 *
 * Validated here rather than at proof time: the circuit's `pad` throws past 32
 * bytes, and a prover type error several screens later is not a useful way to
 * learn that a category name is too long.
 */
export function validateLabel(label: string): { ok: true; label: string } | { ok: false; reason: string } {
  const trimmed = label.trim();
  if (trimmed.length === 0) return { ok: false, reason: "A category cannot be empty." };
  const bytes = labelBytes(trimmed);
  if (bytes > CATEGORY_LABEL_MAX_BYTES) {
    return {
      ok: false,
      reason:
        `"${trimmed}" is ${bytes} bytes; the ledger accepts at most ` +
        `${CATEGORY_LABEL_MAX_BYTES}. Use a short job family ("engineering"), not a job title.`,
    };
  }
  // Whitespace is normalised so "sales " and "sales" are one group rather than
  // two, which would split a headcount and could push a category under k.
  return { ok: true, label: trimmed };
}

export function loadCategories(): StoredCategory[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [...DEFAULT_CATEGORIES];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [...DEFAULT_CATEGORIES];
    const out: StoredCategory[] = [];
    for (const c of parsed) {
      if (typeof c?.label !== "string") continue;
      const v = validateLabel(c.label);
      if (v.ok) out.push({ id: typeof c.id === "string" && c.id ? c.id : v.label, label: v.label });
    }
    return out.length > 0 ? out : [...DEFAULT_CATEGORIES];
  } catch {
    return [...DEFAULT_CATEGORIES];
  }
}

export function saveCategories(categories: StoredCategory[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(categories));
  } catch {
    /* storage full or blocked; the defaults still work */
  }
}

/**
 * Turn a pasted list of labels into categories.
 *
 * Accepts newline- or comma-separated, deduplicated case-insensitively so
 * "Sales" and "sales" cannot become two groups with separate headcounts.
 */
export function parseCategoryText(textValue: string): { categories: StoredCategory[]; problems: string[] } {
  const parts = textValue
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const categories: StoredCategory[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const v = validateLabel(part);
    if (!v.ok) {
      problems.push(v.reason);
      continue;
    }
    const key = v.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    categories.push({ id: v.label.toLowerCase().replace(/\W+/g, "-"), label: v.label });
  }

  return { categories, problems };
}

/**
 * Categories the report should look for, given what has been submitted.
 *
 * The reason this is not simply `loadCategories()`: a category someone
 * contributed to and nobody configured is a real group with real people in it,
 * and a report that silently omits it understates coverage. So anything the
 * Operator has used is merged in, and the operator sees it listed rather than
 * wondering where their submission went.
 */
export function mergeCategories(configured: StoredCategory[], used: string[]): StoredCategory[] {
  const out = [...configured];
  const seen = new Set(configured.map((c) => c.label.toLowerCase()));
  for (const label of used) {
    const v = validateLabel(label);
    if (!v.ok) continue;
    const key = v.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: v.label.toLowerCase().replace(/\W+/g, "-"), label: v.label });
  }
  return out;
}

/** Categories the Operator has submitted under on this device. */
const USED_KEY = "gotit:categoriesUsed";

export function rememberUsedCategory(label: string): void {
  const v = validateLabel(label);
  if (!v.ok) return;
  try {
    const raw = localStorage.getItem(USED_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return;
    if (list.some((l) => l.toLowerCase() === v.label.toLowerCase())) return;
    list.push(v.label);
    localStorage.setItem(USED_KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
}

export function usedCategories(): string[] {
  try {
    const raw = localStorage.getItem(USED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
