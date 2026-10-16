/**
 * Render tests for the wallet gate.
 *
 * The gate is the first thing a visitor with no wallet meets, so what it says
 * matters. It used to carry the whole setup procedure; that lives on `#guide` now,
 * because a modal cannot be bookmarked and six steps in front of a button is a wall
 * people scroll past. So these tests assert the two things the moment requires —
 * reading is free, and here is where the connection is — plus that the guide is one
 * press away.
 *
 * The setup instructions themselves are tested in GuidePage.test.tsx.
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
  onOpenGuide: () => {},
};

const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("reading is offered before any setup", () => {
  it("leads with not needing a wallet", () => {
    const t = text(<WalletGate {...base} installed={false} />);
    expect(t).toMatch(/do not need a wallet to read/i);
    expect(t).toMatch(/report and the verification page are open to anyone/i);
    expect(t).toMatch(/Read without a wallet/);
  });

  it("does not render at all when closed", () => {
    expect(renderToStaticMarkup(<WalletGate {...base} open={false} />)).toBe("");
  });
});

describe("the gate names where the connection is", () => {
  it("points at installation when no extension exists", () => {
    const t = text(<WalletGate {...base} installed={false} />);
    expect(t).toMatch(/No wallet extension found/i);
    expect(t).toMatch(/Get Lace/);
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
          detail:
            "The wallet has not answered. Click the Lace icon in your browser toolbar — not the side panel — and approve the connection there.",
        }}
      />,
    );
    expect(t).toMatch(/needs attention/i);
    expect(t).toMatch(/Lace icon in your browser toolbar/);
  });

  it("says a declined connection was declined, and that retrying is safe", () => {
    const t = text(
      <WalletGate
        {...base}
        phase={{ kind: "rejected", detail: "The connection request was declined in the wallet." }}
      />,
    );
    expect(t).toMatch(/did not complete/i);
    expect(t).toMatch(/declined/i);
    expect(t).toMatch(/Trying again is safe/);
  });

  it("shows a seconds counter while waiting", () => {
    const t = text(
      <WalletGate {...base} busy phase={{ kind: "requesting", detail: "Waiting…", waitedMs: 0 }} />,
    );
    expect(t).toMatch(/Wait/);
  });
});

describe("the guide is one press away", () => {
  it("links to it, and says why it exists", () => {
    const t = text(<WalletGate {...base} />);
    expect(t).toMatch(/Open the setup guide/);
    // The sync step is the one people skip, so the pointer says so.
    expect(t).toMatch(/including the one everyone skips/i);
  });

  it("does NOT carry the setup steps itself", () => {
    // This is the regression worth pinning: the modal grew to six steps of
    // install/unlock/update/faucet instructions. If they come back, this fails.
    const t = text(<WalletGate {...base} />);
    expect(t).not.toMatch(/Preprod faucet/);
    expect(t).not.toMatch(/Generate tDUST/);
    expect(t).not.toMatch(/Update Lace to the newest/);
    expect(t).not.toMatch(/mn_addr_preprod1/);
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
    expect(walletHint({ kind: "needs-attention", detail: "", waitedMs: 9000 }, true)).toMatch(
      /Unlock Lace/,
    );
    expect(walletHint({ kind: "rejected", detail: "" }, true)).toMatch(/declined/i);
  });
});
