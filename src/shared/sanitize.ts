/*
 * formfillm — field metadata sanitization
 *
 * Everything sent to the local LLM passes through here first. We cap lengths,
 * strip control characters, collapse whitespace, and rebuild the object from a
 * fixed key set so no unexpected data (and never a field value) can ride along
 * into the prompt.
 */

import type { FieldMetadata, FieldOption } from "./types.js";

const MAX_LABEL = 300;
const MAX_NEARBY = 400;
const MAX_HEADING = 200;
const MAX_GENERIC = 200;
const MAX_OPTIONS = 50;
const MAX_OPTION_LABEL = 120;

// ASCII control characters (0x00–0x1F) plus DEL (0x7F). Built via RegExp
// constructor so no literal control bytes appear in source.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\x00-\\x1F\\x7F]", "g");

/** Collapse whitespace, drop control chars, trim, and cap length. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.replace(CONTROL_CHARS, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}

function cleanOptions(options: FieldOption[] | undefined): FieldOption[] | undefined {
  if (!Array.isArray(options)) return undefined;
  const out: FieldOption[] = [];
  for (const opt of options.slice(0, MAX_OPTIONS)) {
    const label = cleanText(opt?.label, MAX_OPTION_LABEL);
    if (!label) continue;
    const value = cleanText(opt?.value, MAX_OPTION_LABEL);
    out.push(value !== null ? { label, value } : { label });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Rebuild a FieldMetadata from a fixed key set with all text sanitized.
 * Guarantees the result carries no value and no unexpected properties.
 */
export function sanitizeFieldMetadata(field: FieldMetadata): FieldMetadata {
  return {
    fieldId: cleanText(field.fieldId, 64) ?? "",
    kind: field.kind,
    tagName: cleanText(field.tagName, 32) ?? "",
    inputType: cleanText(field.inputType, 32),
    name: cleanText(field.name, MAX_GENERIC),
    domId: cleanText(field.domId, MAX_GENERIC),
    autocomplete: cleanText(field.autocomplete, MAX_GENERIC),
    placeholder: cleanText(field.placeholder, MAX_GENERIC),
    ariaLabel: cleanText(field.ariaLabel, MAX_LABEL),
    ariaLabelledByText: cleanText(field.ariaLabelledByText, MAX_LABEL),
    labelText: cleanText(field.labelText, MAX_LABEL),
    nearbyText: cleanText(field.nearbyText, MAX_NEARBY),
    sectionHeading: cleanText(field.sectionHeading, MAX_HEADING),
    required: Boolean(field.required),
    disabled: Boolean(field.disabled),
    readonly: Boolean(field.readonly),
    hasValue: Boolean(field.hasValue),
    options: cleanOptions(field.options),
    rect: {
      x: Math.round(Number(field.rect?.x) || 0),
      y: Math.round(Number(field.rect?.y) || 0),
      width: Math.round(Number(field.rect?.width) || 0),
      height: Math.round(Number(field.rect?.height) || 0),
    },
    visible: Boolean(field.visible),
    formContext: cleanText(field.formContext, MAX_GENERIC),
  };
}

export function sanitizeFieldsForModel(fields: FieldMetadata[]): FieldMetadata[] {
  return fields.map(sanitizeFieldMetadata).filter((f) => f.fieldId.length > 0);
}
