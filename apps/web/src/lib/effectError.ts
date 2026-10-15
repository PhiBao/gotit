/**
 * Unwrap Effect failures into something a human can act on.
 *
 * Every midnight-js chain operation runs through Effect. When one fails, the
 * rejection the browser sees is a `FiberFailure` whose `message` is the empty
 * string and whose real content sits in a nested `Cause` tree:
 *
 *   Error { _id: 'FiberFailure', message: '', cause: { _tag: 'Fail', failure: … } }
 *
 * So `e.message` — which is what every catch block in this app used to log —
 * gives you nothing at all. That is why a deploy failure shows as
 * "v2 deploy failed" with no reason.
 *
 * The Cause tree's shape:
 *
 *   Fail          `failure` holds the error value the effect raised
 *   Die           `defect` holds a thrown exception (the unexpected kind)
 *   Interrupt     the fiber was cancelled
 *   Sequential    `left` and `right`, both Causes — two failures in order
 *   Parallel      `left` and `right` — two failures racing
 *   Empty         no failure (should not be reached from a rejection)
 *
 * This walks the whole tree and renders every leaf, innermost detail included,
 * because the useful part of these errors (which file, which circuit, which
 * HTTP status) is two or three levels down.
 */

/** One extracted failure leaf. */
export type UnwrappedFailure = {
  kind: "fail" | "die" | "interrupt" | "unknown";
  /** Best available human-readable message. */
  message: string;
  /** Structured detail, when the error carried any. */
  detail?: unknown;
};

/** Is this an Effect FiberFailure / Cause rather than an ordinary Error? */
export function isEffectFailure(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return o._id === "FiberFailure" || (o._tag !== undefined && isCauseTag(o._tag));
}

function isCauseTag(tag: unknown): boolean {
  return (
    tag === "Fail" ||
    tag === "Die" ||
    tag === "Interrupt" ||
    tag === "Sequential" ||
    tag === "Parallel" ||
    tag === "Empty"
  );
}

/** Pull a message out of whatever shape the error value has. */
function messageOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // midnight-js error classes usually carry `message`, and their causes often
    // carry the HTTP or proof-server detail.
    const own =
      (typeof o.message === "string" && o.message) ||
      (typeof o._tag === "string" && o._tag) ||
      "";
    const cause = o.cause ? ` ← ${messageOf(o.cause)}` : "";
    return `${own}${cause}`.trim();
  }
  return String(value);
}

/** Walk a Cause tree, collecting every leaf failure. */
function walk(cause: unknown, out: UnwrappedFailure[], depth = 0): void {
  if (!cause || typeof cause !== "object" || depth > 12) return;
  const c = cause as Record<string, any>;
  switch (c._tag) {
    case "Fail":
      out.push({ kind: "fail", message: messageOf(c.failure) || "(no message)", detail: c.failure });
      break;
    case "Die":
      out.push({ kind: "die", message: messageOf(c.defect) || "(no message)", detail: c.defect });
      break;
    case "Interrupt":
      out.push({ kind: "interrupt", message: "operation was interrupted", detail: c.fiberId });
      break;
    case "Sequential":
    case "Parallel":
      walk(c.left, out, depth + 1);
      walk(c.right, out, depth + 1);
      break;
    case "Empty":
      out.push({ kind: "unknown", message: "empty cause — no failure recorded" });
      break;
    default:
      break;
  }
}

/** Extract every failure from a thrown value, in tree order. */
export function unwrapFailures(e: unknown): UnwrappedFailure[] {
  if (!e) return [];
  const o = e as Record<string, any>;

  // A FiberFailure wraps a Cause.
  if (o._id === "FiberFailure") {
    const out: UnwrappedFailure[] = [];
    walk(o.cause, out);
    if (out.length > 0) return out;
    // Some builds put the failure directly on the error.
    return [{ kind: "fail", message: messageOf(o.cause) || "(FiberFailure with no cause)", detail: o.cause }];
  }

  // A bare Cause.
  if (isCauseTag(o._tag)) {
    const out: UnwrappedFailure[] = [];
    walk(o, out);
    return out.length > 0 ? out : [{ kind: "unknown", message: messageOf(o) }];
  }

  // An ordinary error.
  return [{ kind: "fail", message: messageOf(e) || "(no message)", detail: e }];
}

/**
 * One-line summary for a toast or a log line.
 *
 * Prefers a `fail` over a `die`: a raised error usually explains itself, while a
 * defect is often an internal assertion whose message is less useful.
 */
export function describeFailure(e: unknown): string {
  const failures = unwrapFailures(e);
  if (failures.length === 0) return "unknown error";
  const fail = failures.find((f) => f.kind === "fail") ?? failures[0];
  const extra = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
  return `${fail.message}${extra}`;
}

/**
 * Full report for the console, including structured detail.
 *
 * Printed next to the raw object so nothing is lost when the message is
 * uninformative and the detail is the only clue.
 */
export function failureReport(e: unknown): string {
  const failures = unwrapFailures(e);
  if (failures.length === 0) return "no failure information";
  return failures
    .map((f, i) => {
      let detail = "";
      try {
        detail = f.detail === undefined ? "" : `\n    detail: ${JSON.stringify(f.detail, replacer, 2).slice(0, 1200)}`;
      } catch {
        detail = "\n    detail: (unserialisable)";
      }
      return `[${i + 1}] ${f.kind}: ${f.message}${detail}`;
    })
    .join("\n");
}

/** Effects carry bigint and Error values that JSON.stringify refuses. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 4).join("\n") };
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  return value;
}

/**
 * Stringify a value that may contain bigints, Errors or typed arrays.
 *
 * Used to keep a copyable version of a chain failure on screen. Ordinary
 * `JSON.stringify` throws on a bigint, which would turn a diagnostic panel into
 * a second error.
 */
export function safeStringify(value: unknown, maxLen = 4000): string {
  try {
    const s = JSON.stringify(value, replacer, 2);
    return s.length > maxLen ? `${s.slice(0, maxLen)}\n… (truncated)` : s;
  } catch (e) {
    try {
      return String(value);
    } catch {
      return `(unserialisable: ${messageOf(e)})`;
    }
  }
}
