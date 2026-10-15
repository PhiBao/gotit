/**
 * Pure session helpers — safe to import statically (no wasm, no network).
 * Wallet detection follows the official midnight example: scan window.midnight
 * for any connector with a compatible apiVersion.
 */
const COMPATIBLE_MAJOR = "4";
const ADDR_KEY = "gotit:contractAddress";
// v2 gets its own key so deploying it never repoints the v1 report. Empty until
// an operator deploys v2 or sets VITE_CONTRACT_ADDRESS_V2 at build time.
const V2_ADDR_KEY = "gotit:contractV2";
const ISSUER_KEY_KEY = "gotit:issuerKey";
// Renamed from "candor:*" in Wave 2. Read the old keys as a fallback so a
// returning visitor keeps their stored contract address and issuer key instead
// of silently losing them. Old keys are left in place (never deleted) so a
// rollback to Wave 1 still finds them.
const LEGACY_PREFIX = "candor:";
// Baked at build time (fly deploy build arg) so visitors land on the deployed contract
const BAKED_ADDRESS: string = (import.meta as any).env?.VITE_CONTRACT_ADDRESS ?? "";
const BAKED_V2_ADDRESS: string = (import.meta as any).env?.VITE_CONTRACT_ADDRESS_V2 ?? "";
const BAKED_ISSUER_KEY: string = (import.meta as any).env?.VITE_ISSUER_KEY ?? "";

export function isLaceAvailable(): boolean {
  try {
    const midnight = (window as any).midnight as Record<string, any> | undefined;
    if (!midnight || typeof midnight !== "object") return false;
    return Object.values(midnight).some(
      (wallet) =>
        !!wallet &&
        typeof wallet === "object" &&
        "apiVersion" in wallet &&
        typeof wallet.apiVersion === "string" &&
        wallet.apiVersion.split(".")[0] === COMPATIBLE_MAJOR,
    );
  } catch { return false; }
}

/** Read a key, transparently falling back to its pre-rename `candor:` form. */
/**
 * A stored contract address, or null.
 *
 * Validated rather than trusted, because a bad value got stored once and then
 * read back as a real address. `deployV2` returned `undefined`, the UI did
 * `setStoredV2ContractAddress(undefined)`, and the report page then tried to
 * decode the V1 contract as a V2 ledger — surfacing as "index out of bounds in
 * idx: 5 >= 5", which blames the chain for a value the app wrote itself.
 *
 * The deploy path now refuses to store a malformed address, and this is the
 * second line of defence: a value already in someone's localStorage from before
 * that fix must not be treated as a contract.
 */
function readValidatedAddress(key: string): string | null {
  const raw = readStorage(key);
  if (raw === null) return null;
  const clean = raw.replace(/^0x/, "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return clean;
  // Present but unusable. Log it once so the cause is visible rather than
  // silently ignored, and treat the deployment as unconfigured.
  console.warn(`[gotit] ignoring stored address for ${key}: not a contract address (${JSON.stringify(raw)})`);
  return null;
}

function readStorage(key: string): string | null {
  try {
    const now = localStorage.getItem(key);
    if (now !== null) return now;
    if (key.startsWith("gotit:")) return localStorage.getItem(LEGACY_PREFIX + key.slice("gotit:".length));
    return null;
  } catch { return null; }
}
function safeSessionGet(key: string): string | null {
  try {
    const now = sessionStorage.getItem(key);
    if (now !== null) return now;
    if (key.startsWith("gotit:")) return sessionStorage.getItem(LEGACY_PREFIX + key.slice("gotit:".length));
    return null;
  } catch { return null; }
}
function safeSessionSet(key: string, val: string) {
  try { sessionStorage.setItem(key, val); } catch {}
}

export function getStoredContractAddress(): string | null {
  return readValidatedAddress(ADDR_KEY) ?? validateBaked(BAKED_ADDRESS, "VITE_CONTRACT_ADDRESS");
}

/** Baked addresses come from the build, so a malformed one is a build error. */
function validateBaked(value: string, name: string): string | null {
  if (!value) return null;
  const clean = value.replace(/^0x/, "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return clean;
  console.warn(`[gotit] ${name} is not a contract address; ignoring (${JSON.stringify(value)})`);
  return null;
}

export function setStoredContractAddress(address: string): void {
  // Guard the write as well as the read: storing "undefined" is how a missing
  // address turned into a contract that does not exist.
  if (!/^[0-9a-fA-F]{64}$/.test(String(address).replace(/^0x/, ""))) {
    console.warn(`[gotit] refusing to store a malformed contract address (${JSON.stringify(address)})`);
    return;
  }
  try { localStorage.setItem(ADDR_KEY, String(address).replace(/^0x/, "")); } catch {}
}

/**
 * The v2 (Wave 2) contract address, or null if v2 has not been deployed here.
 *
 * Deliberately a separate key from v1's. Pointing the report at v2 is an
 * explicit operator action, so a v2 deploy can never silently repoint the live
 * report at a ledger that happens to be empty.
 */
/**
 * A contract address carried in the URL.
 *
 * localStorage does not travel, so a report is invisible to a second browser —
 * the reader sees "no contract configured" while the data sits on chain, which
 * looks like the app is broken rather than like a missing setting. A shared link
 * carries the address, so "look at this report" is one URL:
 *
 *   https://…/#report&contract=0x1a2b…
 *
 * Validated like every other address, so a malformed parameter is ignored rather
 * than becoming a contract that does not exist.
 */
export function getUrlContractAddress(): string | null {
  try {
    const hash = location.hash.replace(/^#/, "");
    const search = location.search.replace(/^\?/, "");
    const params = new URLSearchParams([hash.replace(/&/g, "&"), search].filter(Boolean).join("&"));
    const raw = params.get("contract") ?? params.get("address");
    if (!raw) return null;
    const clean = raw.replace(/^0x/, "").trim();
    return /^[0-9a-fA-F]{64}$/.test(clean) ? clean : null;
  } catch {
    return null;
  }
}

export function getStoredV2ContractAddress(): string | null {
  // Precedence: a link someone was given beats this browser's own memory,
  // otherwise opening a shared report would show a different contract.
  return (
    getUrlContractAddress() ??
    readValidatedAddress(V2_ADDR_KEY) ??
    validateBaked(BAKED_V2_ADDRESS, "VITE_CONTRACT_ADDRESS_V2")
  );
}

/** The current page's URL with a contract address attached, for sharing. */
export function shareableReportUrl(address: string): string {
  try {
    const base = `${location.origin}${location.pathname}#report&contract=${address.replace(/^0x/, "")}`;
    return base;
  } catch {
    return address;
  }
}

export function setStoredV2ContractAddress(address: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(String(address).replace(/^0x/, ""))) {
    console.warn(`[gotit] refusing to store a malformed v2 address (${JSON.stringify(address)})`);
    return;
  }
  try { localStorage.setItem(V2_ADDR_KEY, String(address).replace(/^0x/, "")); } catch {}
}


export function getBakedIssuerKey(): string | null {
  const fromEnv = BAKED_ISSUER_KEY.replace(/^0x/, "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(fromEnv)) return fromEnv.toLowerCase();
  return null;
}

export function getStoredIssuerKey(): string | null {
  const v = readStorage(ISSUER_KEY_KEY);
  if (v && /^[0-9a-fA-F]{64}$/.test(v.replace(/^0x/, "").trim())) return v.replace(/^0x/, "").trim().toLowerCase();
  return getBakedIssuerKey();
}

export function getEffectiveIssuerKey(): string | null {
  // localStorage wins over baked, so operator can rotate without redeploy
  return getStoredIssuerKey();
}
