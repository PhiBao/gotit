/**
 * The setup guide, as a page rather than a modal.
 *
 * A modal is the wrong container for six sequential steps: it cannot be
 * bookmarked, cannot be read before you are ready to act, and becomes a wall of
 * text people scroll past to reach the button. The modal says only what it must —
 * reading needs no wallet, here is the state of your connection — and links here.
 *
 * Everything below follows Midnight's own guide,
 * https://docs.midnight.network/guides/acquire-tokens, and where a step looks
 * pedantic it is because the official procedure says the same thing. The two worth
 * knowing:
 *
 *   "Registration needs a fully synced wallet ... Without the wait, a registration
 *    built too soon after the funds arrive throws before the wallet signs anything."
 *
 *   "The faucet rejects shielded and DUST addresses."
 *
 * Neither is a quirk of this app. Both are the protocol's, and both produce errors
 * that look like app bugs.
 */

const LACE_URL = "https://www.lace.io/";
const FAUCET_URL = "https://midnight-tmnight-preprod.nethermind.dev/";
const OFFICIAL_GUIDE = "https://docs.midnight.network/guides/acquire-tokens";
const DISCORD = "https://discord.gg/midnightnetwork";

type Step = {
  n: number;
  title: string;
  body: React.ReactNode;
  warn?: React.ReactNode;
};

const STEPS: Step[] = [
  {
    n: 1,
    title: "Install Lace, or update it",
    body: (
      <>
        Get the extension from{" "}
        <a href={LACE_URL} target="_blank" rel="noreferrer" className="link">
          lace.io
        </a>
        , then reload this page. If it is already installed,{" "}
        <b>update it to the newest version</b>.
      </>
    ),
    warn: (
      <>
        An out-of-date Lace accepts a connection request and never answers it, which looks exactly
        like this app being broken. Updating it fixed precisely that, for us.
      </>
    ),
  },
  {
    n: 2,
    title: "Switch Lace to Preprod and unlock it",
    body: (
      <>
        This app reads <b>Preprod</b>, a test network. In Lace, open the network selector and choose
        Preprod. Unlock the wallet if it asks — a locked wallet cannot show an approval prompt, so
        the button appears to do nothing.
      </>
    ),
  },
  {
    n: 3,
    title: "Wait until Lace says Synced",
    body: (
      <>
        Lace shows a network pill and a status badge at the top. The status must read <b>Synced</b>.
        Until then the wallet is still reading the chain.
      </>
    ),
    warn: (
      <>
        <b>Do not connect, contribute, or press Generate tDUST before it says Synced.</b> This is not
        our advice — Midnight&apos;s own guide says registration requires a fully synced wallet and
        that a registration built too soon &ldquo;throws before the wallet signs anything&rdquo;.
        Acting early produces failures that look like app bugs: a blank balance, a faucet transfer
        that seems lost, a connection that hangs. The first Preprod sync can take several minutes;
        leave the extension open until it finishes.
      </>
    ),
  },
  {
    n: 4,
    title: "Get free test funds",
    body: (
      <>
        Contributing is a transaction, and transactions cost a little tDUST. It is free. Open the{" "}
        <a href={FAUCET_URL} target="_blank" rel="noreferrer" className="link">
          Preprod faucet
        </a>
        , paste your address, solve the captcha, and request. Each request sends{" "}
        <b>1,000 tNIGHT</b>, and the balance appears within a couple of minutes.
      </>
    ),
    warn: (
      <>
        Paste the <b>unshielded</b> address — it starts <code>mn_addr_preprod1…</code>. The faucet
        rejects shielded (<code>mn_shield-addr_…</code>) and DUST (<code>mn_dust_…</code>)
        addresses, and it rejects an address with whitespace around it. Check the prefix before you
        paste.
      </>
    ),
  },
  {
    n: 5,
    title: "Wait for the funds, then generate tDUST",
    body: (
      <>
        The balance appears within a couple of minutes, and a positive balance means the tokens have
        arrived — it counts only confirmed transactions, so it can show up while sync is still
        running. Then open the Midnight wallet, press <b>Generate tDUST</b> → Review transaction →
        Confirm. The tank starts filling and keeps accruing up to a cap set by how much NIGHT you
        registered.
      </>
    ),
    warn: (
      <>
        If Lace says <i>&ldquo;At least one Night UTXO is required&rdquo;</i>, it has no confirmed
        unshielded NIGHT to register yet. Two causes: the transfer is still pending, or it went to
        the shielded address. Also note the first registration pays its own fee from the tDUST your
        NIGHT has generated since arriving — so if it just landed, give it a moment.
      </>
    ),
  },
  {
    n: 6,
    title: "Connect and contribute",
    body: (
      <>
        Press <b>Connect wallet</b> and approve the request. The approval appears under the{" "}
        <b>Lace icon in your toolbar</b>.
      </>
    ),
    warn: (
      <>
        The side panel shows balances and does not reliably show connection requests — that is why
        the button can seem to do nothing. If Connect still hangs with Lace open and unlocked,
        remove this site under Lace&apos;s connected apps and try again: repeated attempts stack
        requests inside the wallet, and a wallet holding several outstanding requests can stop
        answering any of them.
      </>
    ),
  },
];

/** Official troubleshooting symptoms, plus the ones we hit ourselves. */
const TROUBLESHOOTING: Array<[string, React.ReactNode]> = [
  [
    "Faucet: “Provided address is invalid”",
    <>
      Use the unshielded <code>mn_addr_…</code> address, with no surrounding whitespace. Shielded
      and DUST addresses are rejected by design.
    </>,
  ],
  [
    "Faucet: rate limit reached",
    <>
      The faucets are rate limited. Wait a few hours and retry; if it persists, ask in the{" "}
      <a href={DISCORD} target="_blank" rel="noreferrer" className="link">
        Midnight Discord
      </a>
      .
    </>,
  ],
  [
    "Balance stays zero after the faucet confirmed",
    <>Give it a couple of minutes. Confirm the address you pasted matches the one Lace shows.</>,
  ],
  [
    "“At least one Night UTXO is required”",
    <>The transfer is still pending, or it was sent to the shielded address rather than the unshielded one.</>,
  ],
  [
    "tDUST stays zero after generating",
    <>Give the registration time to land on-chain. It pays its own fee from tDUST the NIGHT has generated, so a fresh transfer needs a moment.</>,
  ],
  [
    "Connect does nothing, wallet open and unlocked",
    <>Update Lace, then remove this site in its connected apps and retry.</>,
  ],
  [
    "Approval prompt never appears",
    <>Look under the Lace icon in your toolbar, not the side panel.</>,
  ],
  [
    "Report says nothing is publishable",
    <>Correct behaviour, not a fault: no category has both genders at or above k=5 yet.</>,
  ],
];

export default function GuidePage({ onBack }: { onBack?: () => void }) {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "24px 20px 80px" }}>
      <div className="kicker">SETUP GUIDE</div>
      <h1 style={{ fontSize: 30, margin: "4px 0 8px", letterSpacing: "-0.02em" }}>
        Contributing, from nothing
      </h1>

      <div
        className="notice"
        style={{ borderColor: "#14301e", background: "var(--green-bg)", lineHeight: 1.6 }}
      >
        <b style={{ color: "var(--green)" }}>You do not need any of this to read.</b> The report and
        the verification page are open to anyone — no wallet, no account, no permission. This is only
        for contributing a figure, because that is a transaction and transactions need a wallet.
      </div>

      {/* The instruction most likely to be skipped, so it is not inside a step. */}
      <div
        className="notice"
        style={{ marginTop: 14, borderColor: "#713f12", background: "#1a1500", lineHeight: 1.6 }}
      >
        <b style={{ color: "#fcd34d" }}>If you are new to this: wait for the sync.</b> Lace shows a
        status badge beside its network pill, and until it reads <b>Synced</b> the wallet has not
        finished reading the chain. Midnight&apos;s own guide says registration requires a fully
        synced wallet — do not contribute or generate tDUST before then. The first sync can take
        several minutes.
      </div>

      <div style={{ marginTop: 20 }}>
        {STEPS.map((s) => (
          <div key={s.n} className="card card-pad" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div
                className="mono"
                style={{
                  flex: "0 0 26px",
                  height: 26,
                  borderRadius: 999,
                  display: "grid",
                  placeItems: "center",
                  background: "var(--panel2)",
                  border: "1px solid var(--line)",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {s.n}
              </div>
              <div style={{ flex: 1 }}>
                <h2 style={{ margin: "2px 0 8px", fontSize: 17 }}>{s.title}</h2>
                <div className="muted" style={{ fontSize: 14, lineHeight: 1.7 }}>
                  {s.body}
                </div>
                {s.warn && (
                  <div
                    className="notice"
                    style={{
                      marginTop: 12,
                      borderColor: "#713f12",
                      background: "#1a1500",
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    <span style={{ color: "#fcd34d" }}>Heads up — </span>
                    {s.warn}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="card card-pad" style={{ marginTop: 20 }}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>When something goes wrong</h2>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <tbody className="muted">
            {TROUBLESHOOTING.map(([symptom, fix]) => (
              <tr key={symptom}>
                <td style={{ padding: "6px 12px 6px 0", verticalAlign: "top", width: "44%" }}>
                  {symptom}
                </td>
                <td style={{ padding: "6px 0", verticalAlign: "top" }}>{fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="small muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Any other failure: open the browser console and look for lines beginning{" "}
          <code>[gotit]</code>. They name the wallet&apos;s own report, which stage it reached, and
          which service answered — enough to tell a locked wallet from a stopped prover from an
          indexer problem, and that text is the useful part of a bug report.
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 20, flexWrap: "wrap" }}>
        <button className="btn btn-primary" onClick={onBack}>
          Back to the app
        </button>
        <a className="btn" href={FAUCET_URL} target="_blank" rel="noreferrer">
          Preprod faucet
        </a>
        <a className="btn btn-ghost" href={OFFICIAL_GUIDE} target="_blank" rel="noreferrer">
          Midnight&apos;s funding guide
        </a>
      </div>

      <div className="small muted" style={{ marginTop: 14, lineHeight: 1.6 }}>
        Steps 4 and 5 follow Midnight&apos;s official{" "}
        <a href={OFFICIAL_GUIDE} target="_blank" rel="noreferrer" className="link">
          Fund a wallet
        </a>{" "}
        guide. If this page and that one disagree, that one is right.
      </div>
    </div>
  );
}
