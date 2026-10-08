# Demo Guide

> **Naming:** the product is GotIt. The v1 contract file is still `candor.compact` because its
> `candor:*` hash domains are frozen against the deployed contract `e7cf6ffc…dd53d` — changing
> them would reject every existing member. The v2 ledger is `gotit.compact` with `gotit:*`
> domains. The Fly apps are `candor-*` because renaming an app destroys its URL history.

## What a judge can click right now, with no wallet and no install

| URL | What it shows |
|---|---|
| `https://candor-midnight-web.fly.dev/` | The pitch, live network state, and the v1 contribution tool |
| `https://candor-midnight-web.fly.dev/#report` | The Art. 9 report, reading the v2 ledger |
| `https://candor-midnight-web.fly.dev/#report&sample` | The same page with **clearly-labelled illustrative data** |
| `https://candor-midnight-web.fly.dev/#verify` | Public verification — paste a fingerprint, get match/mismatch |

`#report` will say there is nothing publishable, because v2 is not deployed yet. That is the
correct behaviour and worth saying out loud in the video: **the page does not fall back to
v1's numbers to look complete.** Use `#report&sample` to show the report format, and the amber
banner makes the distinction unmissable.

## Reproduce a report from public chain state (no wallet, no account, no key)

```bash
# v2 ledger, when one is deployed
pnpm --filter @gotit/contract verify:chain -- \
  --address <v2Address> --categories engineering,sales,operations,management
```

Prints the Art. 9 report the live app produces, read straight from the Preprod indexer. This
is the thing a third party does to check a filing, and it needs nothing but the contract
address: no wallet, no issuer key, no proof server. The report engine is pure, so re-running
it on public state reproduces the published numbers exactly.

Point it at the Wave 1 contract and it says so plainly — that ledger predates the Art. 9
dimensions and cannot produce this report.

45 tests in `packages/contract/src/chainRead.test.ts` run this chain-to-report path against the
**generated contract**: submit through the circuits, decode the state, shape it, build the
report. That is the coverage that was missing — every other report test fed the engine
hand-built histograms, so a mismatch between how the ledger stores counts and how the report
reads them was invisible.

## The report engine with no chain at all

```bash
pnpm --filter @gotit/shared exec tsx src/paygap.cli.ts --demo
```

Prints a full Art. 9 report from sample data, labelled as not a filing. Useful if the network is
down during a live demo.

---

# Video shot list

Target **3 minutes**. The order matters: lead with the artifact a judge cares about, then prove
it is real, then prove the privacy property. Do not spend time on setup.

## Act 1 — the deliverable (0:00–1:00)

**Shot 1 — `#report&sample`.** Open the URL directly.

- The **interval** means: `$128,000–$156,000`, not a single number. Say why in one sentence:
  *the figures are bucketed, so the true value is only bounded — publishing a point estimate
  would be a rounding error dressed as a statistic.*
- **Headcount** for each side. Art. 9 compares women and men inside one category, so both
  columns have to be there.
- The **amber ILLUSTRATIVE banner**. Point at it. *This is labelled because a plausible-looking
  table in a compliance filing is the worst failure this product could have.*
- The **coverage note** at the bottom: participation is voluntary, and an empty category is not
  evidence that pay is equal.

**Shot 2 — scroll to Withheld.** Two groups listed with different reasons:

- `no-comparison-group` — data on one side only. *Reporting it would reveal the other side by
  subtraction.*
- `below-k-anonymity-threshold` — both sides present, one under k. *This one is fixable by
  recruiting more people, which is why the two are labelled differently.*

Then, pointing at the copy above the table: **the gate is in the contract's read circuit, not in
this page.** An employer cannot override it, publish a small cell, or write a reader that gets
around it.

**Shot 3 — the 5% call-out.** The engineering row. *Art. 9(4): a gap of 5% or more that cannot
be objectively justified can trigger a joint pay assessment with worker representatives. We
flag against the bound nearest zero, not the midpoint — otherwise we cry wolf on a compliant
category.* If the interval straddles zero, say that it is **not** flagged, and that this is
deliberate.

## Act 2 — it is provable (1:00–2:00)

**Shot 4 — `#verify`.** Paste the fingerprint.

- *No wallet. No account. No permission.* This is what a works council member or a journalist
  does.
- Show the **match** result. Then edit one character of the fingerprint and show the
  **mismatch**. A check that can fail is what makes a pass mean something.
- Read out the "what this does and does not prove" text. Do not skip it: *it proves the figures
  came from the counts on chain. It does not prove anyone was paid what they said, or that
  everyone participated.* Naming the limit is what earns trust in the rest.

**Shot 5 — the contract, briefly.** `packages/contract/src/gotit.compact` in the editor, one
circuit:

```compact
export circuit getHistogram(
  categoryKey: Bytes<32>, gender: Uint<8>, component: Uint<8>, bucket: Uint<8>
): Uint<64> {
  const gKey = disclose(persistentHash<[Bytes<32>, Uint<8>, Uint<8>]>([categoryKey, gender, component]));
  if (!groupCount.member(gKey)) { return 0 as Uint<64>; }
  if (groupCount.lookup(gKey) < kThreshold) { return 0 as Uint<64>; }
  // ...
}
```

Highlight the `kThreshold` early return. Below it, this cell reads as `0` for **everyone** —
including the employer, who pays for the deployment. It is not a UI toggle and not a policy.

Then `packages/contract/src/gotit.v2.test.ts` scrolling past. *34 tests run the generated
contract off-chain, so if the browser's hashing ever drifts from the circuits' the build fails
rather than silently filing a salary in the wrong cell.* Six of those tests exist only to hold
this gate down.

## Act 3 — the privacy property (2:00–2:45)

**Shot 6 — the contribute flow** (needs Lace on Preprod, funded with tDUST — see
[DEPLOY.md](DEPLOY.md) §3). This is the one shot that can fail, so record it last and have a
cutaway ready.

- The salary field. *Typed on your own device. It is a private witness — it never leaves here.*
- The bucket shown back: `$125k–$150k`. *Your exact figure is not recoverable from what you
  submit.*
- The proof generating. *Locally. We ship our own proof server precisely because the witness
  must not go to a third party.*
- The histogram on the report page increments by one.

**Shot 7 — submit again with the same identity.** Rejected.

- *The nullifier is `hash(secret, period)`. It proves you already contributed this period
  without revealing who you are. The issuer sees a leaf, never the secret that derives this.*

## Act 4 — close (2:45–3:00)

**Shot 8 — the home page**, scrolling to the three pills: **provable / unlinkable /
suppressible**.

Then state the buyer and the date: *From 7 June 2027, every EU employer with 150+ staff has to
publish this. Our customer is the Head of Total Rewards, and their project starts now, because
they report on last year.*

**One honest line to include.** The issuer still learns who is a member — it just cannot link a
person to their figure, because it never receives the secret. Replacing it with a Merkle
membership proof is Wave 3, and it is on the comparison slide in the deck. Naming the residual
trust assumption is more persuasive than hiding it.

---

## Failure modes to have a cutaway for

| If this breaks | Do this |
|---|---|
| Lace not installed / not funded | Skip to Act 2 — the report and verification need no wallet. Say so: *this is the part a works council actually uses.* |
| Proof server slow | `pnpm --filter @gotit/shared exec tsx src/paygap.cli.ts --demo` in a second terminal |
| Indexer unreachable | The report page will show an explicit error. Do not pretend otherwise — show the error and say it refuses to substitute data. |

## Do not

- Do not narrate jargon: *nullifier, witness, ledger, Compact, epoch* are developer words. Say
  "the number that proves you contributed without saying who you are" instead.
- Do not show the sample data without the banner in frame.
- Do not claim k-anonymity protects against someone reading the indexer directly. It is enforced
  in the read path; the report's suppression is what protects the published artifact. That
  distinction is stated in `docs/SPEC.md` and it is the honest position.
