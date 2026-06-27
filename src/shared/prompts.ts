/*
 * formfillm — classifier prompts
 *
 * CRITICAL PRIVACY INVARIANT: prompts here describe form *fields*, never the
 * user's stored profile values. Classification runs on page/field metadata
 * alone. The user's data is retrieved locally, after consent, and is never
 * part of any prompt.
 */

import { FIELD_CATEGORIES, RECOMMENDED_ACTIONS, SENSITIVITIES, type FieldMetadata } from "./types.js";

export const CLASSIFIER_SYSTEM_PROMPT = `You are formfillm's field classifier. You help a privacy-preserving consent assistant understand what a web form is asking for, so a human can decide what to disclose.

You are given ONLY metadata about form fields (labels, types, nearby text, options). You are NEVER given the user's personal data, and you must never ask for it.

Rules:
- Use only the provided metadata. Do not invent context that is not supported by the evidence.
- Do not infer more than the evidence supports. When a field is ambiguous, classify it as "unknown" with recommendedAction "manual_review". Prefer "unknown" / "manual_review" over an overconfident guess.
- Never recommend filling secrets: passwords, 2FA/OTP codes, government IDs (SIN/SSN), banking or card numbers, or security-question answers. For these use category "password" or "secret" (or the specific sensitive category) and recommendedAction "never_fill".
- Sensitivity guidance: low = language/region/non-sensitive preferences; medium = name/email/phone/address/employer/job title; high = birthdate, demographics, health, financial, government IDs; secret = passwords, 2FA, banking credentials, SIN/SSN, security questions.
- recommendedAction guidance: low -> "approve_candidate"; medium -> "ask"; high -> "ask_explicit"; secrets -> "never_fill"; unclear -> "manual_review".
- profileKeySuggestion: a profile key like "contact.email" if one obviously applies, otherwise null. Never output a value.
- Output exactly ONE flat classification object per field. Do NOT nest objects, and do NOT list multiple guesses for a field.
- Be terse (this is read on a narrow side panel): plainLanguageReason is one short clause of at most ~10 words; possiblePurpose is a short phrase of at most ~6 words.
- warnings: include a short warning string ONLY for high-sensitivity or secret fields; otherwise return an empty array [].
- Output ONLY valid JSON in the exact shape requested. No prose, no code fences.`;

interface PageContext {
  origin?: string;
  title?: string;
}

/** Reduce sanitized metadata to the compact shape we put in the prompt. */
function fieldForPrompt(f: FieldMetadata): Record<string, unknown> {
  const o: Record<string, unknown> = {
    fieldId: f.fieldId,
    kind: f.kind,
  };
  if (f.inputType) o.inputType = f.inputType;
  if (f.name) o.name = f.name;
  if (f.domId) o.id = f.domId;
  if (f.autocomplete) o.autocomplete = f.autocomplete;
  if (f.placeholder) o.placeholder = f.placeholder;
  if (f.labelText) o.label = f.labelText;
  if (f.ariaLabel) o.ariaLabel = f.ariaLabel;
  if (f.ariaLabelledByText) o.ariaLabelledBy = f.ariaLabelledByText;
  if (f.nearbyText) o.nearbyText = f.nearbyText;
  if (f.sectionHeading) o.sectionHeading = f.sectionHeading;
  o.required = f.required;
  if (f.options && f.options.length) o.options = f.options.map((opt) => opt.label);
  return o;
}

/**
 * Build the user prompt. Contains ONLY field metadata and non-personal page
 * context (origin/title). Never contains profile values.
 */
export function buildClassificationPrompt(fields: FieldMetadata[], page: PageContext = {}): string {
  const payload = {
    page: {
      origin: page.origin ?? null,
      title: page.title ?? null,
    },
    categories: [...FIELD_CATEGORIES],
    sensitivities: [...SENSITIVITIES],
    recommendedActions: [...RECOMMENDED_ACTIONS],
    fields: fields.map(fieldForPrompt),
  };

  return `Classify each form field in the payload. Return ONLY this exact JSON shape — one FLAT object per fieldId, no nesting and no multiple guesses per field:

{"classifications":[{"fieldId":"<id from payload>","category":"<one value from categories>","sensitivity":"low|medium|high|secret|unknown","recommendedAction":"<one value from recommendedActions>","profileKeySuggestion":"<profile key or null>","plainLanguageReason":"<= ~10 words","possiblePurpose":"<= ~6 words","warnings":[]}]}

Give exactly one entry per fieldId, in the same order. Allowed categories, sensitivities, and recommendedActions are listed in the payload. Remember: you see only metadata, never the user's data.

PAYLOAD:
${JSON.stringify(payload, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Password policy extraction. Receives ONLY the site's policy text and the
// input's own constraints — never any user data.
// ---------------------------------------------------------------------------

export const PASSWORD_POLICY_SYSTEM_PROMPT = `You extract a website's password requirements into a strict JSON object so a generator can build a compliant password.

Rules:
- Use only the provided policy text and input constraints. Do not invent requirements.
- Set requireLower/requireUpper/requireDigit true only if the text requires that character class.
- requireSymbol true only if a special/symbol character is explicitly required.
- symbolsAllowed: true unless the text clearly forbids symbols/special characters.
- forbidSpaces: true if spaces are disallowed (e.g. "no spaces"), otherwise true by default for safety.
- minLength/maxLength: numbers if stated, otherwise null.
- Output ONLY valid JSON matching the schema. No prose.`;

export function buildPasswordPolicyPrompt(input: {
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  policyText: string | null;
}): string {
  return `Extract the password requirements as JSON.

Input constraints:
- minLength: ${input.minLength ?? "null"}
- maxLength: ${input.maxLength ?? "null"}
- pattern: ${input.pattern ? JSON.stringify(input.pattern) : "null"}

Policy text from the page:
"""
${input.policyText ?? "(none provided)"}
"""`;
}
