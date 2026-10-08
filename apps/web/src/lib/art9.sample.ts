/**
 * An ILLUSTRATIVE report for demos, docs and screenshots.
 *
 * Deliberately explicit about being fake. It exists because a young chain has no
 * data, and "nothing publishable" is the right answer but a useless thing to
 * show a judge. Every surface that renders it carries an explicit banner, the
 * period label is marked SAMPLE, and no code path can present it as a live read:
 * `buildV2Report` is the only live path and it never falls back here.
 *
 * The figures are chosen to exercise the parts that matter — a gap that crosses
 * the 5% threshold, a one-sided group that must be suppressed, and base kept
 * apart from variable.
 */
import { BUCKET_COUNT } from "@gotit/shared";
import { GENDER, COMPONENT, DEFAULT_K } from "@gotit/shared/paygap";
import { allGroups, groupKeyHex, type JobCategory } from "./groups";
import { assembleArt9Report, type Art9ReportBundle, type ChainGroupReading } from "./art9";

export function sampleArt9Report(categories: JobCategory[], k = DEFAULT_K): Art9ReportBundle {
  const histograms = new Map<string, number[]>();
  const sizes = new Map<string, number>();
  const groups = allGroups(categories);

  /** Add `n` people to a group, placing them in `bucket`. */
  const add = (label: string, gender: number, component: number, n: number, bucket: number) => {
    const g = groups.find((x) => x.categoryLabel === label && x.gender === gender && x.component === component);
    if (!g) return;
    const k2 = groupKeyHex(g);
    const h = histograms.get(k2) ?? new Array(BUCKET_COUNT).fill(0);
    h[bucket] += n;
    histograms.set(k2, h);
    sizes.set(k2, (sizes.get(k2) ?? 0) + n);
  };

  // Engineering: publishable, and the gap is material.
  add("engineering", GENDER.FEMALE, COMPONENT.BASE, 9, 3);
  add("engineering", GENDER.FEMALE, COMPONENT.BASE, 6, 2);
  add("engineering", GENDER.MALE, COMPONENT.BASE, 5, 5);
  add("engineering", GENDER.MALE, COMPONENT.BASE, 10, 6);
  // The variable-pay side of engineering, on the variable bucket scale. Without
  // this, Art. 9(1)(b) has nothing to report and the headline claim of Wave 2 —
  // base and variable kept apart — is invisible in the demo.
  add("engineering", GENDER.FEMALE, COMPONENT.VARIABLE, 9, 5);
  add("engineering", GENDER.MALE, COMPONENT.VARIABLE, 6, 8);
  // Sales: both sides clear k, smaller gap.
  add("sales", GENDER.FEMALE, COMPONENT.BASE, 6, 2);
  add("sales", GENDER.MALE, COMPONENT.BASE, 6, 3);
  // Operations: only one gender reported. Suppressed, because publishing one
  // side of a comparison would reveal the other by subtraction.
  add("operations", GENDER.FEMALE, COMPONENT.BASE, 7, 2);
  // A tiny group: 4 people, below k, so the circuit would refuse to publish it.
  add("management", GENDER.FEMALE, COMPONENT.BASE, 4, 5);
  add("management", GENDER.MALE, COMPONENT.BASE, 4, 6);

  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const reading: ChainGroupReading = {
    histograms,
    sizes,
    k,
    period: 1,
    members: total,
    submissions: total,
  };

  const bundle = assembleArt9Report({
    categories,
    reading,
    periodLabel: "SAMPLE DATA — illustrative, not a filing",
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  bundle.report.notes.unshift(
    "ILLUSTRATIVE DATA — generated in the browser to demonstrate the report format. " +
      "These figures are NOT read from the ledger and must never be filed.",
  );
  bundle.report.notes.push(
    "Gaps and means are printed as intervals because the underlying figures are bucketed: the exact " +
      "values are not recoverable from the chain. Counts, medians and quartiles are exact.",
  );
  return bundle;
}