/*
 * formfillm — secure password generation
 *
 * Generates a strong password that satisfies a site's stated policy, using the
 * Web Crypto CSPRNG only (never Math.random) with unbiased index selection.
 * Pure and dependency-free so it is fully unit-testable. The generated password
 * is never stored by formfillm — the side panel shows it, fills it, and relies
 * on the user's password manager (save-on-submit) to persist it.
 */

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/** Conservative symbol set avoided of quotes/backslash/space for broad acceptance. */
export const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?";

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireLower: boolean;
  requireUpper: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  /** Whether symbols are permitted at all (some sites forbid them). */
  symbolsAllowed: boolean;
  forbidSpaces: boolean;
  /** Optional HTML pattern attribute (full-match regex). */
  pattern?: string | null;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  maxLength: 64,
  requireLower: true,
  requireUpper: true,
  requireDigit: true,
  requireSymbol: false,
  symbolsAllowed: true,
  forbidSpaces: true,
  pattern: null,
};

/** Preferred length when the policy doesn't force something larger. */
const PREFERRED_LENGTH = 20;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Unbiased random integer in [0, max) using the Web Crypto CSPRNG. */
function randomInt(max: number): number {
  if (max <= 1) return 0;
  // Reject the top of the uint32 range that would bias the modulo.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  let x = 0;
  do {
    crypto.getRandomValues(buf);
    x = buf[0]!;
  } while (x >= limit);
  return x % max;
}

function pick(chars: string): string {
  return chars[randomInt(chars.length)]!;
}

/** In-place Fisher–Yates shuffle using the CSPRNG. */
function shuffle(arr: string[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

/** Normalise a policy: sane bounds and enough length for required classes. */
export function normalizePolicy(input: PasswordPolicy): PasswordPolicy {
  const p = { ...input };
  p.minLength = Number.isFinite(p.minLength) ? Math.max(1, Math.floor(p.minLength)) : 12;
  p.maxLength = Number.isFinite(p.maxLength) ? Math.max(p.minLength, Math.floor(p.maxLength)) : 64;
  if (!p.symbolsAllowed) p.requireSymbol = false;
  const requiredCount =
    (p.requireLower ? 1 : 0) +
    (p.requireUpper ? 1 : 0) +
    (p.requireDigit ? 1 : 0) +
    (p.requireSymbol ? 1 : 0);
  if (p.minLength < requiredCount) p.minLength = requiredCount;
  if (p.maxLength < p.minLength) p.maxLength = p.minLength;
  return p;
}

function safePatternTest(pattern: string, value: string): boolean {
  if (pattern.length > 300) return true; // avoid pathological regex; skip the check
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return true; // invalid site pattern — don't block generation on it
  }
}

export function validatePassword(pw: string, policy: PasswordPolicy): boolean {
  const p = normalizePolicy(policy);
  if (pw.length < p.minLength || pw.length > p.maxLength) return false;
  if (p.requireLower && !/[a-z]/.test(pw)) return false;
  if (p.requireUpper && !/[A-Z]/.test(pw)) return false;
  if (p.requireDigit && !/[0-9]/.test(pw)) return false;
  if (p.requireSymbol && ![...SYMBOLS].some((s) => pw.includes(s))) return false;
  if (!p.symbolsAllowed && [...SYMBOLS].some((s) => pw.includes(s))) return false;
  if (p.forbidSpaces && /\s/.test(pw)) return false;
  if (p.pattern && !safePatternTest(p.pattern, pw)) return false;
  return true;
}

export interface GenerateResult {
  password: string;
  warnings: string[];
}

/**
 * Generate a password satisfying `policy`, avoiding any of the `avoid`
 * substrings (e.g. the user's email/name) case-insensitively.
 */
export function generatePassword(policy: PasswordPolicy, avoid: string[] = []): GenerateResult {
  const warnings: string[] = [];
  const p = normalizePolicy(policy);
  const avoidLower = avoid
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length >= 3);

  let pool = LOWER + UPPER + DIGITS;
  if (p.symbolsAllowed) pool += SYMBOLS;

  const target = clamp(Math.max(p.minLength, PREFERRED_LENGTH), p.minLength, p.maxLength);

  const buildOnce = (): string => {
    const chars: string[] = [];
    if (p.requireLower) chars.push(pick(LOWER));
    if (p.requireUpper) chars.push(pick(UPPER));
    if (p.requireDigit) chars.push(pick(DIGITS));
    if (p.requireSymbol) chars.push(pick(SYMBOLS));
    while (chars.length < target) chars.push(pick(pool));
    shuffle(chars);
    return chars.join("");
  };

  let last = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const pw = buildOnce();
    last = pw;
    const lower = pw.toLowerCase();
    if (avoidLower.some((a) => lower.includes(a))) continue;
    if (validatePassword(pw, p)) return { password: pw, warnings };
  }

  warnings.push(
    "Could not fully satisfy every rule after many attempts; using the closest valid password. Please double-check against the site's requirements.",
  );
  return { password: last, warnings };
}

// ---------------------------------------------------------------------------
// Policy derivation from page context + LLM extraction.
// ---------------------------------------------------------------------------

export interface PasswordContextInput {
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
}

/** Baseline policy from the input element's own constraints. */
export function policyFromAttributes(ctx: PasswordContextInput): PasswordPolicy {
  return normalizePolicy({
    ...DEFAULT_PASSWORD_POLICY,
    minLength: ctx.minLength ?? DEFAULT_PASSWORD_POLICY.minLength,
    maxLength: ctx.maxLength ?? DEFAULT_PASSWORD_POLICY.maxLength,
    pattern: ctx.pattern ?? null,
  });
}

/** JSON schema we ask the local model to fill from the policy text. */
export const PASSWORD_POLICY_SCHEMA = {
  type: "object",
  properties: {
    minLength: { type: ["number", "null"] },
    maxLength: { type: ["number", "null"] },
    requireLower: { type: "boolean" },
    requireUpper: { type: "boolean" },
    requireDigit: { type: "boolean" },
    requireSymbol: { type: "boolean" },
    symbolsAllowed: { type: "boolean" },
    forbidSpaces: { type: "boolean" },
  },
  required: ["requireLower", "requireUpper", "requireDigit", "requireSymbol", "symbolsAllowed"],
} as const;

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asNumOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Merge a (already JSON-parsed) model extraction over the attribute baseline.
 * Never throws; unknown/garbage fields fall back to the baseline.
 */
export function mergePolicyExtraction(base: PasswordPolicy, raw: unknown): PasswordPolicy {
  if (typeof raw !== "object" || raw === null) return base;
  const o = raw as Record<string, unknown>;
  const minFromText = asNumOrNull(o.minLength);
  const maxFromText = asNumOrNull(o.maxLength);
  return normalizePolicy({
    // Prefer the stricter explicit attribute bounds; otherwise take text bounds.
    minLength: minFromText !== null ? Math.max(base.minLength, minFromText) : base.minLength,
    maxLength: maxFromText !== null ? Math.min(base.maxLength, maxFromText) : base.maxLength,
    requireLower: asBool(o.requireLower, base.requireLower),
    requireUpper: asBool(o.requireUpper, base.requireUpper),
    requireDigit: asBool(o.requireDigit, base.requireDigit),
    requireSymbol: asBool(o.requireSymbol, base.requireSymbol),
    symbolsAllowed: asBool(o.symbolsAllowed, base.symbolsAllowed),
    forbidSpaces: asBool(o.forbidSpaces, base.forbidSpaces),
    pattern: base.pattern ?? null,
  });
}
