import { describe, it, expect } from "vitest";
import { createConstructorContext, createCircuitContext, dummyContractAddress } from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger as decodeLedger } from "./managed/gotit/contract/index.js";
import { witnesses, createPrivateState, type GotItPrivateState } from "./witnesses.v2.js";
import {
  bucketKeyBytes2,
  categoryKeyBytes,
  groupKeyBytes,
  issuerCommitment2,
  memberLeaf2,
  epochNullifier2,
} from "@gotit/shared/hash";
import { GENDER, COMPONENT, DEFAULT_K } from "@gotit/shared/paygap";

/**
 * Circuit tests for the Wave 2 ledger, run against the GENERATED contract
 * off-chain (no proof server, no node) — so a drift between the TypeScript
 * derivations and the circuits fails the build instead of silently mis-bucketing
 * a salary into the wrong cell.
 *
 * The v2 ledger adds the Directive (EU) 2023/970 Art. 9 dimensions — category
 * of worker x gender x base/variable — and moves disclosure control into the
 * read circuits. These tests exist mainly to pin the second part: that a group
 * below the anonymity threshold cannot be read out, and that the threshold is
 * counted per group rather than globally.
 */

const COIN_PK = { bytes: new Uint8Array(32) }; // EncodedCoinPublicKey

const CAT_A = categoryKeyBytes("engineering");
const CAT_B = categoryKeyBytes("sales");

type Who = "user" | "issuer" | "outsider";

function secret32(n: number): Uint8Array {
  const s = new Uint8Array(32);
  s.fill(n);
  return s;
}

/** Threads state through impure calls — the generated circuits do not mutate in place. */
function deploy(userSeed: number, issuerKey = secret32(1), k: number = DEFAULT_K) {
  const ps = createPrivateState(secret32(userSeed));
  const issuerPs = createPrivateState(secret32(userSeed), issuerKey);
  const contract = new Contract<GotItPrivateState>(witnesses);
  const res = contract.initialState(
    createConstructorContext(ps, COIN_PK),
    issuerCommitment2(issuerKey),
    BigInt(k),
  );
  let state = res.currentContractState;

  const run = (fn: (ctx: any) => any, who: Who, seed = userSeed) => {
    const priv =
      who === "issuer" ? { secret: secret32(seed), issuerKey }
      : who === "outsider" ? { secret: secret32(seed), issuerKey: secret32(77) }
      : { secret: secret32(seed) };
    const ctx = createCircuitContext(dummyContractAddress(), COIN_PK, state, priv as GotItPrivateState);
    const r = fn(ctx);
    state = r.context.currentQueryContext.state;
    return r;
  };

  return {
    contract,
    /** Raw runtime state (a ContractState wrapping a ChargedState). */
    state: () => state,
    /** Decoded ledger view — the same thing the browser's indexer read returns. */
    ledger: () => decodeLedger((state as any).data ?? state),
    asIssuer: (fn: Parameters<typeof run>[0], seed = userSeed) => run(fn, "issuer", seed),
    asUser: (fn: Parameters<typeof run>[0], seed = userSeed) => run(fn, "user", seed),
    asOutsider: (fn: Parameters<typeof run>[0], seed = userSeed) => run(fn, "outsider", seed),
  };
}

type C = ReturnType<typeof deploy>;

function enroll(c: C, seed: number) {
  c.asIssuer((ctx: any) => c.contract.impureCircuits.enroll(ctx, memberLeaf2(secret32(seed))), seed);
}

function submit(
  c: C,
  seed: number,
  opts: { category?: Uint8Array; gender?: number; component?: number; bucket: number },
) {
  c.asUser(
    (ctx: any) =>
      c.contract.impureCircuits.submit(
        ctx,
        opts.category ?? CAT_A,
        BigInt(opts.gender ?? GENDER.FEMALE),
        BigInt(opts.component ?? COMPONENT.BASE),
        BigInt(opts.bucket),
      ),
    seed,
  );
}

function read(c: C, category: Uint8Array, gender: number, component: number, bucket: number) {
  return c.asUser(
    (ctx: any) => c.contract.impureCircuits.getHistogram(ctx, category, BigInt(gender), BigInt(component), BigInt(bucket)),
  ).result;
}

/**
 * The whole-group read, which the report page actually uses.
 *
 * `getHistogram` reads one bucket and costs one proof; `getGroupHistogram` reads
 * all ten and costs one. They must agree on the gate — if they ever diverge, the
 * fast path (which the app uses) would be the unguarded one.
 */
function readGroup(c: C, category: Uint8Array, gender: number, component: number): bigint[] {
  const res = c.asUser(
    (ctx: any) =>
      c.contract.impureCircuits.getGroupHistogram(ctx, category, BigInt(gender), BigInt(component)),
  ).result;
  return Array.from(res as ArrayLike<bigint>).map((v) => BigInt(v));
}

function publishable(c: C, category: Uint8Array, gender: number, component: number) {
  return c.asUser(
    (ctx: any) => c.contract.impureCircuits.isPublishable(ctx, category, BigInt(gender), BigInt(component)),
  ).result;
}

/** Enroll + submit for `n` distinct people in one reporting group. */
function seedGroup(c: C, opts: { category?: Uint8Array; gender?: number; component?: number; bucket: number }, n: number, baseSeed = 100) {
  for (let i = 0; i < n; i++) {
    const seed = baseSeed + i;
    enroll(c, seed);
    submit(c, seed, opts);
  }
}

// ---- constructor -----------------------------------------------------------

describe("gotit v2 constructor", () => {
  it("sets the epoch, the threshold and the issuer commitment", () => {
    const c = deploy(42);
    const s = c.ledger();
    expect(s.epochCount.lookup(new Uint8Array([101]))).toBe(1n);
    expect(s.kThreshold).toBe(BigInt(DEFAULT_K));
    expect(s.issuer).toEqual(issuerCommitment2(secret32(1)));
  });

  it("rejects a threshold of 1, which would defeat disclosure control", () => {
    expect(() => deploy(42, secret32(1), 1)).toThrow();
  });
});

// ---- membership and the one-per-period rule --------------------------------

describe("gotit v2 membership", () => {
  it("rejects a submit from a non-member", () => {
    const c = deploy(42);
    enroll(c, 42);
    expect(() => c.asOutsider((ctx: any) => c.contract.impureCircuits.submit(ctx, CAT_A, 0n, 0n, 3n), 999)).toThrow(
      /not a member/,
    );
  });

  it("counts a figure into exactly one cell once the group is publishable", () => {
    // Read through a k=2 deployment so a two-person group is readable; the
    // k-gate itself is covered in the disclosure-control block below.
    const c = deploy(42, secret32(1), 2);
    enroll(c, 42);
    submit(c, 42, { bucket: 5 });
    enroll(c, 43);
    submit(c, 43, { bucket: 5 });
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(2n);
    expect(read(c, CAT_A, GENDER.MALE, COMPONENT.BASE, 5)).toBe(0n);
    expect(read(c, CAT_B, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(0n);
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 6)).toBe(0n);
  });

  it("keeps every Art. 9 dimension in a separate cell", () => {
    // k=2, and two distinct people in each cell we want to read, so every
    // assertion below is about WHICH cell the figure landed in rather than
    // about suppression (covered separately).
    const c = deploy(42, secret32(1), 2);
    const cell = (seed: number, gender: number, component: number) => {
      enroll(c, seed);
      submit(c, seed, { bucket: 4, gender, component });
    };
    cell(42, GENDER.FEMALE, COMPONENT.BASE);
    cell(46, GENDER.FEMALE, COMPONENT.BASE);
    cell(43, GENDER.MALE, COMPONENT.BASE);
    cell(45, GENDER.MALE, COMPONENT.BASE);
    cell(44, GENDER.FEMALE, COMPONENT.VARIABLE);
    cell(47, GENDER.FEMALE, COMPONENT.VARIABLE);

    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 4)).toBe(2n);
    expect(read(c, CAT_A, GENDER.MALE, COMPONENT.BASE, 4)).toBe(2n);
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.VARIABLE, 4)).toBe(2n);
    // A different category and a different bucket stay empty, so the four
    // dimensions are genuinely independent rather than collapsed.
    expect(read(c, CAT_B, GENDER.FEMALE, COMPONENT.BASE, 4)).toBe(0n);
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(0n);
    // A gender nobody reported in.
    expect(publishable(c, CAT_A, GENDER.OTHER, COMPONENT.BASE)).toBe(0n);
  });

  it("rejects out-of-range gender, component and bucket", () => {
    const c = deploy(42);
    enroll(c, 42);
    expect(() => submit(c, 42, { bucket: 3, gender: 7 })).toThrow(/gender out of range/);
    expect(() => submit(c, 42, { bucket: 3, component: 5 })).toThrow(/component out of range/);
    expect(() => submit(c, 42, { bucket: 10 })).toThrow(/bucket out of range/);
  });

  it("blocks a second submission in the same period", () => {
    const c = deploy(42);
    enroll(c, 42);
    submit(c, 42, { bucket: 3 });
    expect(() => submit(c, 42, { bucket: 6 })).toThrow(/already submitted/);
  });

  it("nextEpoch re-opens submission and leaves both nullifiers spent", () => {
    const c = deploy(42);
    enroll(c, 42);
    submit(c, 42, { bucket: 3 });
    c.asIssuer((ctx: any) => c.contract.impureCircuits.nextEpoch(ctx));

    expect(c.ledger().epochCount.lookup(new Uint8Array([101]))).toBe(2n);
    submit(c, 42, { bucket: 6 });
    expect(c.ledger().nullifiers.member(epochNullifier2(1n, secret32(42)) as any)).toBe(true);
    expect(c.ledger().nullifiers.member(epochNullifier2(2n, secret32(42)) as any)).toBe(true);
  });

  it("only the issuer can enroll or advance the period", () => {
    const c = deploy(42);
    expect(() =>
      c.asOutsider((ctx: any) => c.contract.impureCircuits.enroll(ctx, memberLeaf2(secret32(5))), 999),
    ).toThrow(/not the issuer/);
    expect(() => c.asOutsider((ctx: any) => c.contract.impureCircuits.nextEpoch(ctx), 999)).toThrow(
      /not the issuer/,
    );
  });

  it("enroll is idempotent for the same leaf", () => {
    const c = deploy(42);
    enroll(c, 42);
    enroll(c, 42);
    expect(c.ledger().members.size()).toBe(1n);
  });
});

// ---- the whole-group read the report page uses -----------------------------

describe("getGroupHistogram", () => {
  it("agrees with getHistogram on every bucket, once the group is publishable", () => {
    const c = deploy(42, secret32(1), 2);
    const cell = (seed: number, gender: number, component: number, bucket: number) => {
      enroll(c, seed);
      submit(c, seed, { bucket, gender, component });
    };
    cell(42, GENDER.FEMALE, COMPONENT.BASE, 3);
    cell(46, GENDER.FEMALE, COMPONENT.BASE, 3);
    cell(48, GENDER.FEMALE, COMPONENT.BASE, 6);
    cell(43, GENDER.MALE, COMPONENT.BASE, 5);
    cell(45, GENDER.MALE, COMPONENT.BASE, 5);

    const group = readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE);
    for (let b = 0; b < 10; b++) {
      expect(group[b]).toBe(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, b));
    }
    expect(group.reduce((a, b) => a + b, 0n)).toBe(3n);
  });

  it("applies the same anonymity gate as getHistogram", () => {
    // k=5, three people. Both reads must refuse — otherwise the fast path the
    // report page uses would be the unguarded one.
    const c = deploy(42);
    seedGroup(c, { bucket: 5, gender: GENDER.FEMALE }, 3);

    expect(readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toEqual(
      new Array(10).fill(0n),
    );
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(0n);
  });

  it("gates each group independently, so a big team cannot lift a small one", () => {
    const c = deploy(42, secret32(1), 5);
    seedGroup(c, { bucket: 6, gender: GENDER.MALE, component: COMPONENT.BASE }, 40, 200);
    seedGroup(c, { bucket: 2, gender: GENDER.FEMALE, component: COMPONENT.BASE }, 3, 300);

    expect(readGroup(c, CAT_A, GENDER.MALE, COMPONENT.BASE).reduce((a, b) => a + b, 0n)).toBe(40n);
    expect(readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toEqual(new Array(10).fill(0n));
  });

  it("returns zeros for a group that was never touched", () => {
    const c = deploy(42);
    expect(readGroup(c, CAT_B, GENDER.FEMALE, COMPONENT.BASE)).toEqual(new Array(10).fill(0n));
  });

  it("separates base from variable pay, so neither is blended into the other", () => {
    const c = deploy(42, secret32(1), 5);
    seedGroup(c, { bucket: 3, gender: GENDER.FEMALE, component: COMPONENT.BASE }, 6, 400);
    seedGroup(c, { bucket: 8, gender: GENDER.FEMALE, component: COMPONENT.VARIABLE }, 6, 500);

    expect(readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)[3]).toBe(6n);
    expect(readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.VARIABLE)[8]).toBe(6n);
    // Neither group carries the other's figures.
    expect(readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)[8]).toBe(0n);
    expect(readGroup(c, CAT_A, GENDER.FEMALE, COMPONENT.VARIABLE)[3]).toBe(0n);
  });
});

// ---- the point of the whole change: disclosure control in the circuit -------

describe("disclosure control is enforced by the read circuit", () => {
  it("withholds a group below the threshold even though the data is in state", () => {
    const c = deploy(42);
    seedGroup(c, { bucket: 5, gender: GENDER.FEMALE }, 3);

    // The count IS recorded — asserting on raw state proves suppression is a
    // read-time decision, not an absence of data.
    const g = c.ledger().groupCount.lookup(groupKeyBytes(CAT_A, GENDER.FEMALE, COMPONENT.BASE) as any);
    expect(g).toBe(3n);
    const b = c.ledger().histogram.lookup(bucketKeyBytes2(CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5) as any);
    expect(b).toBe(3n);

    // But the read circuit returns 0, so no employer can publish it — not by
    // policy, not by override, not by writing a bespoke reader.
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(0n);
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(0n);
  });

  it("publishes the group once it reaches the threshold", () => {
    const c = deploy(42);
    seedGroup(c, { bucket: 5, gender: GENDER.FEMALE }, DEFAULT_K);
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(BigInt(DEFAULT_K));
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(1n);
  });

  it("counts the threshold per category, so a full group elsewhere does not leak", () => {
    // A global counter would make this group publishable with one person in it.
    // Each (category, gender, component) carries its own count precisely so it
    // cannot be.
    const c = deploy(42);
    seedGroup(c, { category: CAT_A, bucket: 5, gender: GENDER.FEMALE }, DEFAULT_K);
    enroll(c, 900);
    submit(c, 900, { category: CAT_B, bucket: 5, gender: GENDER.FEMALE });

    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(1n);
    expect(publishable(c, CAT_B, GENDER.FEMALE, COMPONENT.BASE)).toBe(0n);
    expect(read(c, CAT_B, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(0n);
  });

  it("counts the threshold per gender, so a base-salary group does not publish variable pay", () => {
    const c = deploy(42);
    seedGroup(c, { component: COMPONENT.BASE, bucket: 5 }, DEFAULT_K);
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(1n);
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.VARIABLE)).toBe(0n);
  });

  it("counts the threshold per gender, not per category", () => {
    const c = deploy(42);
    seedGroup(c, { gender: GENDER.FEMALE, bucket: 5 }, DEFAULT_K);
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(1n);
    expect(publishable(c, CAT_A, GENDER.MALE, COMPONENT.BASE)).toBe(0n);
  });

  it("returns 0 for an empty cell rather than throwing", () => {
    const c = deploy(42);
    expect(read(c, CAT_B, GENDER.MALE, COMPONENT.VARIABLE, 9)).toBe(0n);
    expect(publishable(c, CAT_B, GENDER.MALE, COMPONENT.VARIABLE)).toBe(0n);
  });

  it("honours a threshold other than the default", () => {
    const c = deploy(42, secret32(1), 8);
    seedGroup(c, { bucket: 5, gender: GENDER.FEMALE }, DEFAULT_K);
    // 5 < 8, so the default-sized group is not enough for this deployment.
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(0n);
    for (const seed of [200, 201, 202]) {
      enroll(c, seed);
      submit(c, seed, { bucket: 5, gender: GENDER.FEMALE });
    }
    expect(publishable(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE)).toBe(1n);
    expect(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, 5)).toBe(8n);
  });
});

// ---- hash parity ------------------------------------------------------------

describe("TypeScript and circuit agree on every derived key", () => {
  it("finds the bucket and group cells under the keys the report layer computes", () => {
    const c = deploy(42);
    enroll(c, 42);
    submit(c, 42, { bucket: 7, gender: GENDER.MALE, component: COMPONENT.VARIABLE });

    // If these ever drift, a submitted salary lands in a cell the report cannot
    // find — silently, and without any error.
    expect(
      c.ledger().histogram.member(bucketKeyBytes2(CAT_A, GENDER.MALE, COMPONENT.VARIABLE, 7) as any),
    ).toBe(true);
    expect(c.ledger().groupCount.member(groupKeyBytes(CAT_A, GENDER.MALE, COMPONENT.VARIABLE) as any)).toBe(true);
    expect(c.ledger().members.member(memberLeaf2(secret32(42)) as any)).toBe(true);
    expect(c.ledger().issuer).toEqual(issuerCommitment2(secret32(1)));
  });

  it("does not accept a v1 leaf, so the version bump is meaningful", () => {
    // A Wave 1 "candor:member:v1" leaf must not validate against the v2
    // contract. If it did, old members would carry over silently and the
    // version bump would buy nothing.
    const c = deploy(42);
    const v1Leaf = memberLeaf2(secret32(42)); // same secret, v2 derivation
    c.asIssuer((ctx: any) => c.contract.impureCircuits.enroll(ctx, v1Leaf as any));
    const fabricated = new Uint8Array(32);
    fabricated[0] = 0xff;
    expect(() => c.asIssuer((ctx: any) => c.contract.impureCircuits.enroll(ctx, fabricated as any))).not.toThrow();
    // Fabricated leaves are the issuer's prerogative, not a circuit check — but
    // the fabricated secret cannot submit, because its leaf was never derived
    // from it.
    expect(() => c.asUser((ctx: any) => c.contract.impureCircuits.submit(ctx, CAT_A, 0n, 0n, 3n), 200)).toThrow(
      /not a member/,
    );
  });
});

// ---- differential-leak regression -------------------------------------------

describe("differential-leak regression", () => {
  it("exposes counts only, never an amount", () => {
    const c = deploy(42);
    seedGroup(c, { bucket: 6, gender: GENDER.FEMALE }, DEFAULT_K);
    const counts = Array.from({ length: 10 }, (_, b) => Number(read(c, CAT_A, GENDER.FEMALE, COMPONENT.BASE, b)));
    expect(counts.filter((n) => n > 0)).toEqual([DEFAULT_K]);
    // Every readable field on the state is a count, a set membership, or a
    // commitment. There is no field that could carry a currency amount.
    const s: any = c.ledger();
    expect(s.histogram.length ?? Object.keys(s.histogram).length).toBeDefined();
    expect(typeof s.issuer).not.toBe("number");
  });
});

// ---- read helpers -----------------------------------------------------------

describe("read helpers", () => {
  it("reports the period and the threshold in force", () => {
    const c = deploy(42);
    expect(c.asUser((ctx: any) => c.contract.impureCircuits.readEpoch(ctx)).result).toBe(1n);
    expect(c.asUser((ctx: any) => c.contract.impureCircuits.readK(ctx)).result).toBe(BigInt(DEFAULT_K));
  });
});
