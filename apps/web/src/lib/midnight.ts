/**
 * Browser-side Midnight wiring for GotIt — the REAL chain path.
 *
 * Follows the official midnightntwrk/example-bboard pattern:
 * - wallet detection scans window.midnight for ANY connector with a compatible
 *   apiVersion (Lace or others) — never a hardcoded key
 * - the wallet's own configuration supplies the proof-server and indexer URIs
 *   (Lace runs a prover internally; the witness/salary never leaves the device)
 * - balancing + submission are wrapped around the connected wallet API
 */
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { NETWORK_ID } from "./indexerConfig";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  deployContract,
  findDeployedContract,
  type DeployedContract,
  type FoundContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { toHex, fromHex, type ContractAddress, type SigningKey } from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import { Transaction } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import type { ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import type { PrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";
import { Contract as GotItContract } from "@gotit/contract/managed/candor/contract";
// NOTE: the "candor" literals below are the DEPLOYED CONTRACT's identifiers, not
// brand strings. They are inputs to the on-chain hash derivations and to the
// compiled artefact paths, so they must keep matching contract e7cf6ffc…dd53d.
// A redeploy that renames the Compact source can move them to "gotit"; until
// then, renaming them here would break loading of the live contract.
import { witnesses, createPrivateState, type GotItPrivateState } from "@gotit/contract/witnesses";
import { issuerCommitment } from "@gotit/shared/hash";
import { inMemoryPrivateStateProvider } from "./privateState";

export type GotItCircuitId = "submit" | "enroll" | "nextEpoch" | "getHistogram" | "readEpoch";

/** Compatible connector API major (aligns with example-bboard: '4.x') */
const COMPATIBLE_MAJOR = "4";

// ---- wallet detection (generic, per official examples) ---------------------

function getFirstCompatibleWallet(): InitialAPI | undefined {
  const midnight = (window as any).midnight as Record<string, InitialAPI> | undefined;
  if (!midnight) return undefined;
  const compatible = Object.values(midnight).filter(
    (wallet): wallet is InitialAPI =>
      !!wallet &&
      typeof wallet === "object" &&
      "apiVersion" in wallet &&
      typeof wallet.apiVersion === "string" &&
      wallet.apiVersion.split(".")[0] === COMPATIBLE_MAJOR,
  );
  // Prefer Lace if multiple wallets inject (rdns / name heuristics)
  return (
    compatible.find((w: any) => w.rdns === "io.lace.wallet" || w.name === "lace") ?? compatible[0]
  );
}


/** Fallback endpoints when the wallet's getConfiguration() is missing or fails. */
const FALLBACK_URIS = {
  indexerUri: "https://indexer.preprod.midnight.network/api/v4/graphql",
  indexerWsUri: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
  // Routed through the Vite dev proxy: Lace's service worker blocks direct
  // 127.0.0.1 fetches (ERR_FAILED), same-origin paths pass through.
  // Absolute because FetchZkConfigProvider/proof provider construct new URL(uri).
  proverServerUri: `${window.location.origin}/proof-server`,
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Connect to the first compatible wallet. Polls briefly — extensions inject
 * `window.midnight` after page load. Tries the v4 `connect()` flow first,
 * falls back to legacy `enable()`.
 */
export async function connectToWallet(networkId = NETWORK_ID): Promise<ConnectedAPI> {
  const deadline = Date.now() + 8_000;
  let initialAPI: InitialAPI | undefined;
  while (Date.now() < deadline) {
    initialAPI = getFirstCompatibleWallet();
    if (initialAPI) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  // Debug aid: shows which wallets injected and their API versions
  const midnight = (window as any).midnight as Record<string, any> | undefined;
  console.info(
    "[gotit] window.midnight wallets:",
    midnight ? Object.fromEntries(Object.entries(midnight).map(([k, v]) => [k, v?.apiVersion ?? "<no apiVersion>"])) : "none",
  );
  if (!initialAPI) {
    throw new Error("Could not find a Midnight wallet connector. Extension installed and enabled?");
  }
  console.info("[gotit] connector found, requesting connection…");

  const raw = initialAPI as unknown as Record<string, unknown>;
  let connectedAPI: ConnectedAPI;
  if (typeof raw.connect === "function") {
    // v4: connect() directly on the connector
    connectedAPI = await initialAPI.connect(networkId);
  } else if (typeof raw.enable === "function") {
    // legacy: enable() first, then optional connect()
    const enabled = await (raw.enable as () => Promise<any>)();
    const enabledRaw = enabled as unknown as Record<string, unknown>;
    connectedAPI =
      typeof enabledRaw.connect === "function"
        ? await (enabledRaw.connect as (id: string) => Promise<ConnectedAPI>)(networkId)
        : (enabled as ConnectedAPI);
  } else {
    throw new Error("Wallet connector exposes neither connect() nor enable()");
  }
  console.info("[gotit] wallet connected");
  return connectedAPI;
}

// ---- in-memory private state (per-session; the app re-seeds the secret) ----

// ---- provider assembly ------------------------------------------------------

export type GotItProviders = {
  connectedAPI: ConnectedAPI;
  zkConfigProvider: FetchZkConfigProvider<string>;
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
  privateStateProvider: PrivateStateProvider<string, GotItPrivateState>;
  proofProvider: ReturnType<typeof httpClientProofProvider>;
  walletProvider: unknown;
  midnightProvider: unknown;
};

/** Connect to the wallet and assemble the full provider bundle for GotIt. */
export async function connectGotIt(networkId = NETWORK_ID): Promise<GotItProviders> {
  // Required by midnight-js before any wallet/contract operation
  setNetworkId(networkId);
  const connectedAPI = await connectToWallet(networkId);

  console.info("[gotit] fetching wallet configuration…");
  let uris = { ...FALLBACK_URIS };
  try {
    const cfg = (await withTimeout(
      (connectedAPI as any).getConfiguration(),
      5_000,
      "getConfiguration",
    )) as Record<string, string>;
    uris = {
      indexerUri: cfg.indexerUri ?? cfg.indexerUrl ?? FALLBACK_URIS.indexerUri,
      indexerWsUri: cfg.indexerWsUri ?? cfg.indexerWsUrl ?? FALLBACK_URIS.indexerWsUri,
      // Always use the same-origin proxy for the prover: Lace's service worker
      // blocks direct 127.0.0.1 fetches from the page (ERR_FAILED).
      proverServerUri: FALLBACK_URIS.proverServerUri,
    };
    console.info("[gotit] wallet configuration:", cfg);
  } catch (e: any) {
    console.info("[gotit] getConfiguration unavailable, using fallback URIs:", e?.message ?? e);
  }
  console.info("[gotit] using endpoints:", uris);

  // Absolute origin required — the provider constructs new URL(base) internally
  const zkConfigProvider: FetchZkConfigProvider<string> = new FetchZkConfigProvider(
    `${window.location.origin}/zk/candor`,
    fetch.bind(window),
  );
  const privateStateProvider = inMemoryPrivateStateProvider<string, GotItPrivateState>();
  const proofProvider = httpClientProofProvider(uris.proverServerUri, zkConfigProvider as any);
  const publicDataProvider = indexerPublicDataProvider(uris.indexerUri, uris.indexerWsUri);

  console.info("[gotit] fetching shielded addresses…");
  const shieldedAddresses = await withTimeout(connectedAPI.getShieldedAddresses(), 10_000, "getShieldedAddresses");

  // WalletProvider wrapper — balances transactions through the wallet
  const walletProvider = {
    getCoinPublicKey: () => shieldedAddresses.shieldedCoinPublicKey,
    getEncryptionPublicKey: () => shieldedAddresses.shieldedEncryptionPublicKey,
    balanceTx: async (tx: any, _ttl?: Date) => {
      const serialized = toHex(tx.serialize());
      const received = await connectedAPI.balanceUnsealedTransaction(serialized);
      return Transaction.deserialize("signature", "proof", "binding", fromHex(received.tx));
    },
  };

  // MidnightProvider wrapper — submits finalized transactions through the wallet
  const midnightProvider = {
    submitTx: async (tx: any) => {
      await connectedAPI.submitTransaction(toHex(tx.serialize()));
      const txIdentifiers = tx.identifiers();
      return txIdentifiers[0];
    },
  };

  console.info("[gotit] providers ready");
  return {
    connectedAPI,
    zkConfigProvider,
    publicDataProvider,
    privateStateProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function compiledContract(): any {
  // keys/zkir are fetched from /zk/candor; witness code lives in @gotit/contract
  const withWitnessesFn = CompiledContract.withWitnesses as any;
  const withAssetsFn = CompiledContract.withCompiledFileAssets as any;
  return withAssetsFn(
    withWitnessesFn(CompiledContract.make("candor", GotItContract), witnesses),
    `${window.location.origin}/zk/candor`,
  );
}

type GotItInstance = InstanceType<typeof GotItContract>;
type Found = FoundContract<GotItInstance>;
export type DeployedGotIt = DeployedContract<GotItInstance>;

/**
 * Deploy GotIt. The connected wallet becomes the issuer: its private state
 * carries the issuerKey witness used by enroll/nextEpoch.
 */
export async function deployGotIt(providers: GotItProviders, issuerKey: Uint8Array): Promise<DeployedGotIt> {
  const ps: GotItPrivateState = { ...createPrivateState(), issuerKey };
  const deployed = (await deployContract(providers as any, {
    compiledContract: compiledContract(),
    privateStateId: "candor",
    initialPrivateState: ps,
    args: [issuerCommitment(issuerKey)],
  } as any)) as unknown as DeployedGotIt;
  return deployed;
}

/** Connect to an already-deployed GotIt instance. */
export async function findGotIt(
  providers: GotItProviders,
  contractAddress: string,
  opts: { asIssuer?: boolean; issuerKey?: Uint8Array; secret?: Uint8Array } = {},
): Promise<Found> {
  // The user secret must be the SAME persistent value on every call: it derives
  // both the membership leaf and the epoch nullifier inside the circuit.
  const ps = opts.asIssuer
    ? { ...createPrivateState(opts.secret), issuerKey: opts.issuerKey }
    : createPrivateState(opts.secret);
  return (await findDeployedContract(providers as any, {
    compiledContract: compiledContract(),
    contractAddress,
    privateStateId: "candor",
    initialPrivateState: ps,
  } as any)) as unknown as Found;
}

/** Submit one bucketed salary — real on-chain transaction via the wallet. */
export async function submitOnChain(
  providers: GotItProviders,
  contractAddress: string,
  opts: { cutKey: Uint8Array; bucket: number; secret: Uint8Array },
): Promise<any> {
  const found = await findGotIt(providers, contractAddress, { secret: opts.secret });
  return (found.callTx as any).submit(opts.cutKey, BigInt(opts.bucket));
}

/** Issuer-only: enroll a member leaf (operator wallet signs the tx). */
export async function enrollOnChain(
  providers: GotItProviders,
  contractAddress: string,
  opts: { memberLeaf: Uint8Array; issuerKey: Uint8Array },
): Promise<any> {
  const found = await findGotIt(providers, contractAddress, { asIssuer: true, issuerKey: opts.issuerKey });
  return (found.callTx as any).enroll(opts.memberLeaf);
}

/** Issuer-only: advance the epoch, re-opening submissions for everyone. */
export async function nextEpochOnChain(
  providers: GotItProviders,
  contractAddress: string,
  opts: { issuerKey: Uint8Array },
): Promise<any> {
  const found = await findGotIt(providers, contractAddress, { asIssuer: true, issuerKey: opts.issuerKey });
  return (found.callTx as any).nextEpoch();
}

// ---- session helpers (pure versions live in ./session; re-exported for convenience)

export { isLaceAvailable, getStoredContractAddress, setStoredContractAddress } from "./session";
