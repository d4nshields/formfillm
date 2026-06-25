/*
 * formfillm — sensitivity rules
 *
 * These rules are the safety floor. The local LLM proposes a sensitivity and
 * action, but we never trust it to *lower* caution: we reconcile its output
 * against a canonical category→sensitivity map and always fail closed.
 * Secrets are never fillable, full stop.
 */

import type { FieldCategory, FieldClassification, RecommendedAction, Sensitivity } from "./types.js";

/** Categories that are always secrets and must never be filled. */
export const SECRET_CATEGORIES: ReadonlySet<FieldCategory> = new Set<FieldCategory>([
  "password",
  "secret",
]);

/** Canonical sensitivity for each category (the floor; LLM may only raise it). */
const CATEGORY_SENSITIVITY: Record<FieldCategory, Sensitivity> = {
  "locale.language": "low",
  "locale.region": "low",
  "preference.generic": "low",
  "preference.communication": "low",

  "identity.full_name": "medium",
  "identity.first_name": "medium",
  "identity.last_name": "medium",
  "identity.username": "medium",
  "contact.email": "medium",
  "contact.phone": "medium",
  "address.street": "medium",
  "address.unit": "medium",
  "address.city": "medium",
  "address.region": "medium",
  "address.postal_code": "medium",
  "address.country": "medium",
  "employment.job_title": "medium",
  "employment.company": "medium",

  "demographic.birthdate": "high",
  "demographic.gender": "high",
  "government_id": "high",
  "health": "high",
  "financial": "high",

  "password": "secret",
  "secret": "secret",

  "unknown": "unknown",
};

const SENS_RANK: Record<Sensitivity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  secret: 4,
};

const ACTION_CAUTION: Record<RecommendedAction, number> = {
  approve_candidate: 1,
  ask: 2,
  ask_explicit: 3,
  skip: 4,
  manual_review: 4,
  never_fill: 5,
};

export function categorySensitivity(category: FieldCategory): Sensitivity {
  return CATEGORY_SENSITIVITY[category];
}

export function isSecretCategory(category: FieldCategory): boolean {
  return SECRET_CATEGORIES.has(category);
}

/** Default action implied by a sensitivity level (used when category is known). */
export function defaultActionForSensitivity(sensitivity: Sensitivity): RecommendedAction {
  switch (sensitivity) {
    case "low":
      return "approve_candidate";
    case "medium":
      return "ask";
    case "high":
      return "ask_explicit";
    case "secret":
      return "never_fill";
    case "unknown":
      return "manual_review";
  }
}

/** Pick the stricter (higher-caution) of two actions. */
function stricterAction(a: RecommendedAction, b: RecommendedAction): RecommendedAction {
  return ACTION_CAUTION[a] >= ACTION_CAUTION[b] ? a : b;
}

/** Pick the more-sensitive of two levels; a known level beats `unknown`. */
function stricterSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENS_RANK[a] >= SENS_RANK[b] ? a : b;
}

/**
 * Reconcile a raw (already schema-valid) classification against the safety
 * floor. Guarantees:
 *  - secret categories are forced to secret + never_fill
 *  - unknown categories are forced to manual_review
 *  - sensitivity is never lower than the category's canonical level
 *  - the recommended action is never less cautious than implied by sensitivity
 */
export function reconcileClassification(c: FieldClassification): FieldClassification {
  const warnings = [...c.warnings];

  // Hard stop for secrets regardless of what the model said.
  if (isSecretCategory(c.category)) {
    if (c.recommendedAction !== "never_fill") {
      warnings.push("Secret field — overriding recommendation to never_fill.");
    }
    return {
      ...c,
      sensitivity: "secret",
      recommendedAction: "never_fill",
      profileKeySuggestion: null,
      warnings,
    };
  }

  if (c.category === "unknown") {
    return {
      ...c,
      sensitivity: "unknown",
      recommendedAction: "manual_review",
      warnings,
    };
  }

  const floor = categorySensitivity(c.category);
  const sensitivity = stricterSensitivity(floor, c.sensitivity);
  if (SENS_RANK[c.sensitivity] < SENS_RANK[floor]) {
    warnings.push(`Raised sensitivity from "${c.sensitivity}" to "${sensitivity}" per category floor.`);
  }

  const action = stricterAction(c.recommendedAction, defaultActionForSensitivity(sensitivity));

  return { ...c, sensitivity, recommendedAction: action, warnings };
}

/** Whether a reconciled classification is allowed to be filled at all. */
export function isFillable(c: FieldClassification): boolean {
  return c.recommendedAction !== "never_fill" && c.sensitivity !== "secret";
}

/** Whether a field may be included in a "fill all low sensitivity" batch. */
export function isLowSensitivityBatchable(c: FieldClassification): boolean {
  return c.sensitivity === "low" && c.recommendedAction === "approve_candidate";
}
