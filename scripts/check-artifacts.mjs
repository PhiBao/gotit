#!/usr/bin/env node
/**
 * Assert the contract metadata the web bundle will import matches the artefacts
 * the app will SERVE.
 *
 * This exists because they disagreed in production and cost a debugging session.
 *
 * The web app imports the generated contract from `@gotit/contract`, which
 * resolves to `packages/contract/dist/managed/**`. The zero-knowledge artefacts
 * the browser fetches at runtime are served from `apps/web/public/zk/gotit/**`.
 * Two different paths to what must be the same build:
 *
 *   src/managed  --(contract build: cp)-->  dist/managed   --(vite: bundle)-->  JS
 *   src/managed  --(sync:zk: cp)-------->  public/zk/gotit --(http)--------->  browser
 *
 * Recompile the contract and run only `sync:zk` and the served artefacts move
 * while the bundled metadata does not. The generated `contract/index.js` carries
 * the circuit list and the verifier-key commitments, so a mismatch means the app
 * proves against one contract definition and fetches keys for another. The
 * deploy then fails with an Effect FiberFailure whose message is empty, and the
 * cause is two directories being out of step.
 *
 * Guards the generated contract, the per-circuit keys and the zkir, plus
 * contract-info.json. Cheap to run, so it runs on every web build.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "packages/contract/src/managed");
const BUNDLED = join(ROOT, "packages/contract/dist/managed");
const SERVED = join(ROOT, "apps/web/public/zk");

/** Ledgers the app can talk to. Both must be consistent. */
const LEDGERS = [
  { name: "v2", dir: "gotit" },
  { name: "v1", dir: "candor" },
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every file under a directory, relative and POSIX-separated. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/**
 * Files that must match exactly.
 *
 * Deliberately excludes sourcemaps: a `.map` difference changes nothing the
 * runtime does, and including them invites the check to be disabled for noise.
 */
function guardable(files) {
  return files.filter((f) => !f.endsWith(".map"));
}

function compare(label, aDir, bDir) {
  const problems = [];
  if (!existsSync(aDir)) {
    problems.push(`${label}: ${relative(ROOT, aDir)} does not exist — run the contract build`);
    return problems;
  }
  if (!existsSync(bDir)) {
    problems.push(`${label}: ${relative(ROOT, bDir)} does not exist — run sync:zk`);
    return problems;
  }
  const a = guardable(walk(aDir));
  const b = guardable(walk(bDir));
  const aSet = new Set(a);
  const bSet = new Set(b);

  for (const f of a) {
    if (!bSet.has(f)) problems.push(`${label}: ${f} is built but not served`);
  }
  for (const f of b) {
    if (!aSet.has(f)) {
      problems.push(
        `${label}: ${f} is served but not built. The running app would fetch an artefact ` +
          `its bundled contract does not know about.`,
      );
    }
  }
  for (const f of a) {
    if (!bSet.has(f)) continue;
    const ha = sha256(join(aDir, f));
    const hb = sha256(join(bDir, f));
    if (ha !== hb) {
      problems.push(
        `${label}: ${f} differs\n` +
          `      built: ${ha.slice(0, 12)}\n` +
          `      served: ${hb.slice(0, 12)}`,
      );
    }
  }
  return problems;
}

let failed = false;
for (const { name, dir } of LEDGERS) {
  const src = join(SRC, dir);
  if (!existsSync(src)) continue;

  // 1. dist/managed (what Vite bundles) must equal src/managed (the truth).
  const bundledProblems = compare(
    `${name} bundled-vs-source`,
    src,
    join(BUNDLED, dir),
  );
  // 2. public/zk (what the browser fetches) must equal src/managed too.
  const servedProblems = compare(
    `${name} served-vs-source`,
    src,
    join(SERVED, dir),
  );

  for (const p of [...bundledProblems, ...servedProblems]) {
    console.error(`  ✗ ${p}`);
    failed = true;
  }
  if (bundledProblems.length === 0 && servedProblems.length === 0) {
    console.log(`  ✓ ${name} artefacts consistent (bundled and served)`);
  }
}

if (failed) {
  console.error(
    "\nzk artefact check FAILED.\n\n" +
      "The app bundles the generated contract from packages/contract/dist/managed and serves\n" +
      "keys/zkir from apps/web/public/zk. They are produced by two different copies of the\n" +
      "same build, so one can move without the other. Fix with:\n\n" +
      "  pnpm --filter @gotit/contract build && pnpm --filter @gotit/contract sync:zk\n\n" +
      "A mismatch here surfaces at runtime as a deploy failure with an EMPTY error message,\n" +
      "which is why it is worth failing the build instead.\n",
  );
  process.exit(1);
}
