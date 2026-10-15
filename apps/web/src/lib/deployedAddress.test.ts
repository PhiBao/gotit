import { describe, it, expect } from "vitest";
import { extractContractAddress, isPlausibleAddress, deployedAddress } from "./deployResult";

/**
 * Tests for the "deployed at undefined" bug.
 *
 * The deploy transaction succeeded and the address was lost on the way back, so
 * the app stored the string "undefined" and would have read it back later as a
 * contract that does not exist. These pin the extraction against every shape the
 * result plausibly takes, and pin that a miss THROWS rather than returning
 * something empty.
 */

const ADDR = "a".repeat(64);

describe("isPlausibleAddress", () => {
  it("accepts 64 hex with or without 0x", () => {
    expect(isPlausibleAddress(ADDR)).toBe(true);
    expect(isPlausibleAddress(`0x${ADDR}`)).toBe(true);
    expect(isPlausibleAddress(ADDR.toUpperCase())).toBe(true);
  });

  it("rejects the values that actually appeared in the bug", () => {
    // `undefined` was stringified into localStorage. It must never pass again.
    expect(isPlausibleAddress(undefined)).toBe(false);
    expect(isPlausibleAddress(null)).toBe(false);
    expect(isPlausibleAddress("undefined")).toBe(false);
    expect(isPlausibleAddress("")).toBe(false);
    expect(isPlausibleAddress(0)).toBe(false);
    expect(isPlausibleAddress({})).toBe(false);
  });

  it("rejects a wrong-length string", () => {
    expect(isPlausibleAddress("abc123")).toBe(false);
    expect(isPlausibleAddress("a".repeat(63))).toBe(false);
    expect(isPlausibleAddress("a".repeat(65))).toBe(false);
  });
});

describe("extractContractAddress", () => {
  it("reads it from the top level when present", () => {
    const r = extractContractAddress({ contractAddress: ADDR });
    expect(r.address).toBe(ADDR);
    expect(r.source).toBe("contractAddress");
  });

  it("reads it from deployTxData.public, which is where v1 found it", () => {
    const r = extractContractAddress({ deployTxData: { public: { contractAddress: ADDR } } });
    expect(r.address).toBe(ADDR);
    expect(r.source).toBe("deployTxData.public.contractAddress");
  });

  it("reads it from callTx", () => {
    const r = extractContractAddress({ callTx: { contractAddress: ADDR } });
    expect(r.address).toBe(ADDR);
    expect(r.source).toBe("callTx.contractAddress");
  });

  it("normalises a 0x prefix away", () => {
    expect(extractContractAddress({ contractAddress: `0x${ADDR}` }).address).toBe(ADDR);
  });

  it("prefers the top level when several are present", () => {
    const r = extractContractAddress({
      contractAddress: ADDR,
      deployTxData: { public: { contractAddress: "b".repeat(64) } },
    });
    expect(r.address).toBe(ADDR);
  });

  it("THROWS rather than returning empty when the address is missing", () => {
    // The whole point. The old code returned undefined, which stringified into
    // localStorage and produced a report that blamed the ledger for a missing
    // contract.
    expect(() => extractContractAddress({})).toThrow(/could not be read/);
    expect(() => extractContractAddress(undefined)).toThrow(/could not be read/);
    expect(() => extractContractAddress({ contractAddress: undefined })).toThrow();
  });

  it("says the transaction may have gone through, so nobody retries blind", () => {
    try {
      extractContractAddress({});
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/may still have gone through/);
      expect(msg).toMatch(/check the wallet/);
    }
  });

  it("includes the result's own keys, so the shape is diagnosable", () => {
    try {
      extractContractAddress({ deployTxData: { public: { somethingElse: 1 } }, callTx: { a: 2 } });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("deployTxData");
      expect(msg).toContain("callTx");
      expect(msg).toContain("somethingElse");
    }
  });

  it("survives a circular object when building the diagnostic", () => {
    const circ: any = { deployTxData: {} };
    circ.self = circ;
    // JSON.stringify of the whole object would throw; we only stringify keys.
    expect(() => extractContractAddress(circ)).toThrow(/could not be read/);
  });
});

describe("v1 uses the same rule", () => {
  it("reads the same shapes", () => {
    expect(deployedAddress({ deployTxData: { public: { contractAddress: ADDR } } })).toBe(ADDR);
    expect(deployedAddress({ contractAddress: ADDR })).toBe(ADDR);
  });

  it("throws instead of the old silent fallback", () => {
    // v1 used to say "Deployed - check Lace for the address" and record nothing,
    // which hid the miss. It now fails loudly.
    expect(() => deployedAddress({ deployTxData: { public: {} } })).toThrow(/could not be read/);
  });
});

describe("a malformed stored address is not a contract", () => {
  // The exact value that got written: deployV2 returned undefined, the UI did
  // setStoredV2ContractAddress(undefined), and the report page then tried to
  // decode the V1 contract as a V2 ledger. The stored junk has to be ignored on
  // read as well as refused on write, because it is already in people's browsers.
  it("rejects every value that is not 64 hex", () => {
    for (const bad of ["undefined", "null", "", "0x", "abc", "a".repeat(63), "a".repeat(65), "zz".repeat(32)]) {
      expect(isPlausibleAddress(bad)).toBe(false);
    }
  });

  it("accepts a real address so the guard is not vacuous", () => {
    expect(isPlausibleAddress("a".repeat(64))).toBe(true);
    expect(isPlausibleAddress(`0x${"b".repeat(64)}`)).toBe(true);
  });
});
