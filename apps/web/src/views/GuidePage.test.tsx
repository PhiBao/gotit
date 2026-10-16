/**
 * Render tests for the setup guide.
 *
 * This page carries the content that used to be crammed into the wallet modal, so
 * the assertions moved here with it. The instructions follow Midnight's own
 * funding guide (https://docs.midnight.network/guides/acquire-tokens) — including
 * the sync requirement, which is not our advice:
 *
 *   "Registration needs a fully synced wallet ... Without the wait, a registration
 *    built too soon after the funds arrive throws before the wallet signs anything."
 *
 *   "The faucet rejects shielded and DUST addresses."
 *
 * Both produce errors that look like app bugs, so the page states them plainly.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GuidePage from "./GuidePage";

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&apos;/g, "'");

describe("reading is separated from contributing", () => {
  it("says up front that none of this is needed to read", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/do not need any of this to read/i);
    expect(t).toMatch(/only for contributing a figure/i);
  });
});

describe("the sync warning, which is the step people skip", () => {
  it("appears before the numbered steps, not buried in one", () => {
    const t = text(<GuidePage />);
    const syncAt = t.search(/wait for the sync/i);
    const stepOneAt = t.search(/Install Lace, or update it/);
    expect(syncAt).toBeGreaterThan(-1);
    expect(stepOneAt).toBeGreaterThan(-1);
    // Before the steps, because it is the one instruction that invalidates all of
    // them if ignored.
    expect(syncAt).toBeLessThan(stepOneAt);
  });

  it("states what to wait for and why, rather than just 'wait'", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/status badge/i);
    expect(t).toMatch(/Synced/);
    expect(t).toMatch(/fully synced wallet/i);
  });

  it("names the failures that waiting prevents", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/before it says Synced/i);
    expect(t).toMatch(/look like app bugs/i);
  });

  it("cites the official requirement, so it does not read as our superstition", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/Midnight's own guide/i);
    expect(t).toMatch(/throws before the wallet signs anything/);
  });
});

describe("the funding steps match the official procedure", () => {
  it("requires the unshielded address and says which prefixes are rejected", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/unshielded/i);
    expect(t).toMatch(/mn_addr_preprod1/);
    // The two the faucet refuses, named so people can check their own address.
    expect(t).toMatch(/mn_shield-addr_/);
    expect(t).toMatch(/mn_dust_/);
    expect(t).toMatch(/rejects shielded/i);
  });

  it("gives the amount and the wait, so nobody thinks it failed", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/1,000 tNIGHT/);
    expect(t).toMatch(/couple of minutes/);
  });

  it("describes the Generate tDUST flow as Lace labels it", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/Generate tDUST/);
    expect(t).toMatch(/Review transaction/);
    expect(t).toMatch(/tank/i);
    expect(t).toMatch(/cap/i);
  });

  it("explains the tDUST error with both its causes", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/At least one Night UTXO is required/);
    expect(t).toMatch(/still pending/i);
    expect(t).toMatch(/shielded address/i);
    // And the subtle one: the registration pays its own fee from generated DUST.
    expect(t).toMatch(/pays its own fee/i);
  });

  it("credits the source, so a reader can check it", () => {
    const html = renderToStaticMarkup(<GuidePage />);
    // The URL is in an href, so assert on the markup — a reader being able to
    // check the instruction is the whole point.
    expect(html).toContain("docs.midnight.network/guides/acquire-tokens");
    expect(text(<GuidePage />)).toMatch(/that one is right/i);
  });
});

describe("troubleshooting covers what people actually hit", () => {
  it("includes the official symptoms", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/Provided address is invalid/);
    expect(t).toMatch(/rate limit/i);
    expect(t).toMatch(/Balance stays zero/i);
    expect(t).toMatch(/tDUST stays zero/i);
  });

  it("includes the ones we hit ourselves", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/Connect does nothing/i);
    expect(t).toMatch(/Approval prompt never appears/i);
    expect(t).toMatch(/Look under the Lace icon in your toolbar/i);
  });

  it("says a withheld report is correct behaviour, not a fault", () => {
    // Otherwise the first thing a user sees after all this setup reads as a bug.
    const t = text(<GuidePage />);
    expect(t).toMatch(/Correct behaviour, not a fault/i);
    expect(t).toMatch(/both genders at or above k=5/i);
  });

  it("points at the console for anything not listed", () => {
    const t = text(<GuidePage />);
    expect(t).toMatch(/\[gotit\]/);
  });
});
