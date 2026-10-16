#!/usr/bin/env node
/**
 * Unwrap the submission draft so it pastes into a textarea without breaking
 * mid-sentence.
 *
 * THE PROBLEM. The draft is hard-wrapped at ~95 characters so it reads well in an
 * editor. A textarea does not reflow: it preserves every newline, so pasting the
 * description produced paragraphs that broke mid-clause —
 *
 *   "...must publish gender pay gap statistics under
 *    Directive (EU) 2023/970: mean and median gaps..."
 *
 * which looks like a formatting bug to a judge and is one.
 *
 * So each paragraph becomes a single long line. Blank lines still separate
 * paragraphs, which is what the platform needs to see; nothing else changes.
 *
 * WHAT IT MUST NOT TOUCH:
 *
 *   - the YAML frontmatter, between the leading `---` fences. YAML keys are not
 *     markdown block starts, so a naive "join non-blank lines" pass welds all ten
 *     keys onto one line and the tagline parses as 548 characters. That happened.
 *   - `<!-- ... -->` comments
 *   - tables and blockquotes, where line structure is the content
 *   - list items as separate lines, but each item joined with its own indented
 *     continuation lines
 *
 * Usage:
 *   node scripts/unwrap-submission.mjs [--check]
 *
 * `--check` reports what would change and exits 1, for CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../AKINDO_SUBMISSION_DRAFT.md", import.meta.url));
const check = process.argv.includes("--check");

const isHeading = (s) => /^#{1,6} /.test(s);
const isComment = (s) => s.startsWith("<!--");
const isTableOrQuote = (s) => s.startsWith("|") || s.startsWith("> ");
const isList = (s) => /^(?:[-*]|\d+\.)\s/.test(s);
const isIndented = (s) => /^[ \t]/.test(s);

function unwrap(text) {
  const lines = text.split("\n");
  const out = [];

  let inFrontmatter = false;
  let inComment = false;
  /** Accumulates the paragraph or list item currently being built. */
  let buf = [];

  const flush = () => {
    if (buf.length) {
      out.push(buf.join(" ").replace(/\s+/g, " ").trimEnd());
      buf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // The leading `---` opens and closes the YAML block. Passed through verbatim.
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      flush();
      out.push(line);
      continue;
    }
    if (inFrontmatter) {
      out.push(line);
      if (trimmed === "---") inFrontmatter = false;
      continue;
    }

    // A comment runs to its closing `-->`, possibly over several lines.
    if (inComment) {
      out.push(line);
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (isComment(trimmed)) {
      flush();
      if (!trimmed.includes("-->")) inComment = true;
      out.push(line);
      continue;
    }

    if (trimmed === "") {
      flush();
      out.push("");
      continue;
    }

    if (isHeading(trimmed) || isTableOrQuote(trimmed)) {
      flush();
      out.push(line.trimEnd());
      continue;
    }

    // A list item starts its own line; its indented continuations join it.
    if (isList(trimmed)) {
      flush();
      buf.push(trimmed);
      continue;
    }

    // An indented line inside a list item belongs to that item. An unindented
    // line continues whatever block is open.
    if (buf.length && isIndented(line)) {
      buf.push(trimmed);
      continue;
    }

    buf.push(trimmed);
  }

  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

const original = readFileSync(FILE, "utf8");
const unwrapped = unwrap(original);

if (unwrapped === original) {
  console.log("  ok  already unwrapped — every paragraph is a single line");
  process.exit(0);
}

// Report the paragraphs that would change, so a failure is diagnosable.
const before = original.split("\n");
const after = unwrapped.split("\n");
const collapses = before.length - after.length;

if (check) {
  console.error(`  ✗ ${collapses} line break(s) inside paragraphs would be removed`);
  console.error("    run: node scripts/unwrap-submission.mjs");
  console.error(
    "\n    A textarea preserves newlines, so these break a sentence mid-clause\n" +
      "    when pasted into the submission form.",
  );
  process.exit(1);
}

writeFileSync(FILE, unwrapped);
console.log(`  ok  unwrapped — ${collapses} line break(s) removed inside paragraphs`);
