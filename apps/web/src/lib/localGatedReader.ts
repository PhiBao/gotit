/**
 * Gated reads by local circuit execution.
 *
 * HOW THIS WORKS, AND WHY IT REPLACED THE PREVIOUS APPROACH.
 *
 * The first version of this reader called `found.callTx.query.getHistogram.getHistogram(...)`.
 * That API does not exist. `CircuitCallTxInterface` is a flat map of circuit ID to
 * function — `callTx.getHistogram(...)` — and there is no `query` namespace. The
 * mistake shipped because nothing tested it: the report page simply failed with
 * "Cannot read properties of undefined (reading 'readK')" the first time a v2
 * contract existed to read.
 *
 * The obvious correction, `callTx.getGroupHistogram(...)`, would have been worse.
 * That interface BUILDS AND SUBMITS A TRANSACTION: reading a report would cost
 * DUST, need a wallet approval per circuit call, and take a proof per group. Reads
 * must not be transactions.
 *
 * So the read circuits are executed locally, against state fetched from the
 * indexer, using the generated contract's own code:
 *
 *   1. fetch the contract state (one indexer query)
 *   2. decode it with the generated ledger decoder
 *   3. call `contract.impureCircuits.getGroupHistogram(context, ...)` locally
 *
 * Step 3 runs the SAME circuit that is deployed, including its anonymity gate, so
 * a group below k really does return zeros — not because this file says so, but
 * because the gate is the first thing the circuit evaluates. No proof, no
 * transaction, no wallet, and it works for a reader who has never connected one.
 *
 * The alternative — trusting raw state and applying the gate in TypeScript — is
 * what the app did before, and it makes the contract's gate decorative. See
 * `gatedLogic.ts` for the cross-check that still runs on top.
 */
import {
  createCircuitContext,
  type ChargedState,
  type StateValue,
} from "@midnight-ntwrk/compact-runtime";
import { Contract as GotItContract } from "@gotit/contract/managed/gotit/contract";
import { witnesses } from "@gotit/contract/witnesses-v2";
import { BUCKET_COUNT } from "@gotit/shared";

/** A single read of the deployed contract's circuits, against fixed state. */
export type LocalGatedReader = {
  k(): number;
  epoch(): number;
  /** Bucket counts for one group, through `getGroupHistogram`. Zeros below k. */
  histogram(categoryKey: Uint8Array, gender: number, component: number): number[];
  /** Whether the group clears the threshold, through `isPublishable`. */
  publishable(categoryKey: Uint8Array, gender: number, component: number): boolean;
  /** How many circuits ran, for the diagnostics panel. */
  reads(): number;
};

/** The coin public key the context needs. Unused by read circuits. */
const COIN_PK = { bytes: new Uint8Array(32) } as any;

/**
 * Build a reader bound to one fetched contract state.
 *
 * `state` is what `indexerPublicDataProvider.queryContractState` returns. The
 * generated runtime accepts either a `ContractState` (wrapped) or the raw
 * `StateValue`, so accept both and unwrap.
 */
export function makeLocalGatedReader(state: unknown, contractAddress: string): LocalGatedReader {
  const contract = new GotItContract(witnesses);
  // Read circuits declare no witnesses, but the runtime needs a private state
  // object to build a context. An empty one is correct and sufficient.
  const privateState = {} as any;

  const raw = (state as any)?.data ?? state;
  let reads = 0;

  /**
   * Run one read circuit locally.
   *
   * A fresh context per call, because the runtime threads state through the
   * returned context and reusing one would let a read observe its own writes. The
   * read circuits do not write, but relying on that is how a read path becomes a
   * write path by accident later.
   */
  const run = <T>(fn: (ctx: any) => { result: T }): T => {
    reads += 1;
    const ctx = createCircuitContext(
      contractAddress as any,
      COIN_PK,
      raw as StateValue | ChargedState,
      privateState,
    );
    return fn(ctx).result;
  };

  return {
    k: () => Number(run((ctx) => contract.impureCircuits.readK(ctx))),
    epoch: () => Number(run((ctx) => contract.impureCircuits.readEpoch(ctx))),
    histogram: (categoryKey, gender, component) => {
      const out = run((ctx) =>
        contract.impureCircuits.getGroupHistogram(
          ctx,
          categoryKey,
          BigInt(gender),
          BigInt(component),
        ),
      );
      // The circuit returns Vector<10, Uint<64>>. Normalise to a plain number
      // array so nothing downstream depends on the runtime's vector type.
      const arr = Array.from(out as ArrayLike<bigint | number>);
      return Array.from({ length: BUCKET_COUNT }, (_, i) => Number(arr[i] ?? 0));
    },
    publishable: (categoryKey, gender, component) =>
      Number(
        run((ctx) =>
          contract.impureCircuits.isPublishable(ctx, categoryKey, BigInt(gender), BigInt(component)),
        ),
      ) === 1,
    reads: () => reads,
  };
}
