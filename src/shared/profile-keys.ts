/*
 * formfillm — profile key resolution
 *
 * Maps a classified category to a local profile key. This is the ONLY place
 * categories meet stored values, and it runs locally in the side panel after
 * the user approves a field — never during classification. Categories with no
 * safe profile home (secrets, government IDs, health, finance) resolve to null
 * so they can never be auto-filled.
 */

import { PROFILE_KEYS, type FieldCategory, type Profile, type ProfileKey } from "./types.js";

const CATEGORY_TO_PROFILE_KEY: Partial<Record<FieldCategory, ProfileKey>> = {
  "identity.full_name": "identity.full_name",
  "identity.first_name": "identity.first_name",
  "identity.last_name": "identity.last_name",
  "contact.email": "contact.email",
  "contact.phone": "contact.phone",
  "address.street": "address.street",
  "address.unit": "address.unit",
  "address.city": "address.city",
  "address.region": "address.region",
  "address.postal_code": "address.postal_code",
  "address.country": "address.country",
  "locale.language": "locale.language",
  "locale.region": "locale.region",
  "preference.communication": "preference.communication",
  "employment.job_title": "employment.job_title",
  "employment.company": "employment.company",
  // Deliberately unmapped (no safe stored value): identity.username,
  // preference.generic, demographic.*, government_id, health, financial,
  // password, secret, unknown.
};

function isProfileKey(value: string): value is ProfileKey {
  return (PROFILE_KEYS as readonly string[]).includes(value);
}

/**
 * Resolve the profile key for a category. Prefers the canonical category map;
 * falls back to a model-suggested key only if it is a recognized profile key.
 * Returns null when nothing safe maps.
 */
export function resolveProfileKey(
  category: FieldCategory,
  profileKeySuggestion?: string | null,
): ProfileKey | null {
  const canonical = CATEGORY_TO_PROFILE_KEY[category];
  if (canonical) return canonical;
  if (profileKeySuggestion && isProfileKey(profileKeySuggestion)) {
    return profileKeySuggestion;
  }
  return null;
}

/** Read a profile value for a key (trimmed). Returns undefined if empty/absent. */
export function getProfileValue(profile: Profile, key: ProfileKey): string | undefined {
  const v = profile.values[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether the profile holds a usable value for the given category. */
export function profileHasValueForCategory(profile: Profile, category: FieldCategory): boolean {
  const key = resolveProfileKey(category);
  if (!key) return false;
  return getProfileValue(profile, key) !== undefined;
}
