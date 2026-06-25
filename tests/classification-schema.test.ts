import { describe, expect, it } from "vitest";
import {
  extractJson,
  makeFailClosedClassification,
  validateClassificationItem,
  validateClassificationResponse,
} from "../src/shared/classification-schema.js";

describe("validateClassificationItem", () => {
  it("coerces invalid enums to safe defaults", () => {
    const r = validateClassificationItem({
      fieldId: "ff-1",
      category: "not-a-category",
      sensitivity: "spicy",
      confidence: 5,
      recommendedAction: "do-it",
    });
    expect(r).not.toBeNull();
    expect(r!.category).toBe("unknown");
    expect(r!.sensitivity).toBe("unknown");
    expect(r!.confidence).toBe(1); // clamped to [0,1]
    expect(r!.recommendedAction).toBe("manual_review");
  });

  it("rejects items with no fieldId", () => {
    expect(validateClassificationItem({ category: "contact.email" })).toBeNull();
    expect(validateClassificationItem(null)).toBeNull();
  });
});

describe("validateClassificationResponse", () => {
  it("returns one entry per known field, filling gaps fail-closed", () => {
    const raw = {
      classifications: [
        {
          fieldId: "ff-0",
          category: "contact.email",
          sensitivity: "medium",
          confidence: 0.9,
          plainLanguageReason: "email",
          possiblePurpose: "contact",
          recommendedAction: "ask",
        },
      ],
    };
    const { classifications } = validateClassificationResponse(raw, ["ff-0", "ff-1"]);
    expect(classifications).toHaveLength(2);
    const byId = new Map(classifications.map((c) => [c.fieldId, c]));
    expect(byId.get("ff-0")!.category).toBe("contact.email");
    // ff-1 was missing -> fail closed
    expect(byId.get("ff-1")!.category).toBe("unknown");
    expect(byId.get("ff-1")!.recommendedAction).toBe("manual_review");
  });

  it("drops classifications for unknown field ids", () => {
    const raw = { classifications: [{ fieldId: "ghost", category: "contact.email", sensitivity: "medium", confidence: 1, plainLanguageReason: "", possiblePurpose: "", recommendedAction: "ask" }] };
    const { classifications, errors } = validateClassificationResponse(raw, ["ff-0"]);
    expect(classifications).toHaveLength(1);
    expect(classifications[0]!.fieldId).toBe("ff-0");
    expect(classifications[0]!.category).toBe("unknown");
    expect(errors.some((e) => /unknown field id/.test(e))).toBe(true);
  });

  it("fails closed entirely when the response is garbage", () => {
    const { classifications, errors } = validateClassificationResponse("nonsense", ["ff-0", "ff-1"]);
    expect(classifications).toHaveLength(2);
    expect(classifications.every((c) => c.recommendedAction === "manual_review")).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("makeFailClosedClassification", () => {
  it("is always manual_review/unknown", () => {
    const c = makeFailClosedClassification("ff-9", "boom");
    expect(c.category).toBe("unknown");
    expect(c.sensitivity).toBe("unknown");
    expect(c.recommendedAction).toBe("manual_review");
  });
});

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("extracts JSON wrapped in prose / code fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('blah {"a":3} trailing')).toEqual({ a: 3 });
  });
  it("returns null when no JSON object present", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});
