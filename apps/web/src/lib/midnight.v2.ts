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
import { extractContractAddress } from "./deployResult";
import { makeLocalGatedReader } from "./localGatedReader";
import { asContractAddress } from "@midnight-ntwrk/midnight-js-types";
import {
  Contract as GotItV2Contract,
  ledger as decodeLedger,
} from "@gotit/contract/managed/gotit/contract";
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
  return extractContractAddress(deployed).address;
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

/**
 * The minimum provider set needed to fetch contract state.
 *
 * Reads need no wallet, no private state and no prover, so this deliberately
 * builds none of them: a reader who has never connected a wallet can still
 * produce a report, which is the whole point of the verification surface.
 */
function buildProvidersForReads(opts: { indexerUri: string; indexerWsUri: string }) {
  return {
    publicDataProvider: indexerPublicDataProvider(opts.indexerUri, opts.indexerWsUri),
  };
}

export async function connectGatedReader(
  contractAddress: string,
  _opts: { indexerUri: string; indexerWsUri: string; proverServerUri: string },
): Promise<GatedReader> {
  // Fetch the contract state once, then run the read circuits LOCALLY against it.
  //
  // The previous version called `found.callTx.query.getHistogram.getHistogram`, an
  // API that does not exist - `CircuitCallTxInterface` is a flat map of circuit ID
  // to function. Nothing caught it because the code only runs when a v2 contract
  // exists to be read, and the first time one did the report page failed with
  // "Cannot read properties of undefined (reading 'readK')".
  //
  // The literal correction, `callTx.getGroupHistogram(...)`, would have been worse:
  // that interface BUILDS AND SUBMITS A TRANSACTION, so reading a report would cost
  // DUST and a wallet approval per circuit call. Reads must not be transactions.
  //
  // Local evaluation runs the deployed circuit's own code, gate included. No proof,
  // no wallet, no transaction - and a reader who has never connected one can still
  // produce a report. See localGatedReader.ts.
  const providers = buildProvidersForReads(_opts);
  const state = await providers.publicDataProvider.queryContractState(
    asContractAddress(contractAddress) as any,
  );
  if (!state) {
    throw new Error(
      `no readable state for ${contractAddress}. Check the address, and that the indexer has ` +
        `indexed the contract.`,
    );
  }
  const local = makeLocalGatedReader(state, contractAddress);
  return {
    address: contractAddress,
    k: async () => local.k(),
    epoch: async () => local.epoch(),
    publishable: async (categoryKey, gender, component) =>
      local.publishable(categoryKey, gender, component),
    histogram: async (categoryKey, gender, component) =>
      local.histogram(categoryKey, gender, component),
    reads: () => local.reads(),
  };
}

export function decodeV2State(state: any) {
  // `ledger` is a MODULE-LEVEL export of the generated contract, not a static
  // method on the Contract class — `Contract.ledger` is `undefined`. This used to
  // call `GotItV2Contract.ledger(...)` guarded by a truthiness check, so it
  // silently returned null every single time.
  //
  // What that broke: every raw-state read. `readGroupSizes` and
  // `readGroupHistograms` both decode through here, so every configured group read
  // as zero participants — which the report rendered as `no-data · 0 participants`
  // for all 24 groups. It made five real on-chain submissions look like an empty
  // contract, and it defeated the label finder and the inventory, both of which
  // need the raw group counts.
  //
  // Throwing would have surfaced this immediately; returning null hid it behind a
  // plausible empty state.
  return decodeLedger(state?.data ?? state);
}

export { setNetworkId, DEFAULT_K };