/*
 * formfillm — side panel storage access
 *
 * Thin, typed wrappers over chrome.storage.local for settings, the local
 * profile vault, and the disclosure ledger. The profile lives ONLY here in
 * local storage and is never sent to the background worker or the model.
 * Ledger writes always pass through redaction so values can never persist.
 */

import { redactLedgerEntry } from "../shared/ledger.js";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type LedgerEntry,
  type Profile,
  type Settings,
} from "../shared/types.js";

const LEDGER_CAP = 500;

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = (stored[STORAGE_KEYS.settings] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...raw, localOnly: true };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...settings, localOnly: true } });
}

export async function getProfile(): Promise<Profile> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.profile);
  const raw = stored[STORAGE_KEYS.profile] as Profile | undefined;
  if (raw && typeof raw === "object" && raw.values && typeof raw.values === "object") {
    return { values: { ...raw.values } };
  }
  return { values: {} };
}

export async function saveProfile(profile: Profile): Promise<void> {
  // Only string values are persisted; everything else is dropped.
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(profile.values)) {
    if (typeof v === "string") values[k] = v;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: { values } });
}

export async function getLedger(): Promise<LedgerEntry[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ledger);
  const raw = stored[STORAGE_KEYS.ledger];
  return Array.isArray(raw) ? (raw as LedgerEntry[]) : [];
}

export async function appendLedger(entries: LedgerEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await getLedger();
  // Defensive redaction on the way in — no value can ever be persisted.
  const redacted = entries.map((e) => redactLedgerEntry(e as unknown as Record<string, unknown>));
  const combined = [...existing, ...redacted].slice(-LEDGER_CAP);
  await chrome.storage.local.set({ [STORAGE_KEYS.ledger]: combined });
}

export async function clearLedger(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.ledger]: [] });
}

/** Demo profile with obviously-fake values. Created only on explicit request. */
export function demoProfile(): Profile {
  return {
    values: {
      "identity.full_name": "Alex Demo",
      "identity.first_name": "Alex",
      "identity.last_name": "Demo",
      "contact.email": "alex.demo@example.com",
      "contact.phone": "+1-555-0100",
      "address.street": "123 Sample Street",
      "address.unit": "Apt 4",
      "address.city": "Springfield",
      "address.region": "Ontario",
      "address.postal_code": "K1A 0A6",
      "address.country": "Canada",
      "locale.language": "English",
      "locale.region": "CA",
      "preference.communication": "Email",
      "employment.job_title": "Demonstration Specialist",
      "employment.company": "Example Corp",
    },
  };
}
