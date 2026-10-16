# Changelog

A wave is a build period. Wave 1 ran 27 Aug – 16 Sep 2026 and scored zero of 159 submissions;
Wave 2 runs 29 Sep – 19 Oct 2026. The [Wave 1 post-mortem](docs/WAVE1-POSTMORTEM.md) explains the
zero, because the next wave's plan only makes sense next to it.

Format follows [Keep a Changelog](https://keepachangelog.com/). Entries are grouped by what
changed for a reader of the product, not by commit.

---

## [Wave 3] — milestone, not started

**Theme: from a report you can check, to infrastructure that makes pay claims checkable.**

Wave 2 proved the hard part — that an employer can publish a defensible Art. 9 report from a
ledger that holds counts and nothing else. Wave 3 is about whether anyone can *adopt* it, and
whether the artifact is worth more than one filing.

The two things standing between the current build and a company running it for real are the ones
we named in the Wave 2 limitations: **nobody wants to be the first person in their company to
submit**, and **nothing links a submitted figure to a figure actually paid**. Both are adoption
problems, not cryptography problems, and both have a plausible answer.

### The adoption problem, and the bet

| | Wave 2 | Wave 3 |
|---|---|---|
| Where figures come from | Employees type them | Imported from the payroll export they already produce, with employees confirming |
| Can an employer invent employees? | Yes — undetectable | No — a committed row must exist |
| Can a figure be altered silently? | Yes | No — changes are visible against the commitment |
| Who sees an individual salary | Nobody | The payroll system that already has it. Still nobody else. |

The bet is that **confirmation is a different act from entry**, and that employees will confirm a
figure their employer already computed in a way they will not hand-type one. That is the whole
design of the connector below: the employer commits, the employee confirms, and the ledger records
the confirmation rather than the number.

It does not fully close the gap between the two models. A committed row still cannot be proven to
correspond to a real person's real pay — only that the employer cannot change it afterwards
without it being visible. The Wave 2 limitation section says the same thing, and Wave 3 narrows it
rather than pretending to eliminate it.

### Planned

**A payroll connector, and the attestation that comes with it.**

- Read-only importer for the exports companies already produce — Personio and DATEV first, then a
  documented CSV shape so anything else can be mapped.
- The importer runs locally and commits `hash(employer_salt ‖ row)` per payroll row before
  enrolment opens. The employer cannot see the hash preimage, so the commitment binds the row
  without publishing it.
- Enrolment is gated on an unclaimed committed row matching the employee's record, so a group
  cannot be padded with people who do not exist.
- Contributions are recorded as *confirmed*, *corrected* or *declined*, and the report states the
  mix. A report built entirely from unconfirmed rows says so.
- **Why this is the priority:** it is the direct answer to the sharpest critique this space has
  received — that a standalone app cannot win, and the product has to become a plugin for the
  systems companies already run.

**Trustless membership.**

- Replace the trusted issuer with a Merkle membership proof, so no company learns who its
  employees are even to verify them. `HistoricMerkleTree` in the ledger, membership witness in the
  circuit, and the issuer service becomes an enrolment helper rather than an authority.
- This removes the second of the two residual trust assumptions named in the README. The first —
  the proof server seeing the witness — is addressed separately below.

**Proving without a server in the trust path.**

- Evaluate in-browser proving against real circuit sizes and measure it. The circuits are small
  enough that this may already be practical, and it would remove the last party that sees a
  witness.
- If it is not practical, the alternative is a proving service with a published retention policy
  and a reproducible build, stated as an explicit trade rather than an unexamined default.

**Period-over-period comparison.**

- The same ledger answers a question a single filing cannot: did the gap close after an
  intervention? Reports become comparable across periods, with the comparison published alongside
  the numbers.
- This is the beginning of the durable position. A single compliant PDF is a commodity; a series
  of mutually consistent, independently reproducible filings is infrastructure.

**A filing pack.**

- One download containing the report, the fingerprint, the reproduction command, the coverage
  statement and the disclosure notes — everything a regulator or works council needs, in the shape
  they ask for rather than the shape we render.
- National authority formats do not exist yet, so this starts as a documented pack and becomes a
  template when a pilot needs one.

**Operational maturity.**

- `k` configurable per deployment and stated per report, rather than fixed at 5. Different
  jurisdictions will want different numbers and the report already prints what was applied.
- Mainnet readiness: the Foundation's deployment review, a funded production wallet, and the
  security checklist.
- One named pilot producing a real report on real data, with a works council reading it.

### Explicitly not planned

Multi-entity or group consolidation, mobile apps, and a hosted multi-tenant service. All three
are plausible businesses and none of them is the next thing that makes the product adoptable.

---

## [Wave 2] — 2026-10-19

**Theme: a compliance product with a named buyer, instead of a community with a good idea.**

Wave 1 built a worker-facing salary benchmark and scored zero. It was not the build that failed —
it was the positioning, the pitch and the submission. This wave is a different product aimed at the
Head of Total Rewards at a 150–2,500 person EU company, who must file by 7 June 2027.

### Added

**A second Compact ledger, `gotit.compact`.** Eight circuits and 26 tests, compiled with
Compact 0.31.1. Wave 1's
`candor.compact` keyed its histogram on a `(family:level:region)` cut, which cannot express the
Directive's "category of worker", a gender split, or base versus variable pay. The new ledger adds
all three dimensions, an anonymity threshold fixed at deployment, and a per-group counter so the
gate is a single lookup.

**Disclosure control enforced inside the read circuit.** `getGroupHistogram` returns zero for any
group below the threshold. Seven of the v2 ledger's 26 tests exist only to hold that property down.
Suppression implemented in a report generator is a convention — it holds until someone writes a
different reader. Here the employer who paid for the deployment gets zeros too.

**`getGroupHistogram`, a whole-group read.** The gate is evaluated per group, not per pay band, so
returning all ten bands in one call enforces the same rule at a tenth of the cost. This is a
structural fix rather than a performance one: an expensive read path is one people route around,
which is exactly how the gate came to be documented as enforced while the app read raw state.

**The Art. 9 report engine** (`packages/shared/src/paygap.ts`). Forty tests. Means and gaps as
intervals rather than point estimates, because the data is bucketed and the exact figures are not
recoverable. Materiality judged on the bound nearest zero, not the midpoint: a range of −33% to
+50% has a midpoint of +8.3%, and flagging that would trigger a joint pay assessment on a category
that may be perfectly compliant. Pure — no I/O — so a third party can re-run it and get
byte-identical output.

**Art. 9(1)(e) published as a proof of non-derivability.** The proportion receiving variable pay
cannot be computed as a point estimate here, because the ledger holds base-pay and variable-pay
submissions in separate unlinkable cells, so their intersection is unknown. The report publishes
the interval the model does bound, names the two privacy regressions that would tighten it, and
explains why both are refused. Every other tool in this space prints a number.

**A report page and a public verification page.** Both readable with no wallet and no account. The
report states the contract it read, the category labels it searched for, the threshold in force,
and — when it has no rows — which of three different causes applies. The verification page takes a
fingerprint, answers match or mismatch against live chain state, and states what that does and does
not prove.

**Independent reproduction as a command.** `pnpm verify:chain --address … --categories …` reads the
ledger through the public indexer and prints the report. No wallet, no issuer key, no proof server.

**A contract diagnostic.** `diagnose:contract` reports counters, whether the group map can be
enumerated at all, and which candidate category labels hash to groups that exist. It exists because
a group is keyed by `hash(label)` and the ledger cannot name what it holds — so a name mismatch is
indistinguishable from an empty contract without it. That cost us a debugging session; it should
not cost anyone else one.

**A label finder in the report page.** `hash(label)` is one-way, so the ledger cannot say what it
holds — but a candidate can be tested against the on-chain hashes. It runs automatically whenever
the report is empty, which is the only moment it is needed.

**An indexer failure classifier.** Decommissioned, missing token, invalid token, wrong API path,
unreachable — each with its own remedy, stated on screen. Distinct from "nobody has run a reporting
period yet", which is a different fact and was previously indistinguishable.

**278 tests**, including 45 against the generated contracts and an integration suite that drives
the whole chain-to-report path.

**Generated diagrams.** An architecture diagram and a disclosure matrix, emitted from scripts in
`docs/diagrams/` so they can be regenerated rather than redrawn, and tested against GitHub's dark
theme.

### Changed

- **Renamed from Candor to GotIt.** The v1 ledger keeps its `candor:*` hash domains because they
  are inputs to live on-chain state; v2 uses `gotit:*`. A v1 leaf deliberately does not validate
  against v2.
- **The landing page sells compliance, not a benchmark.** It was still pitching anonymous salary
  comparison while the deck and submission argued for a compliance buyer.
- **Reads are split deliberately.** Published figures come through the gated circuit; raw ledger
  state is used only to count what exists and report coverage. An assertion re-checks the finished
  report and throws rather than publish a row below the threshold.
- **The wallet connection is narrated.** A wallet that accepts a request and never answers looks
  exactly like a broken app, so the connection reports its phase and escalates its guidance.
- **The indexer is never taken from the wallet.** A browser extension should not choose which
  indexer a compliance report reads, and an out-of-date wallet holds an out-of-date endpoint.
- **Category labels are validated at 32 bytes.** Not characters — a 17-character accented label is
  34 bytes and would otherwise fail inside the prover.

### Fixed

- **Art. 9(1)(b) and 9(1)(d) were unreachable.** `toCategories` built a variable-pay row with
  `total: zeros`, and the engine reads `total` for both the group size and the anonymity gate — so
  every variable-pay row was suppressed as "no data". The headline claim of the wave was
  unshippable, and 38 tests passed throughout because they fed the engine hand-built inputs.
- **Art. 9(1)(e) reported a fabricated 0%.** The share was computed as
  `groupSize(total) − groupSize(base)`, which is zero in both of the app's shapes.
- **Five live submissions read as an empty contract.** Two bugs. `decodeV2State` called
  `Contract.ledger(...)` behind a truthiness check — `ledger` is a module-level export and the
  class has no such static, so it returned `null` every time and every raw-state read produced
  empty maps. And the engine read group *sizes* from the gated figures, which correctly return zero
  below the threshold, so a group of one person and a group that does not exist were
  indistinguishable.
- **The web tests were validating a stale build.** They resolved a workspace package to its
  committed `dist/`, so 42 of them passed against code that had already changed — which is why
  both bugs above survived.
- **The report page read the v1 contract address** on a v2 surface, decoding Wave 1 state with the
  v2 decoder and blaming the chain for a configuration error.
- **"Use v2 as the report source" wrote the v1 key.** The button did the opposite of its label.
- **A deploy could lose the contract address**, and the app then stored the string `"undefined"`
  as an address. Addresses are now validated on read and on write, and a missing one throws rather
  than persisting.
- **A stale contract bundle could not deploy.** Recompiling the contract without rebuilding
  `dist/managed` left the bundle importing one revision while the server offered another. It failed
  with an **empty** error message, because midnight-js runs on Effect. A build-time artefact check
  and an Effect-failure unwrapper now both exist.
- **The unlock loop.** The app threw when an *optional* call failed during connection, so the user
  was told to unlock, retried, and re-triggered the same prompt — a loop no amount of unlocking
  could break.
- **The brand was invisible on the dark header.** Making it a `<button>` brought in the browser's
  default button colour, which overrides inherited text.

### Security

- Disclosure control is two independent layers: the circuit gate, and the report engine's
  two-sided suppression. `assertNoSmallCellLeak` re-derives the suppression and throws rather than
  publish a below-threshold row.
- `groupCount` is keyed per `(category, gender, component)`, never globally, so a large team in one
  category cannot lift a group of one in another.
- The Blockfrost token is a Fly secret injected by the reverse proxy server-side.
  `indexerPublicDataProvider` takes no headers, so the client could not send one even if it tried.
- Address validation on read *and* write.

### Removed

- **The preview deployment.** Two URLs for one product is a second thing to keep alive and a second
  URL to pick the wrong one from. The tokenless `preview` network remains documented as the
  fallback you run locally when the indexer is unavailable.
- **`discoverChainGroups`**, 30 lines of dead code that iterated `groupCount` looking for category
  labels — but the map is keyed by `hash(category, gender, component)`, so it could never have
  matched anything.
- **The staged v2 bundle mismatch**: `VITE_CONTRACT_ADDRESS_V2`, `VITE_MIDNIGHT_NETWORK` and the
  indexer paths were configured in `fly.web.toml` and silently dropped by the Dockerfile.

### Not real, and stated as such

- **Work-email verification is demo mode.** The issuer logs the code and returns it in the HTTP
  response. There is no mail integration. The membership mechanism is real; the email step is a
  stand-in.
- **The sample report is generated in the browser.** Clearly labelled, never an automatic
  fallback, and the figures must never be filed.
- **Proving runs on a server we operate**, which receives the private inputs. It does not record
  them, and a local run avoids it — but it is in the trust path.

---

## [Wave 1] — 2026-09-16 · scored 0 of 159

A worker-facing anonymous salary benchmark. Live on Preprod with real transactions and a working
privacy mechanism, and it scored zero.

**Why:** an empty "Challenges" section (the only one of 159), a placeholder community profile
("chill but cool"), one `TypeScript` tag in the most crowded category, a jargon tagline, and a
changelog where the pitch should have been. The build was not the problem; nobody re-reads their
own submission the way a judge does.

The post-mortem is public at [`docs/WAVE1-POSTMORTEM.md`](docs/WAVE1-POSTMORTEM.md), and
`pnpm check:submission` now fails on exactly those defects — it reports 21 errors against our real
Wave 1 draft.

Retained and still live: `candor.compact` at
`e7cf6ffc48ebeb450813104e6a5ab3d585f7e275bcd32e5ea82eb7a8c21dd53d`, its hash domains frozen
because they are inputs to deployed state.

---

[Wave 3]: https://github.com/PhiBao/gotit
[Wave 2]: https://github.com/PhiBao/gotit
[Wave 1]: https://github.com/PhiBao/gotit
