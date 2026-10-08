/**
 * The chain-to-report path, tested against the REAL generated v2 contract.
 *
 * This is the test that was missing. Every other report test fed `buildReport`
 * hand-built histograms, so a mismatch between how the ledger stores counts and
 * how the report reads them was invisible until someone looked at a live report
 * and saw "no data, 0 participants" where there were 15 people.
 *
 * Here the whole path runs: submit through the generated circuits, take the
 * resulting state, decode it, shape it, build the report. If the ledger, the hash
 * derivations, the shaping or the engine disagree, this fails.
 */
import { describe, it, expect } from "vitest";
import { createConstructorContext, createCircuitContext, dummyContractAddress } from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger as decodeLedger } from "./managed/gotit/contract/index.js";
import { witnesses, createPrivateState, type GotItPrivateState } from "./witnesses.v2.js";
import { bucketKeyBytes2, categoryKeyBytes, groupKeyBytes, issuerCommitment2, memberLeaf2 } from "@gotit/shared/hash";
import { GENDER, COMPONENT, DEFAULT_K, buildReport } from "@gotit/shared/paygap";
import { shapeChainRows, toEngineInput, type V2LedgerView } from "./chainRead.logic.js";

const COIN_PK = { bytes: new Uint8Array(32) };
const CAT_ENG = categoryKeyBytes("engineering");
const CAT_SALES = categoryKeyBytes("sales");

function secret32(n: number): Uint8Array {
  const s = new Uint8Array(32);
  s.fill(n);
  return s;
}

/** Deploy locally and thread state through impure calls, as the circuit tests do. */
function deploy(k = DEFAULT_K) {
  const issuerKey = secret32(1);
  const contract = new Contract<GotItPrivateState>(witnesses);
  const res = contract.initialState(
    createConstructorContext(createPrivateState(secret32(42)), COIN_PK),
    issuerCommitment2(issuerKey),
    BigInt(k),
  );
  let state: any = res.currentContractState;

  const run = (fn: (ctx: any) => any, asIssuer: boolean, seed: number) => {
    const priv = asIssuer
      ? { secret: secret32(seed), issuerKey }
      : { secret: secret32(seed) };
    const ctx = createCircuitContext(dummyContractAddress(), COIN_PK, state, priv as GotItPrivateState);
    const r = fn(ctx);
    state = r.context.currentQueryContext.state;
    return r;
  };

  return {
    enroll: (seed: number) =>
      run((ctx) => contract.impureCircuits.enroll(ctx, memberLeaf2(secret32(seed))), true, seed),
    submit: (seed: number, category: Uint8Array, gender: number, component: number, bucket: number) =>
      run(
        (ctx) =>
          contract.impureCircuits.submit(ctx, category, BigInt(gender), BigInt(component), BigInt(bucket)),
        false,
        seed,
      ),
    /** The decoded ledger, which is what chainRead.logic consumes. */
    ledger: (): V2LedgerView => {
      const led = decodeLedger(state.data ?? state) as any;
      return {
        histogram: led.histogram,
        groupCount: led.groupCount,
        kThreshold: led.kThreshold,
      };
    },
  };
}

/** Submit `n` distinct people into one group. */
let seedCursor = 100;

function seedGroup(
  c: ReturnType<typeof deploy>,
  n: number,
  opts: { category: Uint8Array; gender: number; component: number; bucket: number },
) {
  // Each group gets its own range. The nullifier is hash(secret, epoch), so two
  // groups sharing a person would make the second submit fail with "already
  // submitted this period" - correct circuit behaviour, and a bug in the fixture
  // when it happens. Auto-advancing makes that impossible to hit by accident.
  const baseSeed = seedCursor;
  seedCursor += n;
  for (let i = 0; i < n; i++) {
    const seed = baseSeed + i;
    c.enroll(seed);
    c.submit(seed, opts.category, opts.gender, opts.component, opts.bucket);
  }
}

const readOpts = {
  bucketKeys: bucketKeyBytes2,
  groupKeys: groupKeyBytes,
  categoryKeys: categoryKeyBytes,
};

describe("chain state -> report rows, against the real generated contract", () => {
  it("counts submissions into the right cells through the contract", () => {
    const c = deploy();
    seedGroup(c, 6, {
      category: CAT_ENG,
      gender: GENDER.FEMALE,
      component: COMPONENT.BASE,
      bucket: 3,
    });
    seedGroup(c, 7, {
      category: CAT_ENG,
      gender: GENDER.MALE,
      component: COMPONENT.BASE,
      bucket: 5,
    });

    const { rows } = shapeChainRows(c.ledger(), { categories: ["engineering"], ...readOpts });
    const base = rows.find((r) => r.category.includes("Base salary"))!;
    expect(base.referenceSize).toBe(6);
    expect(base.comparisonSize).toBe(7);
    // The histogram cell is where the shapes says it is.
    expect(base.reference[3]).toBe(6);
    expect(base.comparison[5]).toBe(7);
    expect(base.reference.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("FIX 1 REGRESSION: a variable-pay group produces a report row, not 'no data'", () => {
    // The bug: the app built a variable row's `total` as zeros, so the engine saw
    // an empty group and suppressed it. This asserts the whole chain-to-engine
    // path carries a real population for the variable component.
    const c = deploy();
    seedGroup(c, 6, {
      category: CAT_ENG,
      gender: GENDER.FEMALE,
      component: COMPONENT.VARIABLE,
      bucket: 5,
    });
    seedGroup(c, 7, {
      category: CAT_ENG,
      gender: GENDER.MALE,
      component: COMPONENT.VARIABLE,
      bucket: 8,
    });

    const { rows } = shapeChainRows(c.ledger(), { categories: ["engineering"], ...readOpts });
    const variable = rows.find((r) => r.category.includes("Variable"))!;
    const engine = toEngineInput(variable, variable.component, DEFAULT_K);

    // The population the engine will read from .total.
    const refTotal = engine.reference.total.reduce((a, b) => a + b, 0);
    const cmpTotal = engine.comparison.total.reduce((a, b) => a + b, 0);
    expect(refTotal).toBe(6);
    expect(cmpTotal).toBe(7);

    const report = buildReport([engine], {
      period: "FY2026",
      generatedAt: "2026-10-08",
      k: DEFAULT_K,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].category).toContain("engineering");
    expect(report.suppressed).toHaveLength(0);
    // Art. 9(1)(b): the gap in variable pay is now computable at all.
    expect(report.rows[0].gap).not.toBeNull();
  });

  it("withholds a variable group that is below the threshold, with its real size", () => {
    const c = deploy(5);
    seedGroup(c, 2, {
      category: CAT_ENG,
      gender: GENDER.FEMALE,
      component: COMPONENT.VARIABLE,
      bucket: 2,
    });
    seedGroup(c, 2, {
      category: CAT_ENG,
      gender: GENDER.MALE,
      component: COMPONENT.VARIABLE,
      bucket: 3,
    });

    const { rows } = shapeChainRows(c.ledger(), { categories: ["engineering"], ...readOpts });
    const variableRow = rows.find((r) => r.component === COMPONENT.VARIABLE)!;
    const engine = toEngineInput(variableRow, variableRow.component, 5);
    const report = buildReport([engine], { period: "p", generatedAt: "g", k: 5 });

    expect(report.rows).toHaveLength(0);
    expect(report.suppressed[0].reason).toBe("below-k-anonymity-threshold");
    expect(report.suppressed[0].size).toBe(4);
  });

  it("keeps every Art. 9 dimension in a separate cell", () => {
    const c = deploy();
    seedGroup(c, 6, { category: CAT_ENG, gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3 });
    seedGroup(c, 6, { category: CAT_ENG, gender: GENDER.MALE, component: COMPONENT.BASE, bucket: 3 });
    seedGroup(c, 6, { category: CAT_ENG, gender: GENDER.FEMALE, component: COMPONENT.VARIABLE, bucket: 7 });

    const { rows } = shapeChainRows(c.ledger(), { categories: ["engineering"], ...readOpts });

    // The base row sees only base submissions; the variable row sees only its own.
    const baseRow = rows.find((r) => r.component === COMPONENT.BASE)!;
    const baseEngine = toEngineInput(baseRow, baseRow.component, DEFAULT_K);
    expect(baseEngine.reference.total.reduce((a, b) => a + b, 0)).toBe(6);
    expect(baseEngine.comparison.total.reduce((a, b) => a + b, 0)).toBe(6);
    const varRow = rows.find((r) => r.component === COMPONENT.VARIABLE)!;
    const varEngine = toEngineInput(varRow, varRow.component, DEFAULT_K);
    expect(varEngine.reference.total.reduce((a, b) => a + b, 0)).toBe(6);
    // Men submitted no variable pay, so their variable population is empty.
    expect(varEngine.comparison.total.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("reports which categories the operator asked about but that hold nothing", () => {
    // A configured-but-empty category is a different fact from one never
    // configured, and the report has to be able to say which it saw.
    const c = deploy();
    seedGroup(c, 6, { category: CAT_ENG, gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3 });

    const { rows, empty } = shapeChainRows(c.ledger(), {
      categories: ["engineering", "sales"],
      ...readOpts,
    });
    // Engineering has base data, so its base row is not empty; everything else is.
    expect(empty.some((e) => e.startsWith("sales"))).toBe(true);
    expect(empty.some((e) => e.startsWith("engineering ·") && e.includes("Variable"))).toBe(true);
    // Two categories x two components = four rows, all accounted for.
    expect(rows).toHaveLength(4);
  });

  it("reads k straight off the contract, so the report states the threshold in force", () => {
    const c = deploy(8);
    seedGroup(c, 6, { category: CAT_ENG, gender: GENDER.FEMALE, component: COMPONENT.BASE, bucket: 3 });
    seedGroup(c, 6, { category: CAT_ENG, gender: GENDER.MALE, component: COMPONENT.BASE, bucket: 3 });

    const led = c.ledger();
    expect(Number(led.kThreshold)).toBe(8);

    const { rows } = shapeChainRows(led, { categories: ["engineering"], ...readOpts });
    const baseRow = rows.find((r) => r.component === COMPONENT.BASE)!;
    const engine = toEngineInput(baseRow, baseRow.component, Number(led.kThreshold));
    const report = buildReport([engine], { period: "p", generatedAt: "g", k: 8 });
    // 6 < 8, so this contract's own threshold withholds it.
    expect(report.rows).toHaveLength(0);
    expect(report.k).toBe(8);
  });
});
