#!/usr/bin/env node
/**
 * Read a deployed GotIt ledger and print the Art. 9 report it produces.
 *
 * No wallet. No issuer key. No proof server. This is the point: a third party —
 * a works council, a regulator, a journalist, or a judge — reproduces the
 * published report from public chain state with one command and diffs it.
 *
 *   pnpm --filter @gotit/contract verify:chain -- \
 *     --address 0x... --categories engineering,sales,operations,management
 *
 * The report engine is pure (packages/shared/src/paygap.ts, no I/O), so this
 * tool's job is only to fetch and shape the state, then hand it to the same
 * functions the app uses. Whoever runs it gets the numbers the app published, or
 * a difference they can see.
 *
 * NOTE on the anonymity gate. This tool reads raw ledger state, which is what an
 * independent verifier should do — the whole point is that it does not trust the
 * app. The gate is then applied by `buildReport`, which withholds any row whose
 * either side falls below k. That is the same rule the on-chain read circuit
 * enforces, evaluated here rather than taken on trust. The app additionally
 * reads published figures through the contract's `getGroupHistogram` and
 * cross-checks the two; see apps/web/src/lib/gatedLogic.ts. If you want to see
 * that check run live you need the prover, and you need to run the app.
 */
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { ledger as decodeLedger } from "./managed/gotit/contract/index.js";
import {
  buildReport,
  renderReportMarkdown,
  reportToJson,
  DEFAULT_K,
  GENDER,
  COMPONENT,
} from "@gotit/shared/paygap";
import { BUCKET_COUNT } from "@gotit/shared";
import {
  categoryKeyBytes,
  bucketKeyBytes2,
  groupKeyBytes,
} from "@gotit/shared/hash";
import { writeFileSync } from "node:fs";
import { shapeChainRows, toEngineInput } from "./chainRead.logic.js";

const INDEXER = process.env.MIDNIGHT_INDEXER ?? "https://indexer.preprod.midnight.network/api/v4/graphql";

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

/**
 * Turn one category label into the key the ledger uses.
 *
 * Mirrors the check in apps/web/src/lib/groups.ts so a bad label fails here with
 * a clear message instead of surfacing later as a prover type error.
 */
function categoryKey(label: string): Uint8Array {
  const bytes = new TextEncoder().encode(label);
  if (bytes.length > 32) {
    throw new Error(
      `category label must be at most 32 bytes (got ${bytes.length}): "${label}". ` +
        `Use a short job family name — the full job title belongs in the report, not the key.`,
    );
  }
  return categoryKeyBytes(label);
}

/** Look up a cell, treating a miss as 0 the way the ledger does. */
function lookup<T>(map: any, key: Uint8Array): T {
  try {
    const v = map.lookup(key);
    return (v === undefined || v === null ? 0 : v) as T;
  } catch {
    return 0 as unknown as T;
  }
}

async function main() {
  const a = args();
  const address = a.address ?? a.contract ?? process.env.CONTRACT_ADDRESS;
  if (!address) {
    console.error(
      "usage: tsx src/chainRead.ts --address <contractAddress> --categories <a,b,c> [--out report.md]\n" +
        `indexer: ${INDEXER} (override with MIDNIGHT_INDEXER)`,
    );
    process.exit(1);
  }

  const labels = (a.categories ?? "engineering,sales,operations,management")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (labels.length === 0) {
    console.error("no categories given");
    process.exit(1);
  }

  console.error(`reading ${address} from ${INDEXER} …`);
  const provider = indexerPublicDataProvider(INDEXER, INDEXER.replace(/^http/, "ws"));
  const state = await provider.queryContractState(address as any);
  if (!state) {
    console.error("contract state not found. Check the address and that the indexer has it.");
    process.exit(2);
  }

  const led = decodeLedger((state as any).data ?? state) as any;

  // Detect a non-v2 ledger precisely. A generated v1 ledger throws on access to
  // a field it does not declare, so the check has to be guarded rather than
  // `if (!led?.groupCount)` — which is how this read used to fail with
  // "index out of bounds in idx: 5 >= 5" on a v1 address.
  let hasV2Shape = false;
  try {
    hasV2Shape = Boolean(led?.groupCount) && Number(led.kThreshold) >= 0;
  } catch {
    hasV2Shape = false;
  }
  if (!hasV2Shape) {
    console.error(
      "this contract has no v2 ledger state. It is likely the Wave 1 contract, which " +
        "predates the Art. 9 dimensions (job category, gender, base vs variable) and " +
        "cannot produce this report. Its own cuts are still readable through the app.",
    );
    process.exit(3);
  }

  const k = Number(led.kThreshold) || DEFAULT_K;
  const epoch = Number(lookup<bigint>(led.epochCount, new Uint8Array([101]))) || 1;
  const members = Number(led.members.size?.() ?? 0);
  const submissions = Number(led.nullifiers.size?.() ?? 0);

  const shaped = shapeChainRows(led, {
    categories: labels,
    bucketKeys: bucketKeyBytes2,
    groupKeys: groupKeyBytes,
    categoryKeys: categoryKey,
  });

  const rows = shaped.rows.map((row) => toEngineInput(row, row.component, k));

  const report = buildReport(rows, {
    period: `FY2026 · reporting period ${epoch}`,
    generatedAt: new Date().toISOString().slice(0, 10),
    k,
  });

  report.notes.unshift(
    `Read directly from ${address} at reporting period ${epoch}, anonymity threshold k=${k} ` +
      `(from the contract's own state). ${submissions} submission(s), ${members} enrolled member(s).`,
  );
  report.notes.push(
    `Regenerated with this command by anyone, with no wallet and no account: ` +
      `tsx src/chainRead.ts --address ${address} --categories ${labels.join(",")}. ` +
      `The report engine is pure, so re-running it on public state reproduces these numbers exactly.`,
  );

  const md = renderReportMarkdown(report);
  const json = reportToJson(report);

  const summary =
    `# chain read\n\n` +
    `contract: ${address}\nreporting period: ${epoch}\nthreshold k: ${k}\n` +
    `members: ${members}\nsubmissions: ${submissions}\n` +
    `reportable rows: ${report.rows.length}\nwithheld: ${report.suppressed.length} ` +
    `(empty groups: ${shaped.empty.length})\n\n`;

  if (a.out) {
    writeFileSync(a.out, md);
    writeFileSync(a.out.replace(/\.md$/, "") + ".json", json);
    console.error(`wrote ${a.out}`);
  } else {
    process.stdout.write(summary + md + "\n");
  }
}

main().catch((e) => {
  console.error(`chain read failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
