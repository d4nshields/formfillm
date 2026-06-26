import { describe, expect, it } from "vitest";
import {
  DEFAULT_PASSWORD_POLICY,
  generatePassword,
  mergePolicyExtraction,
  normalizePolicy,
  policyFromAttributes,
  SYMBOLS,
  validatePassword,
  type PasswordPolicy,
} from "../src/shared/password.js";

const hasSymbol = (s: string) => [...SYMBOLS].some((c) => s.includes(c));

describe("generatePassword", () => {
  it("respects length bounds and required classes (OLG-style policy)", () => {
    const policy: PasswordPolicy = {
      minLength: 8,
      maxLength: 50,
      requireLower: true,
      requireUpper: true,
      requireDigit: true,
      requireSymbol: false,
      symbolsAllowed: true,
      forbidSpaces: true,
    };
    for (let i = 0; i < 50; i++) {
      const { password } = generatePassword(policy);
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(50);
      expect(/[a-z]/.test(password)).toBe(true);
      expect(/[A-Z]/.test(password)).toBe(true);
      expect(/[0-9]/.test(password)).toBe(true);
      expect(/\s/.test(password)).toBe(false);
      expect(validatePassword(password, policy)).toBe(true);
    }
  });

  it("excludes avoid substrings (email / name) case-insensitively", () => {
    const policy = { ...DEFAULT_PASSWORD_POLICY };
    for (let i = 0; i < 50; i++) {
      const { password } = generatePassword(policy, ["d4nshields@gmail.com", "Daniel"]);
      const lower = password.toLowerCase();
      expect(lower.includes("d4nshields")).toBe(false);
      expect(lower.includes("daniel")).toBe(false);
    }
  });

  it("omits symbols when symbols are not allowed", () => {
    const policy: PasswordPolicy = {
      ...DEFAULT_PASSWORD_POLICY,
      requireSymbol: false,
      symbolsAllowed: false,
    };
    for (let i = 0; i < 30; i++) {
      const { password } = generatePassword(policy);
      expect(hasSymbol(password)).toBe(false);
    }
  });

  it("includes a symbol when one is required", () => {
    const policy: PasswordPolicy = {
      ...DEFAULT_PASSWORD_POLICY,
      requireSymbol: true,
      symbolsAllowed: true,
    };
    for (let i = 0; i < 30; i++) {
      const { password } = generatePassword(policy);
      expect(hasSymbol(password)).toBe(true);
    }
  });

  it("handles a tight max length while still meeting classes", () => {
    const policy: PasswordPolicy = {
      minLength: 8,
      maxLength: 8,
      requireLower: true,
      requireUpper: true,
      requireDigit: true,
      requireSymbol: false,
      symbolsAllowed: false,
      forbidSpaces: true,
    };
    const { password } = generatePassword(policy);
    expect(password.length).toBe(8);
    expect(validatePassword(password, policy)).toBe(true);
  });

  it("satisfies an HTML pattern when provided", () => {
    const policy: PasswordPolicy = {
      ...DEFAULT_PASSWORD_POLICY,
      minLength: 10,
      maxLength: 20,
      pattern: "(?=.*[A-Z])(?=.*[0-9]).{10,20}",
    };
    const { password } = generatePassword(policy);
    expect(new RegExp(`^(?:${policy.pattern})$`).test(password)).toBe(true);
  });

  it("produces different passwords each call (entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(generatePassword(DEFAULT_PASSWORD_POLICY).password);
    expect(seen.size).toBeGreaterThan(15);
  });
});

describe("normalizePolicy", () => {
  it("raises minLength to fit required classes and clamps max", () => {
    const p = normalizePolicy({
      minLength: 2,
      maxLength: 1,
      requireLower: true,
      requireUpper: true,
      requireDigit: true,
      requireSymbol: true,
      symbolsAllowed: true,
      forbidSpaces: true,
    });
    expect(p.minLength).toBeGreaterThanOrEqual(4);
    expect(p.maxLength).toBeGreaterThanOrEqual(p.minLength);
  });

  it("disables requireSymbol when symbols are not allowed", () => {
    const p = normalizePolicy({
      ...DEFAULT_PASSWORD_POLICY,
      requireSymbol: true,
      symbolsAllowed: false,
    });
    expect(p.requireSymbol).toBe(false);
  });
});

describe("policyFromAttributes", () => {
  it("uses input min/max and falls back to defaults", () => {
    const p = policyFromAttributes({ minLength: 8, maxLength: 50, pattern: null });
    expect(p.minLength).toBe(8);
    expect(p.maxLength).toBe(50);
    const d = policyFromAttributes({ minLength: null, maxLength: null, pattern: null });
    expect(d.minLength).toBe(DEFAULT_PASSWORD_POLICY.minLength);
  });
});

describe("mergePolicyExtraction", () => {
  const base = policyFromAttributes({ minLength: 8, maxLength: 50, pattern: null });

  it("merges model-extracted class requirements", () => {
    const merged = mergePolicyExtraction(base, {
      requireLower: true,
      requireUpper: true,
      requireDigit: true,
      requireSymbol: false,
      symbolsAllowed: true,
    });
    expect(merged.requireUpper).toBe(true);
    expect(merged.requireDigit).toBe(true);
  });

  it("tightens bounds rather than loosening them", () => {
    const merged = mergePolicyExtraction(base, { minLength: 12, maxLength: 100 });
    expect(merged.minLength).toBe(12); // stricter min wins
    expect(merged.maxLength).toBe(50); // attribute max (stricter) wins over text
  });

  it("falls back to base on garbage", () => {
    expect(mergePolicyExtraction(base, null)).toEqual(base);
    expect(mergePolicyExtraction(base, "nope")).toEqual(base);
  });
});
