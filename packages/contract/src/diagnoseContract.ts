#!/usr/bin/env node
/**
 * Diagnose a deployed v2 contract: what does its ledger actually hold?
 *
 * Written to settle a disagreement between what the app reports and what was
 * submitted. It answers three questions directly against the indexer, with no
 * app code in the path:
 *
 *   1. Can `groupCount` be ENUMERATED at all? A Compact `Map` in ledger state is
 *      backed by a sparse Merkle tree. If the generated decoder exposes only
 *      `lookup`/`member` and not iteration, then counting "how many groups exist"
 *      is impossible and any tool that claims a total is lying.
 *   2. Do specific candidate labels hash to groups that exist? This tests a guess
 *      the way the circuit does, which is the only way to find a label from a hash.
 *   3. What do the counters say — members, nullifiers, epoch, k?
 *
 * Usage:
 *   pnpm --filter @gotit/contract diagnose:contract -- \
 *     --address 92fb35... --network preprod --labels engineering,sales,Dr/Nurse
 */
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { ledger as decodeLedger } from "./managed/gotit/contract/index.js";
import { categoryKeyBytes, groupKeyBytes, bucketKeyBytes2, bytesToHex } from "@gotit/shared/hash";
import { GENDER, COMPONENT } from "@gotit/shared/paygap";

const NETWORKS: Record<string, { indexer: string; ws: string }> = {
  preprod: {
    indexer: process.env.MIDNIGHT_INDEXER ?? "https://midnight-preprod.blockfrost.io/api/v0",
    ws: process.env.MIDNIGHT_INDEXER_WS ?? "wss://midnight-preprod.blockfrost.io/api/v0/ws",
  },
  preview: {
    indexer: "https://indexer.preview.midnight.network/api/v4/graphql",
    ws: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
  },
};

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[k] = next;
        i += 1;
      } else out[k] = "true";
    }
  }
  return out;
}

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const inner = (v as any)?.value;
  if (typeof inner === "bigint") return Number(inner);
  if (typeof inner === "number") return inner;
  const n = Number(v as any);
  return Number.isFinite(n) ? n : 0;
}

/** Every way a Map-ish value might be enumerable. */
function enumerate(map: any): { ok: boolean; how: string; entries: Array<[string, number]> } {
  if (!map) return { ok: false, how: "no map", entries: [] };
  const methods = ["entries", "keys", "values", "forEach", Symbol.iterator];
  const available = methods
    .map((m) => (typeof map[m] === "function" ? String(m) : null))
    .filter(Boolean);

  const keyHex = (k: any) =>
    typeof k === "string"
      ? k
      : k instanceof Uint8Array
        ? bytesToHex(k)
        : String(k);

  try {
    if (typeof map.entries === "function") {
      const out: Array<[string, number]> = [];
      for (const [k, v] of map.entries()) out.push([keyHex(k), num(v)]);
      return { ok: true, how: "entries()", entries: out };
    }
    if (typeof map[Symbol.iterator] === "function") {
      const out: Array<[string, number]> = [];
      for (const [k, v] of map as Iterable<[any, any]>) out.push([keyHex(k), num(v)]);
      return { ok: true, how: "Symbol.iterator", entries: out };
    }
  } catch (e: any) {
    return { ok: false, how: `threw: ${e?.message ?? e} (methods present: ${available.join(", ") || "none"})`, entries: [] };
  }
  return { ok: false, how: `not enumerable (methods present: ${available.join(", ") || "none"})`, entries: [] };
}

async function main() {
  const a = args();
  const address = a.address ?? process.env.CONTRACT_ADDRESS;
  if (!address) {
    console.error("usage: --address <contract> [--network preprod|preview] [--labels a,b,c]");
    process.exit(1);
  }
  const net = NETWORKS[a.network ?? "preprod"] ?? NETWORKS.preprod;
  console.error(`reading ${address}\n  via ${net.indexer}\n`);

  const provider = indexerPublicDataProvider(net.indexer, net.ws);
  const state = await provider.queryContractState(address as any);
  if (!state) {
    console.error("contract state not found. Check the address and network.");
    process.exit(2);
  }

  const led = decodeLedger((state as any).data ?? state) as any;

  console.log("=== counters ===");
  for (const [name, get] of [
    ["members", () => num(led.members.size())],
    ["nullifiers", () => num(led.nullifiers.size())],
    ["epochCount", () => num(led.epochCount.lookup(new Uint8Array([101])))],
    ["kThreshold", () => num(led.kThreshold)],
  ] as const) {
    try {
      console.log(`  ${name}: ${get()}`);
    } catch (e: any) {
      console.log(`  ${name}: could not read (${e?.message ?? e})`);
    }
  }

  console.log("\n=== can groupCount be enumerated? ===");
  const gc = enumerate(led.groupCount);
  console.log(`  ${gc.ok ? "YES" : "NO"} — ${gc.how}`);
  if (gc.ok) {
    console.log(`  ${gc.entries.length} group(s) with a recorded count:`);
    for (const [k, v] of gc.entries) console.log(`    ${v.toString().padStart(4)}  ${k}`);
  } else {
    console.log(
      "  A Compact Map is a sparse Merkle tree; the generated decoder may expose only\n" +
        "  lookup/member. If so, 'how many groups exist' cannot be counted, and a tool\n" +
        "  that reports a total is wrong.",
    );
  }

  console.log("\n=== do candidate labels exist on chain? ===");
  const labels = (a.labels ?? "engineering,Dr/Nurse,sales,operations,management")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const label of labels) {
    let ck: Uint8Array;
    try {
      ck = categoryKeyBytes(label);
    } catch (e: any) {
      console.log(`\n  "${label}": unusable label (${e?.message ?? e})`);
      continue;
    }
    console.log(`\n  "${label}"  categoryKey=${bytesToHex(ck).slice(0, 16)}…`);
    let any = false;
    for (const gender of [GENDER.FEMALE, GENDER.MALE, GENDER.OTHER]) {
      for (const component of [COMPONENT.BASE, COMPONENT.VARIABLE]) {
        const gk = groupKeyBytes(ck, gender, component);
        let count: number | null = null;
        let err: string | null = null;
        try {
          count = num(led.groupCount.lookup(gk));
        } catch (e: any) {
          // lookup throws for an unwritten cell; that is the normal miss.
          err = "absent";
        }
        const who = gender === 0 ? "women" : gender === 1 ? "men" : "other";
        const what = component === 0 ? "base" : "variable";
        if (count && count > 0) {
          any = true;
          console.log(`      ${who}/${what}: ${count}  <-- EXISTS`);
          // Show the bucket split too, so we know it is real data.
          const buckets: string[] = [];
          for (let b = 0; b < 10; b++) {
            try {
              const n = num(led.histogram.lookup(bucketKeyBytes2(ck, gender, component, b)));
              if (n > 0) buckets.push(`b${b}=${n}`);
            } catch {
              /* absent */
            }
          }
          if (buckets.length) console.log(`        buckets: ${buckets.join(" ")}`);
        } else {
          console.log(`      ${who}/${what}: ${err ?? 0}`);
        }
      }
    }
    if (!any) console.log("      -> nothing under this label");
  }
}

main().catch((e) => {
  console.error(`diagnose failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
