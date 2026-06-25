/*
 * formfillm — disclosure ledger
 *
 * The ledger records WHAT KIND of data was disclosed and the user's decision,
 * never the value itself. `buildLedgerEntry` is the only constructor, and
 * `redactLedgerEntry` is a defensive pass that strips any stray keys so a value
 * can never end up persisted even if a caller passes extra data by mistake.
 */

import type {
  FieldCategory,
  LedgerDecision,
  LedgerEntry,
  Sensitivity,
} from "./types.js";

export interface LedgerEntryInput {
  timestamp: number;
  siteOrigin: string;
  pageTitle: string | null;
  fieldLabel: string;
  category: FieldCategory;
  sensitivity: Sensitivity;
  decision: LedgerDecision;
  filled: boolean;
}

/** The exact set of keys allowed in a persisted ledger entry. */
const ALLOWED_KEYS: ReadonlyArray<keyof LedgerEntry> = [
  "timestamp",
  "siteOrigin",
  "pageTitle",
  "fieldLabel",
  "category",
  "sensitivity",
  "decision",
  "valueStored",
  "filled",
];

/** Build a ledger entry. `valueStored` is hard-coded to false by construction. */
export function buildLedgerEntry(input: LedgerEntryInput): LedgerEntry {
  return {
    timestamp: input.timestamp,
    siteOrigin: input.siteOrigin,
    pageTitle: input.pageTitle,
    fieldLabel: input.fieldLabel,
    category: input.category,
    sensitivity: input.sensitivity,
    decision: input.decision,
    valueStored: false,
    filled: input.filled,
  };
}

/**
 * Defensive redaction: copy only the allowed keys, forcing `valueStored:false`.
 * Any extra key (e.g. an accidental `value`) is dropped. Use before persisting.
 */
export function redactLedgerEntry(raw: Record<string, unknown>): LedgerEntry {
  const out = {} as Record<string, unknown>;
  for (const key of ALLOWED_KEYS) {
    out[key] = raw[key];
  }
  out.valueStored = false;
  return out as unknown as LedgerEntry;
}
