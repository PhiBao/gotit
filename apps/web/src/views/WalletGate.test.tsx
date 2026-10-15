/**
 * Render tests for the wallet gate.
 *
 * The gate is the first thing a new visitor with no wallet meets, so what it says
 * matters more than most copy: it has to explain that reading is free, name the
 * step that is blocking, and not look broken while a wallet is slow to answer.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletGate, walletHint } from "./WalletGate";
import type { ConnectionPhase } from "../lib/walletConnect";

const base = {
  open: true,
  phase: null as ConnectionPhase | null,
  installed: true,
  busy: false,
  onConnect: () => {},
  onBrowse: () => {},
};

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("the gate says reading needs no wallet", () => {
  it("offers reading before asking for any setup", () => {
    const t = text(<WalletGate {...base} installed={false} />);
    expect(t).toMatch(/do not need a wallet to read/i);
    expect(t).toMatch(/Report and the verification page are open to anyone/i);
    expect(t).toMatch(/Read without a wallet/);
  });

  it("does not render at all when closed", () => {
    expect(renderToStaticMarkup(<WalletGate {...base} open={false} />)).toBe("");
  });
});

describe("the gate names the blocking step", () => {
  it("points at installation when no extension exists", () => {
    const t = text(<WalletGate {...base} installed={false} />);
    expect(t).toMatch(/Install the Lace extension/);
    expect(t).toMatch(/lace\.io/);
    expect(t).toMatch(/reload this page/);
  });

  it("tells the user to unlock when the wallet is not answering", () => {
    // The locked-extension case: connect() never settles, so the gate has to say
    // what to do rather than spin.
    const t = text(
      <WalletGate
        {...base}
        busy
        phase={{
          kind: "needs-attention",
          waitedMs: 9000,
          detail: "The wallet has not answered. If it is locked, open the extension, unlock it, and approve the connection — the request is waiting for you there.",
        }}
      />,
    );
    expect(t).toMatch(/Unlock Lace/);
    expect(t).toMatch(/locked wallet cannot show its approval prompt/i);
    expect(t).toMatch(/request is waiting for you there/i);
  });

  it("says a declined connection was declined, and that retrying is safe", () => {
    const t = text(
      <WalletGate
        {...base}
        phase={{ kind: "rejected", detail: "The connection request was declined in the wallet." }}
      />,
    );
    expect(t).toMatch(/declined/i);
    expect(t).toMatch(/Nothing was sent to the network/);
    expect(t).toMatch(/try again safely/i);
  });

  it("offers the faucet, which is what people actually get stuck on", () => {
    const t = text(<WalletGate {...base} />);
    expect(t).toMatch(/tDUST/);
    expect(t).toMatch(/Preprod faucet/);
    expect(t).toMatch(/Generate tDUST/);
  });

  it("warns not to combine the network and the wallet wrongly", () => {
    const t = text(<WalletGate {...base} />);
    expect(t).toMatch(/Preprod network/);
  });
});

describe("the always-visible hint", () => {
  it("nudges installation before anything else", () => {
    expect(walletHint(null, false)).toMatch(/Install Lace/);
    expect(walletHint(null, false)).toMatch(/reading needs no wallet/i);
  });

  it("says nothing when there is nothing to do", () => {
    expect(walletHint(null, true)).toBeNull();
  });

  it("surfaces the two states that need the user", () => {
    expect(walletHint({ kind: "needs-attention", detail: "", waitedMs: 9000 }, true)).toMatch(/Unlock Lace/);
    expect(walletHint({ kind: "rejected", detail: "" }, true)).toMatch(/declined/i);
  });
});
