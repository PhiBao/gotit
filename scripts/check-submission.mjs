#!/usr/bin/env node
/**
 * Pre-submit gate for the AKINDO submission draft.
 *
 * Why this exists: in Wave 1 our "Challenges I ran into" section shipped as five
 * bolded headings with no text under any of them — and it was the only such
 * section out of 159 submissions. We never noticed, because nobody reads their
 * own submission the way a judge does. This script is that second reader.
 *
 * It checks two things:
 *   1. STRUCTURE  — every required section exists and actually contains prose.
 *   2. HYGIENE    — the AKINDO page fields that a judge sees before reading a
 *                   single word (tagline length, tags, links, community profile).
 *
 * Usage:  node scripts/check-submission.mjs [path-to-draft.md]
 * Exit:   0 = clean, 1 = at least one error (errors block submission)
 *         Warnings never block.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.argv[2] ?? "AKINDO_SUBMISSION_DRAFT.md");
const raw = readFileSync(FILE, "utf8");

/* ------------------------------------------------------------------ config */

const REQUIRED_SECTIONS = [
  "What it does",
  "The problem it solves",
  "Challenges I ran into",
  "Technologies I used",
  "How we built it",
  "What we learned",
  "What's next",
];

// Sections that must be long enough to be a real answer, not a gesture.
const MIN_WORDS = {
  "What it does": 120,
  "The problem it solves": 120,
  "Challenges I ran into": 150, // <-- the section that failed in Wave 1
  "Technologies I used": 60,
  "How we built it": 100,
  "What we learned": 60,
  "What's next": 80,
};

const MIN_TAGS = 5;
const MAX_TAGLINE = 70;

// Jargon that leaked into customer-facing copy in Wave 1. Allowed in the body
// (judges read it as engineering evidence) but never in the pitch surface.
const PITCH_JARGON = [
  "unlinkable",
  "aggregate-only",
  "epoch",
  "nullifier",
  "nullifiers",
  "compact",
  "zk",
  "circuits",
  "witness",
  "private state",
  "issuance",
  "k-anonymity",
  "homomorphic",
  "ledger",
  "prover",
  "preprod",
];

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/* ------------------------------------------------------------- frontmatter */

const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
const fm = {};
if (!fmMatch) {
  err("no YAML frontmatter — AKINDO page fields must be declared at the top of the file");
} else {
  for (const line of fmMatch[1].split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      v = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, "");
    }
    fm[m[1]] = v;
  }
}

/* ---------------------------------------------------------------- structure */

const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");

// A bullet list is the correct shape for these; the headings-only rule does not apply.
const LIST_OK_SECTIONS = new Set(["Technologies I used"]);

const sections = new Map();
{
  const re = /^(#{2,3})\s+(.+?)\s*$/gm;
  let m;
  const marks = [];
  while ((m = re.exec(body)) !== null) {
    marks.push({ title: m[2].replace(/\s*\{.*\}$/, "").trim(), start: m.index, end: body.length });
  }
  marks.forEach((mk, i) => {
    if (i + 1 < marks.length) mk.end = marks[i + 1].start;
    const chunk = body.slice(mk.start, mk.end);
    const content = chunk.slice(chunk.indexOf("\n") + 1);
    const prev = sections.get(mk.title);
    if (prev) prev.content += "\n" + content;
    else sections.set(mk.title, { content, level: mk.title.length });
  });
}

// Match by prefix so "What's next for Wave 2" satisfies "What's next".
const findSection = (name) => {
  if (sections.has(name)) return { name, ...sections.get(name) };
  const want = name.toLowerCase();
  for (const [title, val] of sections) {
    if (title.toLowerCase().startsWith(want)) return { name: title, ...val };
  }
  return null;
};

for (const required of REQUIRED_SECTIONS) {
  const s = findSection(required);
  if (!s) {
    err(`missing required section: "## ${required}"`);
    continue;
  }
  const name = s.name;
  const { content } = s;
  const text = s.content.trim();

  if (text.length === 0) {
    err(`section "${name}" is EMPTY — this is how the Wave 1 submission was lost`);
    continue;
  }

  const words = (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  const min = MIN_WORDS[name] ?? 50;
  if (words < min) {
    err(`section "${name}" has ${words} words, needs >= ${min}`);
  }

  // The exact Wave 1 failure mode: bolded/bulleted headings with no prose.
  const bullets = LIST_OK_SECTIONS.has(name)
    ? []
    : (text.match(/^\s*(?:[-*+]|\d+\.)\s+.+$/gm) ?? []);
  const proseWords = text
    .split("\n")
    .filter((l) => l.trim() && !/^\s*(?:[-*+]|\d+\.)\s+/.test(l) && !/^\s*\|/.test(l) && !/^\s*>/.test(l))
    .join(" ")
    .replace(/[*_`#|]/g, " ");
  const pw = (proseWords.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  const bulletRatio = bullets.length ? pw / bullets.length : Infinity;
  if (bullets.length >= 3 && pw < bullets.length * 12) {
    err(
      `section "${name}" is headings-only: ${bullets.length} list items, ${pw} words of prose ` +
        `(~${bulletRatio.toFixed(0)} words per item). Every item needs an explanation.`,
    );
  }

  // Unresolved template markers.
  for (const marker of ["TODO", "TBD", "XXX", "FIXME", "Lorem"]) {
    if (text.includes(marker)) err(`section "${name}" still contains "${marker}"`);
  }
}

/* ------------------------------------------------------------------ hygiene */

const tagline = String(fm.tagline ?? "");
if (!tagline) {
  err("frontmatter: tagline is required — it is the only text a judge reads in the results grid");
} else {
  if (tagline.length > MAX_TAGLINE) {
    err(`tagline is ${tagline.length} chars, must be <= ${MAX_TAGLINE} (Wave 1 was 95)`);
  }
  const j = PITCH_JARGON.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(tagline));
  if (j.length) err(`tagline contains jargon: ${j.join(", ")} — use a concrete noun and a verb`);
  if (!/\b(prove|publish|show|know|report|prove)\b/i.test(tagline)) {
    warn("tagline has no concrete verb — compare a funded pitch: 'Prove the pay gap. Reveal no one's salary.'");
  }
}

const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? String(fm.tags).split(",") : [];
if (tags.length < MIN_TAGS) {
  err(`only ${tags.length} tag(s), need >= ${MIN_TAGS} (field median 5, Wave 1 winners 6)`);
}
for (const required of ["Midnight", "Compact", "Zero-Knowledge Proofs"]) {
  if (!tags.some((t) => t.toLowerCase() === required.toLowerCase())) {
    err(`tag "${required}" is missing — without it the project is not discoverable as a Midnight ZK build`);
  }
}

const cats = Array.isArray(fm.categories) ? fm.categories : fm.categories ? [fm.categories] : [];
if (!cats.length) err("frontmatter: at least one category is required");
for (const c of cats) {
  if (!/^[A-Za-z]/.test(c)) warn(`category "${c}" does not look like a platform category`);
}

for (const [field, hint] of [
  ["deliverable_url", "a judge clicking a dead URL is the cheapest way to lose points"],
  ["deck_url", "22 of 159 had one"],
  ["contract_address", "the judges' automated review looks for a documented deployed address"],
]) {
  if (!fm[field]) err(`frontmatter: ${field} is required — ${hint}`);
}

// demo_video is a WARNING, not an error. The evidence for wanting one is real —
// 46 of 159 Wave 1 submissions had one and judges asked for audio commentary — but
// a link to a video that does not exist yet is worse than no link, and a stale one
// is worse still: we shipped Wave 1's video in the Wave 2 draft for a while and it
// looked finished. So this states the case and leaves the call to the author.
if (!fm.demo_video || /^\s*$/.test(String(fm.demo_video))) {
  warn(
    "no demo_video — 46 of 159 Wave 1 submissions had one and judges asked for audio " +
      "commentary. Add it when the recording exists; do not paste a placeholder or a " +
      "previous wave's link.",
  );
} else if (!/^https?:\/\//.test(String(fm.demo_video))) {
  warn(`demo_video "${fm.demo_video}" is not a URL`);
}

if (fm.contract_address && !/^[0-9a-f]{64}$/i.test(String(fm.contract_address))) {
  err(`contract_address "${fm.contract_address}" is not a 64-hex-char Midnight address`);
}

for (const [field, hint] of [
  ["community_name", "all 7 Wave 1 winners had a real community name"],
  ["community_site", "7/7 winners had one; 47/159 submissions had none and Candor was one of them"],
  ["community_x", "social proof is read before the pitch"],
  ["community_discord", "where the seed community actually lives"],
]) {
  if (!fm[field]) err(`frontmatter: ${field} is required — ${hint}`);
}

/* ------------------------------------------------------------------ jargon */

const firstSection = findSection("What it does")?.content ?? "";
const pitchSurface = `${tagline}\n${firstSection.slice(0, 1200)}`;
const pitchJargon = PITCH_JARGON.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(pitchSurface));
if (pitchJargon.length) {
  warn(`jargon in the pitch surface (first 1200 chars of "What it does"): ${pitchJargon.join(", ")}`);
}

/* ------------------------------------------------------------------- report */

const line = "─".repeat(64);
console.log(line);
console.log(`submission check — ${FILE}`);
console.log(line);

if (warnings.length) {
  console.log("\nWARNINGS (do not block):");
  for (const w of warnings) console.log(`  ⚠  ${w}`);
}
if (errors.length) {
  console.log("\nERRORS (submission is not ready):");
  for (const e of errors) console.log(`  ✗  ${e}`);
  console.log(`\n${errors.length} error(s). Fix before submitting.`);
  process.exit(1);
}

const wordCount = (body.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
console.log("\n✓ all checks passed");
console.log(`  sections   ${REQUIRED_SECTIONS.length}/${REQUIRED_SECTIONS.length}`);
console.log(`  tags       ${tags.length}`);
console.log(`  categories ${cats.length}`);
console.log(`  tagline    ${tagline.length} chars`);
console.log(`  body       ${wordCount} words`);
console.log(line);
