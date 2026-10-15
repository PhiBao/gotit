/**
 * Reading the contract address out of a deploy result.
 *
 * Its own module because it is pure: no wallet, no chain, no `window`. Both
 * `midnight.ts` and `midnight.v2.ts` import `window.location` at module scope to
 * build same-origin proxy URIs, so anything that lived there could not be tested
 * in Node — and this is precisely the code that needed a test.
 *
 * WHY THIS EXISTS. `deployV2` returned `deployed.contractAddress`, which the
 * type declares on `DeployedContract` and which was `undefined` at runtime. The
 * app then stored the string "undefined" as the contract address and told the
 * operator "v2 deployed at undefined". The deploy had gone through; only the
 * address was lost, and losing it silently is worse than failing, because nobody
 * can tell whether they own a contract.
 *
 * The address appears in more than one place depending on the path —
 * `FoundContract.contractAddress`, or `deployTxData.public.contractAddress` on
 * the transaction data. Rather than pick one and be wrong again, candidates are
 * checked in order of directness, only a plausible address is accepted, and a
 * miss THROWS with the result's own keys in the message.
 */

/** A Midnight contract address: 64 hex, optionally 0x-prefixed. */
export function isPlausibleAddress(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v.replace(/^0x/, ""));
}

/** Where the address was found, so a caller can log the shape it hit. */
export type AddressSource =
  | "contractAddress"
  | "deployTxData.public.contractAddress"
  | "callTx.contractAddress"
  | "deployTxData.public.address";

export type ExtractedAddress = { address: string; source: AddressSource };

/** The candidates, in order of directness. */
function candidates(d: any): Array<[AddressSource, unknown]> {
  return [
    ["contractAddress", d?.contractAddress],
    ["deployTxData.public.contractAddress", d?.deployTxData?.public?.contractAddress],
    ["callTx.contractAddress", d?.callTx?.contractAddress],
    ["deployTxData.public.address", d?.deployTxData?.public?.address],
  ];
}

/** A description of the object's shape, for the failure message. */
function describeShape(d: any): string {
  try {
    return JSON.stringify(
      {
        topLevel: Object.keys(d ?? {}),
        deployTxData: d?.deployTxData ? Object.keys(d.deployTxData) : null,
        public: d?.deployTxData?.public ? Object.keys(d.deployTxData.public) : null,
        callTx: d?.callTx ? Object.keys(d.callTx) : null,
      },
      null,
      1,
    );
  } catch {
    return "(unserialisable)";
  }
}

/**
 * Extract the address, or throw.
 *
 * Throwing is the important part. A caller that gets `undefined` cannot tell a
 * failed deploy from a successful one, and the failure surfaces later as a
 * report page blaming the ledger.
 */
export function extractContractAddress(deployed: unknown): ExtractedAddress {
  const d = deployed as any;
  for (const [source, value] of candidates(d)) {
    if (isPlausibleAddress(value)) {
      return { address: value.replace(/^0x/, ""), source };
    }
  }
  throw new Error(
    `the contract deployed, but its address could not be read from the result. ` +
      `The transaction may still have gone through — check the wallet before retrying. ` +
      `Result shape: ${describeShape(d)}`,
  );
}

/**
 * The address as a plain string, for call sites that do not need the source.
 * Same rule, same failure.
 */
export function deployedAddress(deployed: unknown): string {
  return extractContractAddress(deployed).address;
}
