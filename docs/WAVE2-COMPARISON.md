# Wave 2 competitive review — GotIt vs Equilux

**Written 30 October 2026.** Judging closes 31 October, so this is an assessment from
the artefacts, not from scores. If the rubric disagrees, the rubric wins.

The short version: **we built a better privacy model for a buyer who needed a proof of
completeness. They built the proof of completeness.**

---

## What each product actually is

| | GotIt | Equilux |
|---|---|---|
| Data model | Each employee submits a bucketed figure from their own device. The ledger accumulates counts. | The payroll provider commits a hiding hash of every payroll row. Employees enrol against their row. |
| Who holds salaries | Nobody. Not the employer, not us. | The payroll provider and the employer — as they already did. |
| How figures are produced | The contract holds counts; **our TypeScript engine computes the statistics** at read time. | The contract **computes and proves the statistics** from the full payroll witness. |
| Precision | Means and gaps as **intervals**, because buckets only bound them. | **Exact** figures, because the prover has the exact values. |
| Art. 9 coverage | Six indicators. **(e) published as non-derivable.** | **All seven**, including (e). |
| Suppression | **k = 5**, enforced in the read circuit. | **k = 3**, enforced when publishing. |
| Completeness | Voluntary. Coverage is whatever people give. | **Proven**: invented employees, omitted employees, and altered pay are all rejected. |
| On-chain evidence | 13 members, 13 submissions, **1 publishable category**. | **19 transactions, block heights, tx IDs**; all seven figures proven and published. |

That row — *how figures are produced* — is the whole competition.

---

## The evidence, verified rather than claimed

**Equilux.** `contract/preprod/deployment.json` records 19 steps with `txId`, `txHash` and
`block`: deploy at 2,787,450, `declareRoster` at 2,787,454, `confirmPayroll` at 2,787,463,
fourteen `enroll` transactions, `publishReport` at 2,787,543, `publishVariablePay` at
2,787,556. The contract is live on Preprod at `598b346e…d1cb`, and their `/verify` page
decodes it from the indexer and renders:

> The payroll provider committed 14 payroll rows · The works council opened every row and
> confirmed the payroll · 14 of 14 rows enrolled · Pay-gap report published: Art. 9(1)(a),
> (c), (g) · Variable-pay report published: Art. 9(1)(b), (d), (e), (f), (g)
> Mean gap 9.69% · Median gap 1.81% · 7 women, 7 men · Variable-pay mean gap 27.50%

I checked the contract exists on Preprod, and I loaded the page. It is real.

**GotIt.** Our v2 contract is live at `92fb35db…c0d0` with 13 members and 13 submissions.
Its report shows **one** publishable category — engineering, 5 women and 5 men, mean gap
115.0%–273.3% — and seven withheld groups. The report is computed by our app from gated
ledger counts. **The contract does not prove any figure.** Nothing we published is a
statement the network attested to.

That asymmetry is what a judge sees first.

---

## Scorecard

Scores are per section out of 100, against the Wave 1 rubric. The total is an equal-weight
mean; the real rubric weights are not public, so treat the total as indicative and the
section scores as the argument.

### Backend Engineering — Equilux 92, GotIt 78

**Theirs.** Six circuits, and the hard work is inside them: mean gaps verified without
division (`g·base ≤ diff·10000 < (g+1)·base`), median gaps by rank counting with no sort
in-circuit, Merkle receipts so an employee can prove their own record was counted, a
three-key role model (employer, payroll provider, works council), and complete-set binding
so an invented employee, an omitted employee or an altered salary each fail. Compiled with
`compact compile +0.30.0`.

**Ours.** Eight circuits: per-group counters, epoch nullifiers, issuer-gated enrolment, and
a disclosure gate evaluated inside the read circuit. The gate on read is a genuinely good
idea and theirs does not have it — they suppress at publish time, so the published figures
are gated but any raw query is not.

**Why they win the section.** In-circuit statistics over a complete witness is a harder
problem than in-circuit counting, and it is the problem the compliance use case actually
requires.

### Product — Equilux 95, GotIt 72

**Theirs.** A guided six-chapter story. The compiled contract **runs in the browser on
Midnight's WebAssembly runtime**, so the core mechanic is experiencable with no wallet, no
faucet and no DUST. Then eleven "try to cheat" attempts, each refused in the contract's own
words. A Personio/DATEV CSV import for real payroll. A filing pack checked figure by figure.
A works-council role with its own key.

**Ours.** A report page worth reading — intervals, three distinguishable suppression
reasons, a label finder, coverage disclosure, a verification page, and a setup guide written
against Midnight's own funding docs. But to *experience* contributing you need Lace, a
faucet, tDUST and a sync wait. The artefact is strong; the demo is gated behind setup.

**Why they win the section.** A judge with ninety seconds can do everything on their site.
On ours they can read a report with one row in it.

### QA — Equilux 90, GotIt 82

**Theirs.** 55 tests, **45 against the compiled circuits**, covering every statistic and
every rejection.

**Ours.** 289 tests overall, but only **21 against the v2 circuits**, plus an integration
suite that drives the real pipeline and a build-time check that compares bundled and served
artefacts. Broader coverage, thinner on the part that matters most.

**Why they win, narrowly.** Circuit tests are what a reviewer reads to decide whether the
ZK claims are load-bearing.

### Frontend & UX — Equilux 92, GotIt 84

**Theirs.** Guided narrative, in-browser contract, cheat sandbox, any dApp-connector wallet,
filing pack, error states in the contract's own messages.

**Ours.** Hash-routed report and verification, a narrated wallet connection that
distinguishes a locked wallet from a wedged one, honest failure classification for the
indexer, and a setup guide. Better than most; not better than theirs.

### Communication & Marketing — Equilux 93, GotIt 88

**Theirs.** README with a block-by-block evidence table, a `DESIGN.md`, a `PRODUCT.md`, a
`SUBMISSION.md`, a deck PDF, a demo video, an explicit scope-and-threat-model section, and a
brand mark with a stated rationale.

**Ours.** README with generated diagrams, a changelog including the Wave 3 plan, the public
Wave 1 post-mortem, a word-for-word video script, a reproduction CLI, and a verification
story a third party can run. Also strong. Slightly behind on evidence-at-a-glance: they put
the tx table on the first screen.

### Business Development & Viability — Equilux 92, GotIt 70

**Theirs.** They built **exactly what the Wave 1 judge asked for**: payroll-provider
attestation, and a plugin for Workday/Personio rather than a standalone app. A documented
per-party API surface. A named Wave 3 pilot with a works council. And an honest limit —
"sized instance, 16 records per report and 4 categories, set at compile time" — that tells a
buyer what a real deployment requires.

**Ours.** A named buyer, a real deadline, and a payroll connector **deferred to Wave 3**.
No pilot evidence. No attestation.

**Why they win the section decisively.** The judge told us what they wanted. They shipped
it. We argued for a different architecture instead.

### Total (equal weight)

| | Backend | Product | QA | Frontend | Comms | Business | Mean |
|---|---|---|---|---|---|---|---|
| **Equilux** | 92 | 95 | 90 | 92 | 93 | 92 | **92.3** |
| **GotIt** | 78 | 72 | 82 | 84 | 88 | 70 | **79.0** |

A 13-point gap, concentrated in Product and Business Development.

---

## The three reasons we lose

**1. We answered a different question than the one the judge asked.**

Wave 1 feedback asked for payroll attestation and an HRIS plugin. We read that as "become a
plugin eventually" and spent Wave 2 deepening employee-side privacy — a property the buyer
never asked for and cannot easily sell internally. Equilux read it as a specification and
built both things. On a rubric that rewards building what was asked for, that is not close.

**2. Our strongest claim is app-side; theirs is chain-side.**

"The contract proved these figures from the complete payroll, and rejects a claim one basis
point off" is a sentence a compliance officer can take to a regulator. "Our TypeScript
engine computed these figures from gated counts, and an assertion checks the result" is a
sentence about our code. We believe ours is honest — it is — but it is a weaker *class* of
claim.

**3. We made the demo require setup, and they made it require nothing.**

Their core mechanic runs in the browser against the compiled contract. Ours needs Lace,
tNIGHT, tDUST, a sync wait and a funded wallet before a judge can contribute a figure. That
is a distribution problem presented as a security property: our prover is remote, so
contributing is a transaction.

---

## Where we are genuinely better — and it does not save us

- **k = 5, not 3.** Their k=3 is weak for the group sizes the Directive's 150-employee
  threshold implies. A category of three is still a disclosure.
- **The gate is on the read path.** Any query returns zeros below k, not just the sanctioned
  publish. A bespoke reader gains nothing.
- **Nobody holds the salaries.** Their own scope section says it plainly: the employer already
  holds payroll, and Equilux hides salaries from the public, colleagues, the regulator and
  them — not from the employer. Ours hides them from everyone, at the cost of completeness.
- **Independent reproduction.** `pnpm verify:chain` re-runs a pure engine and gets identical
  output. Their `/verify` decodes published state; excellent, but it reads what the contract
  asserted rather than recomputing it.
- **Our instance is not hard-coded** to 16 records and 4 categories.

These are real. They are also the wrong things to have optimised, given what was asked for.

---

## What we would have to change to win a Wave 3

1. **Build the attestation.** Commit hashed payroll rows before enrolment, gate enrolment on
   an unclaimed row, and record each contribution as confirmed, corrected or declined. That
   single change converts our figures from "computed from voluntary submissions" to
   "computed from a committed roster", and it is the thing the judge asked for twice.
2. **Move the statistics into the circuit.** A contract that proves the mean and median it
   publishes, rather than an app that computes them afterwards, is a different category of
   product. Our engine can stay as the reference implementation for third-party checking.
3. **Make the demo need nothing.** Run the compiled contract in the browser for the sandbox
   path, and keep the wallet path for the real submission. A judge should be able to try the
   mechanic without a faucet.
4. **Keep the two things we do better** — k=5 and the read-path gate — and say so in one
   sentence rather than a section.

The uncomfortable summary: the privacy model was the interesting engineering, and the
attestation was the product. We spent the wave on the interesting part.
