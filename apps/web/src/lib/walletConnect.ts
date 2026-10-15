/**
 * Connecting to a Midnight wallet, with states a person can follow.
 *
 * THE PROBLEM THIS SOLVES. `connectToWallet` called `initialAPI.connect(networkId)`
 * and awaited it. When Lace is locked, that promise does not reject and does not
 * resolve — the extension has a popup to show that it cannot show until someone
 * unlocks it. So the button appeared to do nothing, forever, with no message. The
 * only way to learn what was happening was to open the wallet manually, at which
 * point the flow completed as though nothing had been wrong.
 *
 * A promise that never settles cannot be handled by waiting longer. It needs to be
 * raced against a clock and narrated while it is pending, because the honest
 * message during a three-second pause ("waiting for your wallet") is different
 * from the message during a thirty-second one ("Lace is probably locked").
 *
 * So this module:
 *   - races the wallet against a timeout instead of awaiting it blind
 *   - emits a phase on a schedule, so the UI can escalate its guidance
 *   - distinguishes "no wallet installed" from "wallet installed but not
 *     responding", because those need different actions
 *   - never swallows a rejection: a refusal from the user is a real answer
 */

export type ConnectionPhase =
  /** Looking for an injected connector. */
  | { kind: "detecting"; detail: string }
  /** Nothing injected. The extension is missing or disabled. */
  | { kind: "no-wallet"; detail: string }
  /** connect() has been called and the wallet has not answered yet. */
  | { kind: "requesting"; detail: string; waitedMs: number }
  /**
   * Long enough that something is probably blocking the wallet — most often a
   * locked extension, which cannot show its approval popup.
   */
  | { kind: "needs-attention"; detail: string; waitedMs: number }
  | { kind: "connected"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "error"; detail: string; hint?: string };

/** After this long, say the wallet probably needs unlocking. */
export const ATTENTION_AFTER_MS = 6_000;

/** After this long, give up and hand control back with instructions. */
export const GIVE_UP_AFTER_MS = 90_000;

export type Connector = {
  apiVersion?: string;
  connect?: (networkId: string) => Promise<unknown>;
  enable?: () => Promise<unknown>;
};

/** Scan `window.midnight` for anything with a plausible connector shape. */
export function findConnectors(midnight: unknown): Array<[string, Connector]> {
  if (!midnight || typeof midnight !== "object") return [];
  return Object.entries(midnight as Record<string, unknown>).filter(([, v]) => {
    if (!v || typeof v !== "object") return false;
    const c = v as Connector;
    return typeof c.connect === "function" || typeof c.enable === "function";
  }) as Array<[string, Connector]>;
}

/** Is the extension present at all? Distinguishes "not installed" from "not answering". */
export function hasAnyConnector(midnight: unknown): boolean {
  return findConnectors(midnight).length > 0;
}

export type ConnectOptions = {
  networkId: string;
  /** Called on every phase change, including the timed escalations. */
  onPhase?: (p: ConnectionPhase) => void;
  /** How often to re-report while waiting. */
  tickMs?: number;
  /** Injectable clock, so the escalation is testable without waiting. */
  now?: () => number;
  /** Overrides for the escalation deadlines. */
  attentionAfterMs?: number;
  giveUpAfterMs?: number;
};

/**
 * Connect, narrating the wait.
 *
 * Throws only on a genuine refusal or a timeout; every intermediate state goes to
 * `onPhase`, so the caller renders progress rather than a spinner of unknown
 * duration.
 */
export async function connectWithProgress(opts: ConnectOptions): Promise<unknown> {
  const {
    networkId,
    onPhase,
    tickMs = 700,
    now = () => Date.now(),
    attentionAfterMs = ATTENTION_AFTER_MS,
    giveUpAfterMs = GIVE_UP_AFTER_MS,
  } = opts;

  const say = (p: ConnectionPhase) => {
    try {
      onPhase?.(p);
    } catch {
      /* a UI callback must never break the connection */
    }
  };

  say({ kind: "detecting", detail: "Looking for a Midnight wallet…" });

  const connectors = findConnectors((globalThis as any).window?.midnight ?? (globalThis as any).midnight);
  if (connectors.length === 0) {
    const phase: ConnectionPhase = {
      kind: "no-wallet",
      detail: "No Midnight wallet was found in this browser.",
    };
    say(phase);
    throw new ConnectError(phase);
  }

  const [walletId, connector] = connectors[0];
  say({ kind: "detecting", detail: `Found ${walletId.slice(0, 8)}… — asking it to connect.` });

  const started = now();

  // The wallet call, raced against a clock. A locked extension does not settle,
  // so waiting is not a strategy.
  const call = (async () => {
    if (typeof connector.connect === "function") {
      return await connector.connect(networkId);
    }
    if (typeof connector.enable === "function") {
      const enabled = await connector.enable();
      const e = enabled as Connector;
      if (typeof e?.connect === "function") return await e.connect(networkId);
      return enabled;
    }
    throw new ConnectError({ kind: "error", detail: "The wallet exposes neither connect() nor enable()." });
  })();

  // Narrate while pending. `settled` guards the ticks after the race resolves.
  let settled = false;
  const narrator = setInterval(() => {
    if (settled) return;
    const waited = now() - started;
    if (waited >= attentionAfterMs) {
      say({
        kind: "needs-attention",
        waitedMs: waited,
        detail:
          "The wallet has not answered. Click the Lace icon in your browser toolbar — not the " +
          "side panel — and approve the connection there. If Lace asks for your password, " +
          "unlock it first. The request stays pending until you do.",
      });
    } else {
      say({
        kind: "requesting",
        waitedMs: waited,
        detail: "Waiting for your wallet to respond…",
      });
    }
  }, tickMs);

  try {
    const result = await Promise.race([
      call,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(
            new ConnectError({
              kind: "error",
              detail: `The wallet did not respond within ${Math.round(giveUpAfterMs / 1000)} seconds.`,
              hint:
                "Click the Lace icon in your browser toolbar (the side panel does not always show " +
                "connection requests), unlock it if it asks, then press Connect again. The request " +
                "is still pending there.",
            }),
          );
        }, giveUpAfterMs),
      ),
    ]);
    settled = true;
    say({ kind: "connected", detail: "Wallet connected." });
    return result;
  } catch (e) {
    settled = true;
    if (e instanceof ConnectError) {
      say(e.phase);
      throw e;
    }
    // A rejection from the user is an answer, not a failure to explain away.
    const message = e instanceof Error ? e.message : String(e);
    const rejected = /reject|denied|declin|cancel/i.test(message);
    const phase: ConnectionPhase = rejected
      ? { kind: "rejected", detail: "The connection request was declined in the wallet." }
      : {
          kind: "error",
          detail: message || "The wallet could not connect.",
          hint: "Open the Lace extension and check it is unlocked and set to the right network.",
        };
    say(phase);
    throw new ConnectError(phase);
  } finally {
    settled = true;
    clearInterval(narrator);
  }
}

/** Carries the phase so a caller can render exactly what went wrong. */
export class ConnectError extends Error {
  readonly phase: ConnectionPhase;
  constructor(phase: ConnectionPhase) {
    super(phase.kind === "error" ? phase.detail : phase.detail);
    this.name = "ConnectError";
    this.phase = phase;
  }
}

/** Short label for a phase, for a button or a badge. */
export function phaseLabel(p: ConnectionPhase): string {
  switch (p.kind) {
    case "detecting":
      return "Looking for a wallet…";
    case "no-wallet":
      return "No wallet found";
    case "requesting":
      return "Waiting for your wallet…";
    case "needs-attention":
      return "Check your wallet";
    case "connected":
      return "Connected";
    case "rejected":
      return "Connection declined";
    case "error":
      return "Connection failed";
  }
}

/** Whether the phase means the user has to go do something in the extension. */
export function needsUserAction(p: ConnectionPhase): boolean {
  return p.kind === "needs-attention" || p.kind === "no-wallet" || p.kind === "error" || p.kind === "rejected";
}
