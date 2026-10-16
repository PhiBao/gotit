# Demo video script

**3:30.** Read the bold lines off a second screen.

## Before recording

- `pnpm -r test` — 278 pass
- `#report` loads on https://gotit-web.fly.dev
- A second tab **already scrolled to Withheld**
- `gotit.compact` open at `getGroupHistogram` (~205)
- Editor and terminal at **140%**
- Lace unlocked, on Preprod, notifications off

No publishable rows yet? Use `#report&sample` and **say it is sample data**. The banner is obvious;
pretending costs more than admitting.

---

## 0:00 · The report

**On screen:** `#report`, top.

> **From June 2027, every EU company over 150 employees has to publish its gender pay gap — mean,
> median, base versus variable, by category of worker. A gap of five percent or more that cannot be
> justified triggers a joint pay assessment with worker representatives.**
>
> **This is that report. No wallet, no account, no login.**
> *(pause)*
> **If you are checking this as a works council member or a regulator, you need nothing from us.**

## 0:20 · Counts, and nothing else

**On screen:** scroll to **Withheld**.

> **Every figure comes from counts on a public ledger. No individual salary is readable from this
> chain — not by me, not by the employer who deployed it, not by anyone querying it directly.**
>
> **The contract returns zero for any group below the anonymity threshold, and that gate is inside
> the circuit. An employer cannot override it, cannot publish a small group, and cannot write a
> reader that skips the check. The data is unreadable, not deleted.**

**Hover two rows with different reasons.**

> **These are different facts. No data: nobody reported. No comparison group: one side reported, and
> publishing it would reveal the other by subtraction. Below k: both sides are there but one is too
> small. Only that last one is fixed by recruiting people.**

## 1:00 · The part that matters

**On screen:** `#report&sample`, a row with intervals.

> **Sample data, labelled, because the chain does not have enough participants yet.**
>
> **The means are intervals, not single numbers. The data is bucketed, so the truth is bounded, not
> revealed. A midpoint would be a guess dressed up as a statistic.**
>
> **That changes the compliance decision. Five percent triggers an assessment — so we flag only when
> the bound nearest zero still reaches five percent. A range of minus 33 to plus 50 has a midpoint
> of plus 8.3, and flagging that would trigger an assessment on a category that may be perfectly
> compliant.**

**Scroll to the `Art. 9(1)(e)` row.**

> **This row is why I would trust the rest. The Directive asks for the share receiving variable pay.
> That needs the people who got both base and variable — and our ledger holds those in separate,
> unlinkable cells, which is the property everything else depends on.**
>
> **So it cannot be computed as a number here. We publish the interval the model does bound, and
> name the two ways to tighten it and why we refuse both. Most reports print a number for this. We
> can show why that number would be invented.**

## 1:40 · It is checkable

**On screen:** `#verify`. Paste. Match.

> **A report is worth what you can check about it. Paste — match.**

**Change one character. Mismatch.**

> **One character different. A check that cannot fail proves nothing.**

**On screen:** terminal.

```bash
pnpm --filter @gotit/contract verify:chain -- \
  --address 92fb35dbabd74dc97222c0ce5f7b72f2aed83c6c7d264a5ef94431199720c0d0 \
  --categories engineering,sales,operations,management
```

> **And the same report, reproduced from public chain state with one command. No wallet, no key, no
> permission. The engine is a pure function, so anyone running this gets identical output. That is
> the difference between a report and a claim.**

## 2:20 · The gate

**On screen:** `gotit.compact`. Highlight the `kThreshold` line.

> **Nine lines. This is where the anonymity rule lives.**
>
> **Below the threshold every bucket reads as zero — for the employer who paid for the deployment
> exactly as much as for anyone else. Suppression in a report generator is a convention: it holds
> until someone writes a different reader.**

**Cut to `chainRead.test.ts`, scroll.**

> **Forty-five tests run the generated contract off-chain. Eleven drive the whole path — submit,
> decode, shape, build the report — so a drift between the browser's hashing and the circuit's fails
> the build instead of silently filing a salary in the wrong cell.**

## 3:00 · The limitation

**On screen:** back to the report, then the landing page.

> **Two things if you were buying this.**
>
> **Because no party holds the salary, we cannot prove a submitted figure is the figure actually
> paid. A payroll-attestation design can, because the provider holds the rows before committing.
> Attestation verifies the employer; this protects the employee.**
>
> **And proving happens on a server we run, which has the private inputs. It does not record them,
> and running locally avoids it — but it is in the trust path, and I would rather say so than let
> you find it.**
>
> **Provable, unlinkable, on the employee's side of the table. That is the bet.**

**Stop.** No tagline.

---

## If it fails

Say the line. Never fake it.

| Fails | Say |
|---|---|
| No rows | "Nothing clears the threshold yet, which is correct. Here is the same page with labelled sample data." |
| Indexer errors | "The app names the upstream problem and refuses to show numbers — deliberately. A plausible table in a filing is worse than an error." |
| Wallet hangs | "Connections are narrated, because a wallet that accepts a request and never answers looks like a broken app." |
| CLI slow | Keep talking: "This reads the ledger directly. No wallet, no account." |
| Test red | Stop. Fix it, or cut the shot. |

## Never

- **No jargon to camera.** Not *nullifier*, *witness*, *Merkle*, *epoch*, *Compact*, *zkir*.
- **Never show sample data without its banner in frame.**
- **Never claim k-anonymity hides a group's existence.** It hides the pay bands. Group sizes are
  public, and a judge can falsify that by querying the indexer.

## After

Upload unlisted. Paste the URL into `AKINDO_SUBMISSION_DRAFT.md` → `demo_video`. Open it in a
private window to confirm it is not private. Then `pnpm check:submission`.
