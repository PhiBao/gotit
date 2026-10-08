/**
 * Wave 2 chain path — the v2 contract.
 *
 * Kept separate from `midnight.ts` (which serves the deployed v1 contract) for a
 * reason that matters operationally: v1 is LIVE at e7cf6ffc…dd53d and must keep
 * working untouched, while v2 is not deployed yet. Mixing them in one module
 * would make every v1 call site depend on v2 existing.
 *
 * v1 stays the default until v2 is deployed and the operator points
 * VITE_CONTRACT_V2 at it. Nothing here silently falls back to v1 data: if v2 is
 * missing, the read fails and the report says so rather than showing v1's
 * numbers under a v2 label.
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { deployContract, findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import type { PrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";
import { inMemoryPrivateStateProvider } from "./privateState";
import { BUCKET_COUNT } from "@gotit/shared";
import { Contract as GotItV2Contract } from "@gotit/contract/managed/gotit/contract";
import { witnesses, createPrivateState, type GotItPrivateState } from "@gotit/contract/witnesses-v2";
import { issuerCommitment2 } from "@gotit/shared/hash";
import { DEFAULT_K } from "@gotit/shared/paygap";

/** ZK artefacts are served from this path; must match the deploy image copy. */
const V2_ASSETS = "/zk/gotit";
const V2_PRIVATE_STATE_ID = "gotit-v2";

export type GotItV2Providers = {
  zkConfigProvider: FetchZkConfigProvider<string>;
  publicDataProvider: any;
  privateStateProvider: PrivateStateProvider<string, GotItPrivateState>;
  proofProvider: any;
  walletProvider: any;
  midnightProvider: any;
};

export function v2ZkAssetsBase(): string {
  return `${window.location.origin}${V2_ASSETS}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compiledV2(): any {
  const withWitnessesFn = CompiledContract.withWitnesses as any;
  const withAssetsFn = CompiledContract.withCompiledFileAssets as any;
  return withAssetsFn(
    withWitnessesFn(CompiledContract.make("gotit", GotItV2Contract), witnesses),
    v2ZkAssetsBase(),
  );
}

/**
 * Build the v2 provider set from an already-connected wallet.
 *
 * The prover URI always goes through our own origin: Lace's service worker
 * blocks direct fetches to 127.0.0.1 from the page (ERR_FAILED), and the hosted
 * proof server is same-origin proxied by Caddy.
 */
export function buildV2Providers(parts: {
  indexerUri: string;
  indexerWsUri: string;
  proverServerUri: string;
  walletProvider: any;
  midnightProvider: any;
}): GotItV2Providers {
  const zkConfigProvider = new FetchZkConfigProvider<string>(v2ZkAssetsBase(), fetch.bind(window));
  return {
    zkConfigProvider,
    publicDataProvider: indexerPublicDataProvider(parts.indexerUri, parts.indexerWsUri),
    privateStateProvider: inMemoryPrivateStateProvider<string, GotItPrivateState>(),
    proofProvider: httpClientProofProvider(parts.proverServerUri, zkConfigProvider as any),
    walletProvider: parts.walletProvider,
    midnightProvider: parts.midnightProvider,
  } as GotItV2Providers;
}

type V2Instance = InstanceType<typeof GotItV2Contract>;

/**
 * Deploy v2. The connected wallet becomes the issuer and carries the issuerKey
 * witness. `kThreshold` is fixed at deployment and is public thereafter via
 * readK(), so a report can state which threshold it applied.
 */
export async function deployV2(
  providers: GotItV2Providers,
  issuerKey: Uint8Array,
  kThreshold: number = DEFAULT_K,
): Promise<string> {
  const ps: GotItPrivateState = { ...createPrivateState(), issuerKey };
  const deployed = await deployContract(providers as any, {
    compiledContract: compiledV2(),
    privateStateId: V2_PRIVATE_STATE_ID,
    initialPrivateState: ps,
    args: [issuerCommitment2(issuerKey), BigInt(kThreshold)],
  } as any);
  return (deployed as any).contractAddress;
}

/**
 * Connect to an existing v2 instance.
 *
 * `secret` must be the same persistent value across calls: it derives both the
 * membership leaf and the period nullifier inside the circuit.
 */
export async function findV2(
  providers: GotItV2Providers,
  contractAddress: string,
  opts: { asIssuer?: boolean; issuerKey?: Uint8Array; secret?: Uint8Array } = {},
): Promise<any> {
  const ps = opts.asIssuer
    ? { ...createPrivateState(opts.secret), issuerKey: opts.issuerKey }
    : createPrivateState(opts.secret);
  return await findDeployedContract(providers as any, {
    compiledContract: compiledV2(),
    contractAddress,
    privateStateId: V2_PRIVATE_STATE_ID,
    initialPrivateState: ps,
  } as any);
}

/** Submit one bucketed figure for a reporting group. */
export async function submitV2(
  providers: GotItV2Providers,
  contractAddress: string,
  opts: { categoryKey: Uint8Array; gender: number; component: number; bucket: number; secret: Uint8Array },
): Promise<any> {
  const found = await findV2(providers, contractAddress, { secret: opts.secret });
  return (found.callTx as any).submit(
    opts.categoryKey,
    BigInt(opts.gender),
    BigInt(opts.component),
    BigInt(opts.bucket),
  );
}

/** Issuer-only: enroll a member leaf. */
export async function enrollV2(
  providers: GotItV2Providers,
  contractAddress: string,
  opts: { leaf: Uint8Array; issuerKey: Uint8Array; secret?: Uint8Array },
): Promise<any> {
  const found = await findV2(providers, contractAddress, {
    asIssuer: true,
    issuerKey: opts.issuerKey,
    secret: opts.secret,
  });
  return (found.callTx as any).enroll(opts.leaf);
}

/** Issuer-only: advance the reporting period. */
export async function nextEpochV2(
  providers: GotItV2Providers,
  contractAddress: string,
  opts: { issuerKey: Uint8Array },
): Promise<any> {
  const found = await findV2(providers, contractAddress, { asIssuer: true, issuerKey: opts.issuerKey });
  return (found.callTx as any).nextEpoch();
}

/**
 * A connected, reusable reader for one v2 contract.
 *
 * Built because the obvious implementation — call `findV2` per bucket — costs
 * 4 categories x 3 genders x 2 components x 10 buckets = 240 contract
 * connections per report. This connects once and reads through
 * `found.callTx.query.<circuit>`, which is the path that actually runs the
 * circuit's disclosure gate.
 *
 * Two read modes, deliberately separated:
 *
 *   gated   -> getHistogram / isPublishable / readK. Returns 0 for any group
 *              below k, so a small group's PAY BANDS cannot be read out at all.
 *              This is the only source of a published figure.
 *   shape   -> raw ledger state. Reveals which groups exist, their headcount,
 *              epoch, member and submission counts. Used ONLY for coverage and
 *              the suppression reason, never as the source of a published
 *              figure. Headcount is already public in the indexer for anyone who
 *              asks, so reporting it adds no exposure — the pay bands are what
 *              the gate protects.
 */
export type GatedReader = {
  /** Contract address this reader is bound to. */
  address: string;
  /** k as reported by the contract's own readK circuit. */
  k(): Promise<number>;
  /** Period number from readEpoch. */
  epoch(): Promise<number>;
  /** Is this group large enough to publish? */
  publishable(categoryKey: Uint8Array, gender: number, component: number): Promise<boolean>;
  /**
   * The 10 bucket counts for one group, THROUGH the circuit.
   * For a group below k this returns all zeros — by design, not by accident.
   */
  histogram(categoryKey: Uint8Array, gender: number, component: number): Promise<number[]>;
  /** Total buckets actually read, for observability in the UI. */
  reads(): number;
};

export async function connectGatedReader(
  contractAddress: string,
  opts: { indexerUri: string; indexerWsUri: string; proverServerUri: string },
): Promise<GatedReader> {
  const providers = buildV2Providers({
    ...opts,
    walletProvider: undefined,
    midnightProvider: undefined,
  });
  const found = await findV2(providers, contractAddress, {});
  const query = (found.callTx as any).query;
  let reads = 0;

  const readK = async () => {
    reads += 1;
    return Number(await query.readK.readK());
  };
  const readEpoch = async () => {
    reads += 1;
    return Number(await query.readEpoch.readEpoch());
  };
  const readPublishable = async (
    categoryKey: Uint8Array,
    gender: number,
    component: number,
  ) => {
    reads += 1;
    const res = await query.isPublishable.isPublishable(
      categoryKey,
      BigInt(gender),
      BigInt(component),
    );
    return BigInt(res) === 1n;
  };
  const readHistogram = async (
    categoryKey: Uint8Array,
    gender: number,
    component: number,
  ): Promise<number[]> => {
    // One proof for all ten buckets, rather than ten. `getGroupHistogram`
    // applies the same anonymity gate `getHistogram` does — the gate is per
    // group, so there is nothing to lose and tenfold to gain.
    reads += 1;
    const res = (await query.getGroupHistogram.getGroupHistogram(
      categoryKey,
      BigInt(gender),
      BigInt(component),
    )) as Array<bigint | number> | { readonly length?: number };
    const asArray = Array.from(res as ArrayLike<bigint | number>);
    return Array.from({ length: BUCKET_COUNT }, (_, i) => Number(asArray[i] ?? 0));
  };

  return {
    address: contractAddress,
    k: readK,
    epoch: readEpoch,
    publishable: readPublishable,
    histogram: readHistogram,
    reads: () => reads,
  };
}

/**
 * Read a bucket through the CONTRACT's read circuit rather than raw state.
 *
 * This is the point of the v2 design: `getHistogram` returns 0 for any group
 * below the anonymity threshold, so reading a small group through the contract
 * cannot leak it. Reading raw ledger state would bypass that gate — which is
 * exactly why the report page must go through here.
 *
 * Prefer `connectGatedReader` when reading more than one bucket: it shares a
 * single contract connection.
 */
export async function readHistogramV2(
  providers: GotItV2Providers,
  contractAddress: string,
  opts: { categoryKey: Uint8Array; gender: number; component: number; bucket: number },
): Promise<bigint> {
  const found = await findV2(providers, contractAddress, {});
  const res = await (found.callTx as any).query.getHistogram.getHistogram(
    opts.categoryKey,
    BigInt(opts.gender),
    BigInt(opts.component),
    BigInt(opts.bucket),
  );
  return BigInt(res);
}

export async function readIsPublishableV2(
  providers: GotItV2Providers,
  contractAddress: string,
  opts: { categoryKey: Uint8Array; gender: number; component: number },
): Promise<boolean> {
  const found = await findV2(providers, contractAddress, {});
  const res = await (found.callTx as any).query.isPublishable.isPublishable(
    opts.categoryKey,
    BigInt(opts.gender),
    BigInt(opts.component),
  );
  return BigInt(res) === 1n;
}

export async function readKV2(providers: GotItV2Providers, contractAddress: string): Promise<number> {
  const found = await findV2(providers, contractAddress, {});
  const res = await (found.callTx as any).query.readK.readK();
  return Number(res);
}

export async function readEpochV2(providers: GotItV2Providers, contractAddress: string): Promise<number> {
  const found = await findV2(providers, contractAddress, {});
  const res = await (found.callTx as any).query.readEpoch.readEpoch();
  return Number(res);
}

/**
 * Decode a queryable ledger state with the generated v2 decoder.
 *
 * Used for the full-population read (which reporting groups exist, epoch,
 * member and nullifier counts). Note that this exposes raw map contents, which
 * BYPASSES the k-gate — so it is only ever used to discover which groups exist
 * and how large they are. Every published figure must come from
 * `readHistogramV2` instead. `assertNoSmallCellLeak` in the report layer is the
 * backstop on that rule.
 */
export function decodeV2State(state: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GotItV2Contract as any).ledger ? (GotItV2Contract as any).ledger(state.data ?? state) : null;
}

export { setNetworkId, DEFAULT_K };