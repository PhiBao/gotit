import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  issuerKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  submit(context: __compactRuntime.CircuitContext<PS>,
         categoryKey_0: Uint8Array,
         gender_0: bigint,
         component_0: bigint,
         bucket_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  enroll(context: __compactRuntime.CircuitContext<PS>, memberLeaf_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  nextEpoch(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  getHistogram(context: __compactRuntime.CircuitContext<PS>,
               categoryKey_0: Uint8Array,
               gender_0: bigint,
               component_0: bigint,
               bucket_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  isPublishable(context: __compactRuntime.CircuitContext<PS>,
                categoryKey_0: Uint8Array,
                gender_0: bigint,
                component_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  readEpoch(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  readK(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getGroupHistogram(context: __compactRuntime.CircuitContext<PS>,
                    categoryKey_0: Uint8Array,
                    gender_0: bigint,
                    component_0: bigint): __compactRuntime.CircuitResults<PS, bigint[]>;
}

export type ProvableCircuits<PS> = {
  submit(context: __compactRuntime.CircuitContext<PS>,
         categoryKey_0: Uint8Array,
         gender_0: bigint,
         component_0: bigint,
         bucket_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  enroll(context: __compactRuntime.CircuitContext<PS>, memberLeaf_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  nextEpoch(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  getHistogram(context: __compactRuntime.CircuitContext<PS>,
               categoryKey_0: Uint8Array,
               gender_0: bigint,
               component_0: bigint,
               bucket_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  isPublishable(context: __compactRuntime.CircuitContext<PS>,
                categoryKey_0: Uint8Array,
                gender_0: bigint,
                component_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  readEpoch(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  readK(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getGroupHistogram(context: __compactRuntime.CircuitContext<PS>,
                    categoryKey_0: Uint8Array,
                    gender_0: bigint,
                    component_0: bigint): __compactRuntime.CircuitResults<PS, bigint[]>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  submit(context: __compactRuntime.CircuitContext<PS>,
         categoryKey_0: Uint8Array,
         gender_0: bigint,
         component_0: bigint,
         bucket_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  enroll(context: __compactRuntime.CircuitContext<PS>, memberLeaf_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  nextEpoch(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  getHistogram(context: __compactRuntime.CircuitContext<PS>,
               categoryKey_0: Uint8Array,
               gender_0: bigint,
               component_0: bigint,
               bucket_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  isPublishable(context: __compactRuntime.CircuitContext<PS>,
                categoryKey_0: Uint8Array,
                gender_0: bigint,
                component_0: bigint): __compactRuntime.CircuitResults<PS, bigint>;
  readEpoch(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  readK(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  getGroupHistogram(context: __compactRuntime.CircuitContext<PS>,
                    categoryKey_0: Uint8Array,
                    gender_0: bigint,
                    component_0: bigint): __compactRuntime.CircuitResults<PS, bigint[]>;
}

export type Ledger = {
  members: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  nullifiers: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
  histogram: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  groupCount: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  epochCount: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  readonly kThreshold: bigint;
  readonly issuer: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               issuerCommit_0: Uint8Array,
               anonymityThreshold_0: bigint): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
