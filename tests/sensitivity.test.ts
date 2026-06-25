import { describe, expect, it } from "vitest";
import {
  categorySensitivity,
  defaultActionForSensitivity,
  isFillable,
  isLowSensitivityBatchable,
  reconcileClassification,
} from "../src/shared/sensitivity.js";
import type { FieldClassification } from "../src/shared/types.js";

function base(overrides: Partial<FieldClassification>): FieldClassification {
  return {
    fieldId: "ff-0",
    category: "unknown",
    sensitivity: "unknown",
    confidence: 0.5,
    plainLanguageReason: "x",
    possiblePurpose: "y",
    recommendedAction: "manual_review",
    profileKeySuggestion: null,
    warnings: [],
    ...overrides,
  };
}

describe("categorySensitivity", () => {
  it("maps known categories", () => {
    expect(categorySensitivity("locale.language")).toBe("low");
    expect(categorySensitivity("contact.email")).toBe("medium");
    expect(categorySensitivity("government_id")).toBe("high");
    expect(categorySensitivity("password")).toBe("secret");
    expect(categorySensitivity("unknown")).toBe("unknown");
  });
});

describe("defaultActionForSensitivity", () => {
  it("maps each level", () => {
    expect(defaultActionForSensitivity("low")).toBe("approve_candidate");
    expect(defaultActionForSensitivity("medium")).toBe("ask");
    expect(defaultActionForSensitivity("high")).toBe("ask_explicit");
    expect(defaultActionForSensitivity("secret")).toBe("never_fill");
    expect(defaultActionForSensitivity("unknown")).toBe("manual_review");
  });
});

describe("reconcileClassification", () => {
  it("forces secrets to never_fill even if the model says otherwise", () => {
    const r = reconcileClassification(base({ category: "password", sensitivity: "low", recommendedAction: "approve_candidate" }));
    expect(r.sensitivity).toBe("secret");
    expect(r.recommendedAction).toBe("never_fill");
    expect(r.profileKeySuggestion).toBeNull();
    expect(isFillable(r)).toBe(false);
  });

  it("forces unknown category to manual_review", () => {
    const r = reconcileClassification(base({ category: "unknown", sensitivity: "low", recommendedAction: "approve_candidate" }));
    expect(r.sensitivity).toBe("unknown");
    expect(r.recommendedAction).toBe("manual_review");
  });

  it("raises sensitivity to the category floor (no downgrade)", () => {
    const r = reconcileClassification(base({ category: "government_id", sensitivity: "low", recommendedAction: "approve_candidate" }));
    expect(r.sensitivity).toBe("high");
    expect(r.recommendedAction).toBe("ask_explicit");
    expect(r.warnings.some((w) => /Raised sensitivity/.test(w))).toBe(true);
  });

  it("keeps the model's stricter action if more cautious", () => {
    const r = reconcileClassification(base({ category: "contact.email", sensitivity: "medium", recommendedAction: "manual_review" }));
    expect(r.recommendedAction).toBe("manual_review");
  });

  it("does not lower a model's higher sensitivity", () => {
    const r = reconcileClassification(base({ category: "contact.email", sensitivity: "high", recommendedAction: "ask_explicit" }));
    expect(r.sensitivity).toBe("high");
  });
});

describe("batch helpers", () => {
  it("only low + approve_candidate are batchable", () => {
    const low = reconcileClassification(base({ category: "locale.language", sensitivity: "low", recommendedAction: "approve_candidate" }));
    expect(isLowSensitivityBatchable(low)).toBe(true);
    const medium = reconcileClassification(base({ category: "contact.email", sensitivity: "medium", recommendedAction: "ask" }));
    expect(isLowSensitivityBatchable(medium)).toBe(false);
  });
});
