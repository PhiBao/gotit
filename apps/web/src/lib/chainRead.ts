/**
 * Live on-chain reads — no wallet required.
 * Queries the Preprod indexer for the deployed contract's public state and
 * shapes it like a LedgerSnapshot so the existing UI functions work unchanged.
 * Falls back gracefully: callers decide what to show when the read fails.
 */
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { asContractAddress } from "@midnight-ntwrk/midnight-js-types";
import { ledger as gotitLedger } from "@gotit/contract/managed/candor/contract";
import { bucketKeyBytes, cutKeyBytes } from "@gotit/shared/hash";
import { BUCKET_COUNT, type Cut, cutKeyString } from "@gotit/shared";
import type { LedgerSnapshot } from "./ledger";

// The Preprod indexer's v4 GraphQL endpoint.
//
// We proxy it through our own origin (Caddy on Fly, Vite in dev) rather than
// calling it directly, for two reasons: the WebSocket subscription cannot be
// proxied transparently by every host, and keeping the indexer behind our own
// origin means a change of indexer host does not need a rebuild.
//
// The previous upstream, blockfrost.lw.iog.io/midnight-preprod, now answers
// 410 Gone ("Midnight endpoints have been removed from this proxy"). The
// official host is indexer.preprod.midnight.network, API v4.
const ORIGIN = window.location.origin;
const INDEXER_HTTP = `${ORIGIN}/indexer/api/v4/graphql`;
const INDEXER_WS = `${ORIGIN.replace(/^http/, "ws")}/indexer/api/v4/graphql/ws`;

const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

/**
 * Read the deployed contract's public ledger state.
 * Throws on failure — callers must handle (sample data is the fallback).
 */
/**
 * Probe the indexer once, so the app can say WHY live reads are unavailable.
 *
 * The app already refuses to pass off sample data as chain data, but until now
 * it could not distinguish "nobody has run a reporting period" from "the network
 * moved its indexer" — and on 2026-10-09 the second one happened. Every read
 * through this endpoint goes through the app's own /indexer proxy, which injects
 * the Blockfrost project token server-side.
 */
export async function probeIndexer(
  timeoutMs = 10_000,
): Promise<import("./indexerStatus").IndexerReport> {
  const { classifyIndexerResponse, reportFrom } = await import("./indexerStatus");
  const url = INDEXER_HTTP;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{__typename}" }),
      signal: ctl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    const body = await res.text().catch(() => "");
    return reportFrom(classifyIndexerResponse(res.status, body), url);
  } catch (e) {
    return reportFrom(
      { kind: "unreachable", message: e instanceof Error ? e.message : "no response" },
      url,
    );
  }
}

export async function readGotItState(contractAddress: string): Promise<{
  epoch: string;
  members: number;
  submissions: number;
  snapshot: LedgerSnapshot;
}> {
  const state = await withTimeout(provider.queryContractState(asContractStateAddress(contractAddress)), 15_000);
  if (!state) throw new Error("contract state not found on indexer");
  const led = gotitLedger((state as any).data ?? state);

  const epoch = led.epochCount.lookup(new Uint8Array([101]));
  const histogram: Record<string, number> = {};
  // Populate histogram for all Wave 1 cuts so public pages are live
  const { allCuts } = await import("@gotit/shared");
  for (const cut of allCuts()) {
    const ck = cutKeyBytes(cutKeyString(cut));
    for (let b = 0; b < BUCKET_COUNT; b++) {
      let v = 0;
      try { v = Number(led.histogram.lookup(bucketKeyBytes(ck, BigInt(b)))); } catch { v = 0; }
      if (v > 0) histogram[`${cutKeyString(cut)}:b${b}`] = v;
    }
  }
  const members = Number(led.members.size());
  const submissions = Number(led.nullifiers.size());

  return {
    epoch: epoch.toString(),
    members,
    submissions,
    snapshot: {
      members: Array.from({ length: members }, (_, i) => `member:${i}`),
      nullifiers: Array.from({ length: submissions }, (_, i) => `nf:${i}`),
      histogram,
      epoch: epoch.toString(),
    },
  };
}

/** Fill a snapshot's histogram with live counts for the given cut. */
export async function readHistogramInto(
  snapshot: LedgerSnapshot,
  contractAddress: string,
  cut: Cut,
): Promise<void> {
  const state = await withTimeout(provider.queryContractState(asContractStateAddress(contractAddress)), 15_000);
  if (!state) throw new Error("contract state not found on indexer");
  const led = gotitLedger((state as any).data ?? state);
  const ck = cutKeyBytes(cutKeyString(cut));
  for (let b = 0; b < BUCKET_COUNT; b++) {
    let v = 0;
    try {
      v = Number(led.histogram.lookup(bucketKeyBytes(ck, BigInt(b))));
    } catch {
      v = 0;
    }
    if (v > 0) snapshot.histogram[`${cutKeyString(cut)}:b${b}`] = v;
  }
}

function asContractStateAddress(address: string): any {
  return asContractAddress(address);
}
