/**
 * Tests for the local gated reader, against the REAL generated contract.
 *
 * The previous reader was written against an API that did not exist
 * (`callTx.query.getHistogram.getHistogram`) and nothing caught it, because the
 * code only runs when a v2 contract exists to be read. It failed in the browser
 * with "Cannot read properties of undefined (reading 'readK')".
 *
 * So these tests build actual contract state by running the actual circuits, hand
 * it to the reader exactly as the indexer would, and assert on what comes back.
 * If the generated API changes shape again, this fails here rather than in front
 * of a judge.
 */
import { describe, it, expect } from "vitest";
import { createConstructorContext, createCircuitContext, dummyContractAddress } from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger as decodeLedger } from "@gotit/contract/managed/gotit/contract";
import { witnesses, createPrivateState, type GotItPrivateState } from "@gotit/contract/witnesses-v2";
import { categoryKeyBytes, issuerCommitment2, memberLeaf2 } from "@gotit/shared/hash";
import { GENDER, COMPONENT, DEFAULT_K } from "@gotit/shared/paygap";
import { makeLocalGatedReader } from "./localGatedReader.js";

const COIN_PK = { bytes: new Uint8Array(32) };

/** createCircuitContext parses the address, so it has to be real hex. */
const ADDR = "ab".repeat(32);

function secret32(n: number): Uint8Array {
  const s = new Uint8Array(32);
  s.fill(n);
  return s;
}

/** Deploy locally and return the final state, as the indexer would serve it. */
function stateWith(
  submissions: Array<{ gender: number; component: number; bucket: number; n: number }>,
  k = DEFAULT_K,
) {
  const issuerKey = secret32(1);
  const contract = new Contract<GotItPrivateState>(witnesses);
  const init = contract.initialState(
    createConstructorContext(createPrivateState(secret32(42)), COIN_PK),
    issuerCommitment2(issuerKey),
    BigInt(k),
  );
  let state: any = init.currentContractState;
  const CAT = categoryKeyBytes("engineering");

  const run = (fn: (ctx: any) => any, seed: number, asIssuer = false) => {
    const priv = asIssuer ? { secret: secret32(seed), issuerKey } : { secret: secret32(seed) };
    const ctx = createCircuitContext(dummyContractAddress(), COIN_PK, state, priv as GotItPrivateState);
    const r = fn(ctx);
    state = r.context.currentQueryContext.state;
    return r;
  };

  let seed = 1000;
  for (const group of submissions) {
    for (let i = 0; i < group.n; i++) {
      seed += 1;
      run((ctx) => contract.impureCircuits.enroll(ctx, memberLeaf2(secret32(seed))), seed, true);
      run(
        (ctx) =>
          contract.impureCircuits.submit(
            ctx,
            CAT,
            BigInt(group.gender),
            BigInt(group.component),
            BigInt(group.bucket),
          ),
        seed,
      );
    }
  }
  return { state, CAT };
}

describe("the reader runs the contract's own circuits", () => {
  it("reads k from the deployed contract", () => {
    const { state } = stateWith([], 7);
    const r = makeLocalGatedReader(state, ADDR);
    expect(r.k()).toBe(7);
  });

  it("reads the epoch", () => {
    const { state } = stateWith([]);
    expect(makeLocalGatedReader(state, ADDR).epoch()).toBe(1);
  });

  it("returns the whole group histogram through getGroupHistogram", () => {
    const { state, CAT } = stateWith([
      { gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3, n: 6 },
      { gender: GENDER.MALE, component: COMPONENT.BASE, bucket: 5, n: 7 },
    ]);
    const r = makeLocalGatedReader(state, ADDR);
    const women = r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE);
    expect(women).toHaveLength(10);
    expect(women[3]).toBe(6);
    expect(women.reduce((a, b) => a + b, 0)).toBe(6);
    const men = r.histogram(CAT, GENDER.MALE, COMPONENT.BASE);
    expect(men[5]).toBe(7);
  });

  it("PINS THE GATE: a group below k reads as zeros, not as its counts", () => {
    // Three people, k=5. The contract records them; the read circuit refuses.
    // If this returns 3, the gate is not being enforced by the path the report
    // uses, which is the whole claim.
    const { state, CAT } = stateWith([
      { gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 6, n: 3 },
    ]);
    const r = makeLocalGatedReader(state, ADDR);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE)).toEqual(new Array(10).fill(0));
    expect(r.publishable(CAT, GENDER.FEMALE, COMPONENT.BASE)).toBe(false);

    // ...and the raw ledger really does hold the figures, so the zeros above are
    // the gate refusing rather than an empty contract.
    const led = decodeLedger((state as any).data ?? state) as any;
    expect(led.groupCount.size()).toBe(1n);
  });

  it("returns real counts once the group clears k", () => {
    const { state, CAT } = stateWith([
      { gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 6, n: 5 },
    ]);
    const r = makeLocalGatedReader(state, ADDR);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE)[6]).toBe(5);
    expect(r.publishable(CAT, GENDER.FEMALE, COMPONENT.BASE)).toBe(true);
  });

  it("gates each group independently, so a crowd cannot lift a small group", () => {
    const { state, CAT } = stateWith([
      { gender: GENDER.MALE, component: COMPONENT.BASE, bucket: 6, n: 40 },
      { gender: GENDER.FEMALE, component: COMPONENT.VARIABLE, bucket: 2, n: 2 },
    ]);
    const r = makeLocalGatedReader(state, ADDR);
    expect(r.histogram(CAT, GENDER.MALE, COMPONENT.BASE)[6]).toBe(40);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.VARIABLE)).toEqual(new Array(10).fill(0));
  });

  it("keeps base and variable separate", () => {
    const { state, CAT } = stateWith([
      { gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3, n: 6 },
      { gender: GENDER.FEMALE, component: COMPONENT.VARIABLE, bucket: 8, n: 6 },
    ]);
    const r = makeLocalGatedReader(state, ADDR);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE)[3]).toBe(6);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE)[8]).toBe(0);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.VARIABLE)[8]).toBe(6);
    expect(r.histogram(CAT, GENDER.FEMALE, COMPONENT.VARIABLE)[3]).toBe(0);
  });

  it("returns zeros for a group nobody joined, without throwing", () => {
    const { state } = stateWith([]);
    const r = makeLocalGatedReader(state, ADDR);
    expect(r.histogram(categoryKeyBytes("sales"), GENDER.FEMALE, COMPONENT.BASE)).toEqual(
      new Array(10).fill(0),
    );
    expect(r.publishable(categoryKeyBytes("sales"), GENDER.FEMALE, COMPONENT.BASE)).toBe(false);
  });

  it("counts its reads, so the diagnostics panel can report the cost", () => {
    const { state, CAT } = stateWith([{ gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3, n: 6 }]);
    const r = makeLocalGatedReader(state, ADDR);
    const before = r.reads();
    r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE);
    expect(r.reads()).toBe(before + 1);
  });

  it("does not mutate the state it was given", () => {
    const { state, CAT } = stateWith([{ gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3, n: 6 }]);
    const before = decodeLedger((state as any).data ?? state) as any;
    const sizeBefore = before.histogram.size();
    const r = makeLocalGatedReader(state, ADDR);
    r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE);
    const after = decodeLedger((state as any).data ?? state) as any;
    expect(after.histogram.size()).toBe(sizeBefore);
  });

  it("reads consistently across repeated calls", () => {
    const { state, CAT } = stateWith([{ gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 4, n: 9 }]);
    const r = makeLocalGatedReader(state, ADDR);
    const a = r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE);
    const b = r.histogram(CAT, GENDER.FEMALE, COMPONENT.BASE);
    expect(a).toEqual(b);
  });
});
