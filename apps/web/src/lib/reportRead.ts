/**
 * Report data source for the Wave 2 compliance surface.
 *
 * This module is I/O only: it reads the deployed contract's public state and
 * hands it to the pure layer in `reportRead.logic.ts`. All the decisions worth
 * arguing about live there, under test; this file stays small on purpose.
 */

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { asContractAddress } from "@midnight-ntwrk/midnight-js-types";
import { ledger as gotitLedger } from "@gotit/contract/managed/candor/contract";
import { bucketKeyBytes, cutKeyBytes } from "@gotit/shared/hash";
import { BUCKET_COUNT, allCuts, cutKeyString, type Cut } from "@gotit/shared";
import type { PayGapReport } from "@gotit/shared/paygap";
import {
  buildReport,
  compareFingerprint,
  fingerprint,
  toLedgerSnapshot,
  type ChainTotals,
  type VerificationResult,
} from "./reportRead.logic";
import { INDEXER_HTTP as indexerHttp, INDEXER_WS as indexerWs } from "./indexerConfig";

export {
  buildReport,
  compareFingerprint,
  fingerprint,
  toLedgerSnapshot,
  type ChainTotals,
  type VerificationResult,
};
export { renderReportMarkdown, reportToJson } from "@gotit/shared/paygap";

// Same-origin proxy (Caddy on Fly, Vite in dev). The upstream host is configured
// in the environment; see ./indexerConfig.ts.
const ORIGIN = window.location.origin;
const INDEXER_HTTP = indexerHttp;
const INDEXER_WS = indexerWs;

const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

function zeros(): number[] {
  return Array(BUCKET_COUNT).fill(0);
}

/**
 * Read the contract once and return everything a report needs.
 * Throws on failure so callers can show an explicit error rather than a
 * plausible-looking empty report.
 */
export async function readChainTotals(contractAddress: string): Promise<ChainTotals> {
  const state = await withTimeout(provider.queryContractState(asContractAddress(contractAddress)), 15_000);
  if (!state) throw new Error("contract state not found on indexer");
  const led = gotitLedger((state as any).data ?? state);

  const epoch = led.epochCount.lookup(new Uint8Array([101]));
  const members = Number(led.members.size());
  const submissions = Number(led.nullifiers.size());

  const populated: ChainTotals["populated"] = [];
  const emptyCuts: Cut[] = [];

  for (const cut of allCuts()) {
    const ck = cutKeyBytes(cutKeyString(cut));
    const counts = zeros();
    let any = false;
    for (let b = 0; b < BUCKET_COUNT; b++) {
      // `lookup` THROWS ("expected a cell, received null") for a bucket that has
      // never been written — it does not return 0. With 15 cuts x 10 buckets and
      // a handful of real submissions, most lookups throw, so the catch is the
      // normal path, not an error case.
      let v = 0;
      try {
        v = Number(led.histogram.lookup(bucketKeyBytes(ck, BigInt(b))));
      } catch {
        v = 0;
      }
      counts[b] = v;
      if (v > 0) any = true;
    }
    if (any) populated.push({ cut, counts });
    else emptyCuts.push(cut);
  }

  populated.sort((a, b) => cutKeyString(a.cut).localeCompare(cutKeyString(b.cut)));
  return { epoch: epoch.toString(), members, submissions, populated, emptyCuts };
}

/**
 * Build the report a compliance officer sees, from live chain state.
 *
 * `period` is a label, not a chain concept — Wave 1 has a single epoch counter
 * with no period metadata, so we surface the epoch number alongside the label
 * rather than inventing a reporting year the ledger cannot corroborate.
 */
export async function buildReportFromChain(
  contractAddress: string,
  period: string,
): Promise<{ report: PayGapReport; totals: ChainTotals; fingerprint: string }> {
  const totals = await readChainTotals(contractAddress);
  const report = buildReport(totals, { period, generatedAt: new Date().toISOString().slice(0, 10) });
  return { report, totals, fingerprint: fingerprint(totals) };
}

/**
 * Re-read chain state and compare against a fingerprint published with a report.
 * This is the "can anyone check this?" surface — no wallet, no account.
 */
export async function verifyReport(
  contractAddress: string,
  expectedFingerprint: string,
): Promise<VerificationResult> {
  const totals = await readChainTotals(contractAddress);
  const actual = fingerprint(totals);
  return {
    ok: compareFingerprint(actual, expectedFingerprint),
    expected: expectedFingerprint,
    actual,
    epoch: totals.epoch,
    submissions: totals.submissions,
    populatedCuts: totals.populated.length,
    checkedAt: new Date().toISOString(),
  };
}
