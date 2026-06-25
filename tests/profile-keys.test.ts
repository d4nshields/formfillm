import { describe, expect, it } from "vitest";
import {
  getProfileValue,
  profileHasValueForCategory,
  resolveProfileKey,
} from "../src/shared/profile-keys.js";
import type { Profile } from "../src/shared/types.js";

describe("resolveProfileKey", () => {
  it("maps categories to canonical profile keys", () => {
    expect(resolveProfileKey("contact.email")).toBe("contact.email");
    expect(resolveProfileKey("address.postal_code")).toBe("address.postal_code");
    expect(resolveProfileKey("locale.language")).toBe("locale.language");
  });

  it("returns null for categories with no safe stored value", () => {
    expect(resolveProfileKey("government_id")).toBeNull();
    expect(resolveProfileKey("password")).toBeNull();
    expect(resolveProfileKey("health")).toBeNull();
    expect(resolveProfileKey("demographic.birthdate")).toBeNull();
    expect(resolveProfileKey("identity.username")).toBeNull();
    expect(resolveProfileKey("unknown")).toBeNull();
  });

  it("falls back to a valid model suggestion when unmapped", () => {
    expect(resolveProfileKey("preference.generic", "preference.communication")).toBe("preference.communication");
  });

  it("ignores an invalid model suggestion", () => {
    expect(resolveProfileKey("unknown", "not.a.real.key")).toBeNull();
  });
});

describe("getProfileValue", () => {
  const profile: Profile = { values: { "contact.email": "  a@b.com ", "address.city": "   " } };

  it("trims values", () => {
    expect(getProfileValue(profile, "contact.email")).toBe("a@b.com");
  });
  it("treats whitespace-only as absent", () => {
    expect(getProfileValue(profile, "address.city")).toBeUndefined();
  });
  it("returns undefined for missing keys", () => {
    expect(getProfileValue(profile, "contact.phone")).toBeUndefined();
  });
});

describe("profileHasValueForCategory", () => {
  const profile: Profile = { values: { "contact.email": "a@b.com" } };
  it("true when a mapped value exists", () => {
    expect(profileHasValueForCategory(profile, "contact.email")).toBe(true);
  });
  it("false for unmapped or empty", () => {
    expect(profileHasValueForCategory(profile, "government_id")).toBe(false);
    expect(profileHasValueForCategory(profile, "contact.phone")).toBe(false);
  });
});
