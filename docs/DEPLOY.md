# Deploying GotIt to Midnight Preprod

Status: the contract is **compiled, tested and live on Preprod** at
`e7cf6ffc48ebeb450813104e6a5ab3d585f7e275bcd32e5ea82eb7a8c21dd53d`. The browser Operator
console in `apps/web` is the working deployment path; the CLI script is a stub. Follow this doc
top to bottom for a fresh environment, or §8 to resume the paused hosted deployment.

> The contract source is `packages/contract/src/candor.compact`. The name is **frozen** — its
> `candor:*` domain strings are inputs to the deployed contract's hash derivations. The product
> was renamed Candor → GotIt; the contract identifiers were not.

## 0. Prerequisites

- Node ≥ 20, pnpm 9
- Docker (proof server)
- [Lace browser extension](https://www.lace.io/) with a Midnight account (Preprod)
- Compact toolchain: `compact update` (0.31.1) — only needed to recompile; compiled artifacts are committed

## 1. Build the contract

```bash
pnpm install
pnpm contract:compile        # compact compile src/candor.compact src/managed/candor
pnpm contract:build
pnpm --filter @gotit/contract test   # circuit tests must pass before deploy
```

## 2. Start the proof server (user-local)

The witness contains the salary, so proving must happen on the contributor's own machine — never on a hosted server.

```bash
docker compose -f packages/contract/proof-server.yml up
# listens on http://localhost:6300
```

## 3. Fund the deployer wallet (tNIGHT → tDUST)

On Preprod the faucet does NOT dispense tDUST — you generate it from tNIGHT:

1. Create/recover a Midnight account in Lace, switched to the **Preprod** network.
2. Copy your **unshielded** address — it starts `mn_addr_preprod1…`, NOT the shielded
   address — and request tNIGHT from the
   [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/) (1000 tNIGHT per request).
3. **Wait for the transfer to finish confirming.** Lace shows it as *Pending* first. The wallet
   cannot register NIGHT it has not yet received.
4. In Lace, open the Midnight wallet and click **Generate tDUST** → Review → Confirm.
   This registers your tNIGHT for DUST generation (an on-chain transaction).
5. Wait 1–2 minutes: tDUST accrues continuously into the tDUST tank, up to a cap set by your
   registered tNIGHT. Deploy once you see a tDUST balance.

### "At least one Night UTXO is required"

Lace says this when it holds no **unshielded, confirmed** NIGHT to register. Three causes, in
order of likelihood:

| Cause | Fix |
|---|---|
| The faucet transfer is still pending | Wait. Lace shows the balance before the UTXO is spendable. |
| The tNIGHT went to the **shielded** address | Request again to the `mn_addr_preprod1…` address. The faucet needs the unshielded one. |
| The wallet has not re-synced | Lock and unlock Lace, or wait — a first Preprod sync can take several minutes. |

### "Lace never answers Connect"

Observed on an older Lace build: `connect()` is accepted, the wallet sits open and unlocked, and
no approval prompt ever appears. **Update Lace.** That fixed it in our case. Two related causes:

- The approval prompt lives behind the **toolbar icon**, not the side panel. The side panel shows
  balances and does not reliably show connection requests.
- Retrying while a request is pending stacks requests inside the wallet, which can wedge it. The
  app now sends one request per press, but an already-wedged wallet needs
  **Settings → Connected apps → remove the dApp**, then reconnect.

See [Funding a wallet](https://docs.midnight.network/guides/acquire-tokens) for the
full guide and troubleshooting.

## 4. Configure

```bash
cp packages/contract/.env.example packages/contract/.env
```

| Variable | Meaning |
|---|---|
| `MIDNIGHT_NETWORK` | `preprod` |
| `MIDNIGHT_INDEXER` / `MIDNIGHT_INDEXER_WS` | Preprod indexer GraphQL endpoints |
| `PROOF_SERVER` | `http://localhost:6300` |
| `MIDNIGHT_WALLET_SEED` | deployer seed — **never commit the real value** |
| `GOTIT_ISSUER_KEY` | 32-byte hex issuer secret key used by `enroll`/`nextEpoch` |

The deploy script derives `issuerCommit = persistentHash([pad(32,"candor:issuer:v1"), issuerKey])` via `@gotit/shared/hash` (bit-identical to the circuit) and passes it to the constructor.

## 5. Deploy

```bash
pnpm --filter @gotit/contract deploy:preprod
```

The script prints the contract address. Store it in `CONTRACT_ADDRESS` (same `.env`) — the web app and issuer read it from there.

## 5b. Deploy the v2 ledger (Wave 2 — the report surface)

v1 is live and frozen. **v2 is a separate deployment, not a migration** — see the rationale in
the `Challenges` section of the pitch deck, and the frozen-domain note on
`packages/contract/src/candor.compact`. Its `gotit:*` hash domains mean a v1 leaf deliberately
fails to validate against v2, which is the point of the version bump.

v2 adds the Directive's three missing dimensions — job category, gender, and base vs variable
pay — plus the anonymity threshold and a per-group counter. The report page at `#report` reads
v2, so until it is deployed that page reports nothing publishable. It does not fall back to v1's
numbers.

**The CLI path needs a seed.** `MIDNIGHT_WALLET_SEED` in `packages/contract/.env` (see §3 for
funding it first). The deploy script's `args` differ from v1 — the constructor takes a
`kThreshold`:

```bash
# in packages/contract/src/deploy.ts, the v2 branch passes:
#   args: [issuerCommitment2(issuerKey), BigInt(DEFAULT_K)]
pnpm --filter @gotit/contract deploy:preprod --contract gotit --k 5
```

**The browser path needs no seed.** This is the one that was used for Wave 1, and the one to
prefer if you are following this doc:

1. Open the app with the Lace wallet extension on **Preprod**, funded with tDUST (§3).
2. Open **Operator** (top right).
3. Under **Wave 2 contract — Art. 9 dimensions**, press **Deploy v2**. `k` is fixed at
   deployment and is public thereafter via `readK()`, so the report can state the threshold
   actually in force.
4. The address is stored under `gotit:contractV2`, separately from v1's. Press **Use v2 as the
   report source** to point the report at it.

The v2 ZK artefacts are already served at `/zk/gotit`, so you do not need the Compact
toolchain to deploy. Rebuild them with `pnpm --filter @gotit/web sync:zk` if you recompile.

## 6. Verify

```bash
# read epoch (should be 1)
# read a histogram bucket via the indexer public data provider
pnpm --filter @gotit/contract verify:preprod
pnpm --filter @gotit/contract verify:preprod --contract gotit   # v2
```

## 7. Run the issuer + web app

```bash
pnpm --filter @gotit/issuer dev   # :8787
pnpm dev                           # :5173, proxies /issuer
```

## 8. Hosted environment on Fly.io (pause / resume)

Three Fly apps back the hosted demo: `candor-midnight-prover` (own proof server,
`midnightntwrk/proof-server:8.1.0`), `candor-midnight-issuer` (Express), `gotit-web`
(Caddy serving the built app plus same-origin `/issuer`, `/indexer`, `/proof-server` proxies).

**Pause (stop all compute spend)**

```bash
set -a; source .env; set +a          # FLY_ACCESS_TOKEN lives in .env
fly scale count 0 -a candor-midnight-prover --yes
fly scale count 0 -a candor-midnight-issuer --yes
fly scale count 0 -a gotit-web    --yes
```

`fly machine stop` is **not** enough: the web and prover configs set
`min_machines_running = 1`, so the platform restarts a stopped Machine. `scale count 0`
removes the Machines (images, releases and the deployed contract stay intact). The three
public URLs then return 503 — expected while paused.

A plain `fly deploy` leaves the *previous* machine behind alongside the new one. To get back
to one machine per app:

```bash
fly machine list -a gotit-web          # find the stale id
fly machine stop   <stale-id> -a gotit-web
fly machine destroy <stale-id> -a gotit-web --force
```

**Resume**

```bash
set -a; source .env; set +a
fly deploy -c fly.prover.toml        # first: web proxies /proof-server and fails without it
fly deploy -c fly.issuer.toml
fly deploy -c fly.web.toml
curl -s https://candor-midnight-issuer.fly.dev/health   # {"ok":true,...}
```

Notes:
- `fly.web.toml` bakes `VITE_CONTRACT_ADDRESS` and `VITE_ISSUER_KEY` as build args, so a
  web deploy always targets the current contract.
- The prover machine must stay `auto_stop = "suspend"` (never `stop`/`destroy`): a cold start
  returns 403 on `/proof-server/prove`.
- The issuer keeps verification leaves in memory, so a redeploy resets them; that is fine for
  demos (codes are issued in-band).

## 8b. The indexer moved. Twice. Read this before deploying.

> **Summary.** Midnight decommissioned its Preprod and Mainnet indexers on
> 2026-10-09 and moved both to Blockfrost, which needs a project token.
> `preview` is still Midnight-hosted and needs no token. There are two working
> deployments; pick by whether you want the existing contract or a fresh demo.

### What happened

| # | Endpoint | Fate |
|---|---|---|
| 1 | `blockfrost.lw.iog.io/midnight-preprod` | 410 Gone, proxy retired (Sep 2026) |
| 2 | `indexer.preprod.midnight.network/api/v4/graphql` | 410 Gone, decommissioned 2026-10-09 |
| 3 | `midnight-preprod.blockfrost.io/api/v0` | **current for preprod** — needs a token |
| — | `indexer.preview.midnight.network/api/v4/graphql` | **tokenless**, Midnight-hosted |

The Wave 1 contract lives on **Preprod**, so reading it needs a Blockfrost token.
Midnight's own migration guide states Blockfrost "runs the same indexer API that
the Midnight-hosted endpoints served, so a DApp moves to it by changing its
endpoint URLs and adding a token, not by changing code" — so the only differences
are the URL path and the credential.

### Path A — Preprod, the existing contract (needs a Blockfrost token)

The app is already configured for this and currently reports
`Missing project token` on every live read, which is the only thing missing.

```bash
# 1. Get a token: sign up at blockfrost.io, create a project for
#    "Midnight Preprod". The project ID starts with `nightpreprod`.
#    Verify it before going further:
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"query":"{ block { height } }"}' \
  "https://midnight-preprod.blockfrost.io/api/v0?project_id=$BLOCKFROST_PROJECT_ID"

# 2. Set it as a SECRET (fly.web.toml is committed; a token is not):
fly secrets set -a gotit-web BLOCKFROST_PROJECT_ID=nightpreprod...

# 3. Nothing else. INDEXER_URL is already midnight-preprod.blockfrost.io and the
#    build already uses /api/v0. The secret takes effect on the next boot.
```

The Caddyfile adds `header_up project_id {$BLOCKFROST_PROJECT_ID}` to the
`/indexer/*` proxy. That is why the token stays server-side: a token in a
browser-side URL is visible to anyone who loads the page and spends your quota,
and `indexerPublicDataProvider(queryURL, subscriptionURL)` could not send a
header from the browser anyway.

### Path B — no token? Use Preview locally instead

`preview` is the one public network Midnight still hosts itself and it needs **no token**, which
makes it the fallback when Blockfrost is unavailable or you have no account. It is not a second
deployment: keeping a whole extra Fly app alive for a network with no contract on it was cost and
confusion for no benefit, so it was removed. Run it locally when you need it:

```bash
# 1. a build pointed at Preview
VITE_MIDNIGHT_NETWORK=preview \
VITE_INDEXER_PATH=/api/v4/graphql \
VITE_INDEXER_WS_PATH=/api/v4/graphql/ws \
pnpm --filter @gotit/web build

# 2. serve it with the proxy pointed at Preview
INDEXER_URL=https://indexer.preview.midnight.network \
INDEXER_HOST=indexer.preview.midnight.network \
pnpm --filter @gotit/web preview
```

Preview has no GotIt contract, so the first thing to do there is deploy one: fund a wallet from the
[Preview faucet](https://midnight-tmnight-preview.nethermind.dev/), switch Lace to **Preview**, and
press **Deploy v2** in the Operator console. The report page will read it, and no token is involved
anywhere.

### Running entirely locally (no network at all)

Midnight publishes a full local stack — node, indexer and proof server in Docker
— via [midnight-local-dev](https://github.com/midnightntwrk/midnight-local-dev).
It initialises a pre-funded genesis wallet and funds test accounts, so it needs
no faucet and has nothing at risk. Endpoints:

```
node      http://localhost:9944
indexer   http://localhost:8088/api/v4/graphql   (ws on /ws)
proof     http://localhost:6300
```

Then build the app with `VITE_MIDNIGHT_NETWORK=undeployed` and
`VITE_INDEXER_PATH=/api/v4/graphql`, and point `INDEXER_URL` at
`http://localhost:8088` with no token. This is the only configuration that
depends on nobody else's infrastructure, which makes it the right fallback if a
public endpoint moves again mid-demo.

### What the app does when the indexer is unreachable

It refuses to present sample data as chain data, and it names the actual cause
instead of showing an empty chain. `apps/web/src/lib/indexerStatus.ts` classifies
the response — 410 decommissioned (with the migration link read out of the body),
403 missing or invalid token, 404 incompatible API or proxy path, 5xx unreachable
— and the banner states which, with the fix. "Nobody has run a reporting period
yet" and "we cannot reach the chain" are different facts, and a compliance
product that renders the same empty state for both is hiding an outage behind a
plausible page.

## 8c. App names

| App | Name | Why |
|---|---|---|
| Web | `gotit-web` | Judge-facing. The name is part of the product, so it matches it. |
| Proof server | `candor-midnight-prover` | Infrastructure. Renaming a Fly app destroys its URL and its history, and nothing user-visible points at it — the browser reaches it through the web app's same-origin `/proof-server` proxy. |
| Issuer | `candor-midnight-issuer` | Same reasoning, and it is only used by the work-email flow. |

Both dated names are kept deliberately. Renaming them would mean re-pointing the proxy and
re-verifying proving and enrolment, for a string that no visitor sees.

## 9. The indexer moved — check this after any infra change

The browser reads contract state through a same-origin `/indexer/*` proxy (Caddy on Fly, Vite
in dev). Two upstreams have now failed us, so verify this path rather than assuming it:

| Upstream | Status |
|---|---|
| `blockfrost.lw.iog.io/midnight-preprod` | **410 Gone** — "Midnight endpoints have been removed from this proxy" (Sep 2026) |
| `indexer.preprod.midnight.network` API v4 | **410 Gone** — decommissioned 2026-10-09 |
| `midnight-preprod.blockfrost.io/api/v0` | **Current for Preprod.** Needs a project token; `/api/v0` and WS at `/api/v0/ws`. |
| `indexer.preview.midnight.network/api/v4/graphql` | **Tokenless.** Midnight-hosted, still live. No contract of ours on it. |
| `localhost:8088/api/v4/graphql` | A local network via `midnight-local-dev`. No token, no external dependency. |

Caddy uses `uri strip_prefix /indexer` (not `handle_path`): the path suffix *is* the API path,
so `/indexer/api/v0` must reach upstream as `/api/v0`. Which path is correct depends on the
upstream — `/api/v0` for Blockfrost, `/api/v4/graphql` for a Midnight-hosted endpoint — and the
browser is told which via the `VITE_INDEXER_PATH` build arg.

Check the proxy is actually serving data:

```bash
# /api/v0 is Blockfrost. The old /api/v4/graphql path is the decommissioned one.
curl -s -X POST https://gotit-web.fly.dev/indexer/api/v0 \
  -H 'content-type: application/json' \
  -d '{"query":"query { block { height } }"}'
```

If the app shows the "sample data" badge while this returns data, the proxy config is wrong.
If this returns 410, the upstream moved again — update `INDEXER_URL` in `fly.web.toml`, the
target in `apps/web/vite.config.ts`, and the paths in `apps/web/src/lib/chainRead.ts`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Proof server connection refused | `docker compose -f packages/contract/proof-server.yml up` not running, or wrong `PROOF_SERVER` |
| `Insufficient Funds: could not balance dust` | tNIGHT not registered for DUST generation yet — run **Generate tDUST** in Lace and wait for the tank to fill |
| `wrong network` | Lace is on a different network than `MIDNIGHT_NETWORK` |
| `enroll: caller is not the issuer` | `GOTIT_ISSUER_KEY` in the issuer service ≠ key committed at deployment |
| `already submitted this epoch` | expected — one submission per member per epoch; issuer must call `nextEpoch` |
