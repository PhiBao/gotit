# Demo video script

**Target 3:30.** Record at 1920×1080. One take is fine; the pauses are written in.

The order is deliberate: the artifact first, the proof second, the privacy mechanism third,
and the honest limitation last. A judge who stops watching after ninety seconds should still
have seen the thing you are claiming.

---

## Before you hit record

**Do these first — they are the difference between one take and five.**

| # | Do this | Why |
|---|---|---|
| 1 | `pnpm -r test` — confirm 278 pass | If a test is red you will read the number wrong on camera |
| 2 | Open https://gotit-web.fly.dev and confirm the report page reads the contract | The whole video depends on this page loading |
| 3 | Open the report page in a **second tab already scrolled** to the withheld table | Scrolling on camera wastes 8 seconds |
| 4 | Have `packages/contract/src/gotit.compact` open in your editor, scrolled to `getGroupHistogram` | Line ~205. Do not scroll on camera |
| 5 | Zoom the editor and terminal to **140%** | It must be readable at 1080p |
| 6 | Unlock Lace **before** recording, and confirm it is on Preprod | A lock prompt mid-take costs a retake |
| 7 | Close Slack, mail, notifications. Full-screen the browser | One notification popup ruins the shot |
| 8 | Terminal: `cd ~/midnight`, font size up, clear the screen | — |

**If you have not seeded publishable data yet**, the report will show withheld rows only. That is
still an honest demo — say so out loud and use `#report&sample` for the populated view. Do not
pretend sample data is live; the banner makes it unmissable and a judge will notice.

---

## The script

### 0:00 – 0:20 · Cold open on the report

**On screen:** https://gotit-web.fly.dev/#report — the top of the page. Do not scroll yet.

> "From June 2027, every EU company with more than 150 employees has to publish its gender pay
> gap — mean, median, base versus variable, by category of worker. And if a gap is five percent
> or more and can't be justified, that triggers a joint pay assessment with worker
> representatives.
>
> This is that report. No wallet, no account, no login — anyone can open this URL."

**Do:** let the page sit for two seconds. Point at `reading 92fb35db…` if visible.

> "If you're checking this as a works council member or a regulator, you don't need anything from
> us. That's the point."

---

### 0:20 – 1:00 · Why the ledger holds counts and nothing else

**On screen:** scroll slowly to the **Withheld** section. Stop there.

> "Every figure here is computed from counts on a public ledger. No individual salary is readable
> from anything on this chain — not by me, not by the employer who deployed it, not by anyone who
> reads the ledger directly.
>
> Read the withheld table. The contract returns zero for any group below the anonymity threshold.
> That gate is evaluated **inside the circuit** — so an employer can't override it, can't publish
> a small cell, and can't write a different reader that skips the check. The data is unreadable
> below the line, not deleted and not hidden."

**Do:** mouse over two withheld rows with different reasons.

> "These reasons matter, and they're different. *No data* means nobody reported. *No comparison
> group* means only one side reported — and publishing that side would reveal the other by
> subtraction. *Below k* means both sides are there but one is too small. Only that last one is
> fixable by getting more people to participate."

---

### 1:00 – 1:40 · The honest part, which is the differentiator

**On screen:** switch to the `#report&sample` tab. Scroll to a category row with intervals.

> "Here's a populated example, clearly labelled as sample data because the live chain doesn't have
> enough participants yet.
>
> Notice the means are **intervals**, not single numbers. The underlying data is bucketed, so the
> truth is bounded, not revealed. A midpoint would be a guess dressed up as a statistic.
>
> This matters for the compliance decision. Art. 9(4) says a five percent gap triggers a joint pay
> assessment. So we flag only when the **bound nearest zero** still reaches five percent. A range
> of minus 33 to plus 50 percent has a midpoint of plus 8.3 — and flagging that would trigger an
> assessment on a category that might be perfectly compliant."

**Do:** scroll to the `Art. 9(1)(e)` row.

> "And this row is why I trust the rest of it. The Directive asks for the share receiving variable
> pay. That requires knowing how many people got **both** base and variable — and our ledger holds
> those in separate, unlinkable cells, which is the property everything else depends on.
>
> So it can't be computed as a number here. We publish the interval the model does bound, and we
> name the two ways to tighten it and why we refuse both. Most reports print a number for this.
> We can show why that number would be invented."

---

### 1:40 – 2:20 · It's checkable, which is the other half

**On screen:** the Verify page. Paste a fingerprint, get a match.

> "A report is only worth what you can check about it. Paste the fingerprint — match."

**Do:** change one character, press Verify, let it fail.

> "And now one character different — mismatch. A check that can't fail proves nothing."

**On screen:** switch to the terminal. Run:

```bash
pnpm --filter @gotit/contract verify:chain -- \
  --address 92fb35dbabd74dc97222c0ce5f7b72f2aed83c6c7d264a5ef94431199720c0d0 \
  --categories engineering,sales,operations,management
```

> "And the same report, reproduced from public chain state with one command. No wallet, no key, no
> permission. The report engine is a pure function, so anyone running this gets byte-identical
> output to what I published. That's the difference between a report and a claim."

---

### 2:20 – 3:00 · Show the gate in the contract

**On screen:** the editor, `gotit.compact`, `getGroupHistogram`.

> "Nine lines. This is where the anonymity rule actually lives."

**Do:** highlight the `if (!groupCount.member(gKey) || groupCount.lookup(gKey) < kThreshold)` block.

> "Below the threshold, every bucket reads as zero — for the employer who paid for the deployment
> exactly as much as for anyone else. The comment here says it's not a UI toggle, and I mean that
> literally: suppression implemented in a report generator is a convention, and it holds right up
> until someone writes a different reader."

**Do:** cut to the test file, `chainRead.test.ts`, scrolling past test names.

> "Forty-five tests run the generated contract off-chain. Eleven of them drive the whole path —
> submit, decode, shape, build the report — so a drift between the browser's hashing and the
> circuit's fails the build instead of silently filing a salary in the wrong cell."

---

### 3:00 – 3:30 · The limitation, stated plainly

**On screen:** back to the report page, then the landing page with the three properties.

> "Two things I'd want you to know if you were buying this.
>
> First, because no party holds the salary, we cannot prove a submitted figure is the figure
> actually paid. A payroll-attestation design can — because the payroll provider holds the rows
> before committing to them. That's a real trade: attestation verifies the employer, this protects
> the employee. They're not the same product.
>
> Second, proving happens on a server we run, and to build a proof that server has the private
> inputs. It doesn't record them, and running locally avoids it entirely — but it's in the
> trust path, and I'd rather say so than let you find it.
>
> What's here is provable, unlinkable, and it sits on the employee's side of the table. That's the
> bet."

**End on the landing page.** Do not add a tagline. Stop recording.

---

## Recovery lines

Say these without breaking flow if something fails. They are better than silence, and better than
pretending.

| If | Say |
|---|---|
| The report page shows no rows | "The chain doesn't have enough participants yet, so nothing clears the anonymity threshold — which is itself the correct behaviour. Here's the same page with clearly-labelled sample data." |
| The indexer errors | "The app tells you the upstream is down and refuses to show you numbers — which is deliberate. A plausible-looking table in a compliance filing is worse than an error." |
| A wallet prompt hangs | "Wallet connections are narrated because a wallet that accepts a request and never answers looks exactly like a broken app." |
| The CLI is slow | Let it run and keep talking. "This reads the ledger directly. No wallet, no account." |
| A test is red | Stop. Do not record a red test. Fix it or cut the shot. |

## Do not

- **Do not narrate jargon.** No *nullifier*, *witness*, *Merkle*, *epoch*, *Compact*, *zkir* to
  camera. Say "the number that proves you contributed without saying who you are".
- **Do not show the sample data without its banner in frame.** The banner is the reason showing it
  is honest.
- **Do not claim k-anonymity hides a group's existence.** It hides the pay bands. Group sizes are
  public ledger state. The README says this; saying something stronger on camera would be a claim
  a judge can falsify by querying the indexer.
- **Do not skip the limitation section.** It is thirty seconds and it is the most persuasive part
  of the video.

## After recording

1. Upload unlisted to YouTube. Paste the URL into `AKINDO_SUBMISSION_DRAFT.md` → `demo_video`.
2. Click the link in a private window to confirm it isn't private.
3. Run `pnpm check:submission`.
