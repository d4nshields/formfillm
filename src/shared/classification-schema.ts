/*
 * formfillm — classification schema + validation
 *
 * Two jobs:
 *  1. Provide a JSON schema we hand to Ollama for structured output.
 *  2. Validate whatever actually comes back. We NEVER trust the model's
 *     output shape — every field is validated, and anything missing or
 *     malformed becomes a fail-closed `unknown / manual_review` entry.
 */

import {
  FIELD_CATEGORIES,
  RECOMMENDED_ACTIONS,
  SENSITIVITIES,
  type FieldCategory,
  type FieldClassification,
  type RecommendedAction,
  type Sensitivity,
} from "./types.js";

/** JSON schema passed to Ollama's `format` for schema-constrained output. */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fieldId: { type: "string" },
          category: { type: "string", enum: [...FIELD_CATEGORIES] },
          sensitivity: { type: "string", enum: [...SENSITIVITIES] },
          plainLanguageReason: { type: "string", maxLength: 80 },
          possiblePurpose: { type: "string", maxLength: 60 },
          recommendedAction: { type: "string", enum: [...RECOMMENDED_ACTIONS] },
          profileKeySuggestion: { type: ["string", "null"] },
          warnings: { type: "array", items: { type: "string", maxLength: 100 } },
        },
        required: [
          "fieldId",
          "category",
          "sensitivity",
          "plainLanguageReason",
          "possiblePurpose",
          "recommendedAction",
        ],
      },
    },
  },
  required: ["classifications"],
} as const;

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asCategory(v: unknown): FieldCategory {
  return (FIELD_CATEGORIES as readonly string[]).includes(v as string)
    ? (v as FieldCategory)
    : "unknown";
}

function asSensitivity(v: unknown): Sensitivity {
  return (SENSITIVITIES as readonly string[]).includes(v as string)
    ? (v as Sensitivity)
    : "unknown";
}

function asAction(v: unknown): RecommendedAction {
  return (RECOMMENDED_ACTIONS as readonly string[]).includes(v as string)
    ? (v as RecommendedAction)
    : "manual_review";
}

function asConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function asWarnings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** A safe, fail-closed classification used when the model gives us nothing usable. */
export function makeFailClosedClassification(fieldId: string, reason: string): FieldClassification {
  return {
    fieldId,
    category: "unknown",
    sensitivity: "unknown",
    confidence: 0,
    plainLanguageReason: reason,
    possiblePurpose: "Unknown — classification unavailable.",
    recommendedAction: "manual_review",
    profileKeySuggestion: null,
    warnings: ["Field could not be classified; defaulted to manual review."],
  };
}

/** Validate a single raw item into a well-formed classification (never throws). */
export function validateClassificationItem(raw: unknown): FieldClassification | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const fieldId = asString(o.fieldId);
  if (!fieldId) return null;
  return {
    fieldId,
    category: asCategory(o.category),
    sensitivity: asSensitivity(o.sensitivity),
    confidence: asConfidence(o.confidence),
    plainLanguageReason: asString(o.plainLanguageReason, "No explanation provided."),
    possiblePurpose: asString(o.possiblePurpose, "Unknown purpose."),
    recommendedAction: asAction(o.recommendedAction),
    profileKeySuggestion:
      typeof o.profileKeySuggestion === "string" ? o.profileKeySuggestion : null,
    warnings: asWarnings(o.warnings),
  };
}

export interface ValidationResult {
  classifications: FieldClassification[];
  errors: string[];
}

/**
 * Validate the full model response against the set of field ids we asked about.
 * Returns exactly one classification per known field id: validated where the
 * model answered, fail-closed where it did not.
 */
export function validateClassificationResponse(
  raw: unknown,
  knownFieldIds: string[],
): ValidationResult {
  const errors: string[] = [];
  const byId = new Map<string, FieldClassification>();

  // Accept the wrapped form {"classifications":[...]} OR {"fields":[...]} OR a
  // bare top-level array [...]. Local models frequently return a bare array
  // even when asked to wrap it, so tolerate all three rather than fail closed.
  const arr: unknown[] | null = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { classifications?: unknown }).classifications)
      ? (raw as { classifications: unknown[] }).classifications
      : typeof raw === "object" && raw !== null && Array.isArray((raw as { fields?: unknown }).fields)
        ? (raw as { fields: unknown[] }).fields
        : null;

  if (!arr) {
    errors.push("Response missing a valid `classifications` array.");
  } else {
    const known = new Set(knownFieldIds);
    for (const item of arr) {
      const parsed = validateClassificationItem(item);
      if (!parsed) {
        errors.push("Dropped a malformed classification item.");
        continue;
      }
      if (!known.has(parsed.fieldId)) {
        errors.push(`Dropped classification for unknown field id "${parsed.fieldId}".`);
        continue;
      }
      // First valid answer wins; ignore duplicates.
      if (!byId.has(parsed.fieldId)) byId.set(parsed.fieldId, parsed);
    }
  }

  // Fail closed for any field the model skipped or got dropped.
  const classifications = knownFieldIds.map(
    (id) => byId.get(id) ?? makeFailClosedClassification(id, "Model returned no classification for this field."),
  );

  return { classifications, errors };
}

/**
 * Extract a JSON object from a model string that may include stray prose or
 * code fences. Returns the parsed value or null. Mirrors a robust-extraction
 * approach so we tolerate models that don't honor strict JSON output.
 */
export function extractJson(content: string): unknown | null {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to bracket extraction.
  }
  // Try the outermost {...} object or [...] array block, whichever starts
  // first (models may return a bare array, sometimes wrapped in prose/fences).
  const candidates: Array<[number, number]> = [];
  const os = trimmed.indexOf("{");
  const oe = trimmed.lastIndexOf("}");
  if (os >= 0 && oe > os) candidates.push([os, oe]);
  const as = trimmed.indexOf("[");
  const ae = trimmed.lastIndexOf("]");
  if (as >= 0 && ae > as) candidates.push([as, ae]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [s, e] of candidates) {
    try {
      return JSON.parse(trimmed.slice(s, e + 1));
    } catch {
      // try the next candidate
    }
  }
  return null;
}
