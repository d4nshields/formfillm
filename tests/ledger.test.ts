import { describe, expect, it } from "vitest";
import { buildLedgerEntry, redactLedgerEntry } from "../src/shared/ledger.js";

describe("buildLedgerEntry", () => {
  it("always sets valueStored false and carries no value", () => {
    const e = buildLedgerEntry({
      timestamp: 1000,
      siteOrigin: "https://example.com",
      pageTitle: "Sign up",
      fieldLabel: "Email",
      category: "contact.email",
      sensitivity: "medium",
      decision: "approved",
      filled: true,
    });
    expect(e.valueStored).toBe(false);
    expect(e.filled).toBe(true);
    expect(Object.keys(e)).not.toContain("value");
  });
});

describe("redactLedgerEntry", () => {
  it("strips any stray value-bearing keys", () => {
    const dirty = {
      timestamp: 1,
      siteOrigin: "https://x.test",
      pageTitle: null,
      fieldLabel: "SSN",
      category: "government_id",
      sensitivity: "high",
      decision: "never_fill",
      valueStored: true, // pretend a bug set this
      filled: false,
      value: "123-45-6789", // must be dropped
      secretValue: "leak", // must be dropped
    };
    const clean = redactLedgerEntry(dirty as unknown as Record<string, unknown>);
    const asRecord = clean as unknown as Record<string, unknown>;
    expect(clean.valueStored).toBe(false);
    expect(asRecord.value).toBeUndefined();
    expect(asRecord.secretValue).toBeUndefined();
    expect(clean.fieldLabel).toBe("SSN");
    expect(clean.category).toBe("government_id");
    // Only the allowed keys survive.
    expect(Object.keys(clean).sort()).toEqual(
      ["category", "decision", "fieldLabel", "filled", "pageTitle", "sensitivity", "siteOrigin", "timestamp", "valueStored"].sort(),
    );
  });
});
