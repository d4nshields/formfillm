/*
 * formfillm — password field context (content script)
 *
 * Gathers, on demand, the live constraints and policy text around a password
 * field so the background can extract a structured rule set and the side panel
 * can generate a compliant password. Reads the page only; sends no user data.
 */

import type { PasswordContext } from "../shared/messages.js";
import type { FieldRef } from "./scanner.js";

function text(node: Element | null): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const REQUIREMENT_RE =
  /(character|uppercase|lowercase|number|digit|symbol|special|length|at least|must (include|not|contain)|minimum|maximum|no spaces)/i;

/** Find the closest ancestor that states the password policy, return its text. */
function gatherPolicyText(input: HTMLInputElement): string | null {
  const parts: string[] = [];

  const describedby = input.getAttribute("aria-describedby");
  if (describedby) {
    for (const id of describedby.split(/\s+/)) {
      const t = text(document.getElementById(id));
      if (t) parts.push(t);
    }
  }

  let node: Element | null = input.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const t = node.textContent ?? "";
    if (/password/i.test(t) && REQUIREMENT_RE.test(t) && t.length < 1500) {
      parts.push(text(node));
      break;
    }
    node = node.parentElement;
  }

  const seen = new Set<string>();
  const joined = parts
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join(" \n ")
    .slice(0, 1200);
  return joined || null;
}

function isPasswordInput(el: Element): el is HTMLInputElement {
  return el.tagName?.toLowerCase() === "input" && (el as HTMLInputElement).type?.toLowerCase() === "password";
}

/** Detect a "confirm password" field to fill with the same value. */
function findConfirmField(
  refs: Map<string, FieldRef>,
  fieldId: string,
  input: HTMLInputElement,
): string | null {
  let nextPassword: string | null = null;
  for (const [id, ref] of refs) {
    if (id === fieldId) continue;
    const el = ref.primary;
    if (!isPasswordInput(el)) continue;
    const hint = `${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""} ${el.placeholder}`.toLowerCase();
    if (/confirm|re-?enter|reenter|repeat|again|verify/.test(hint)) return id;
    const pos = input.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING && nextPassword === null) nextPassword = id;
  }
  return nextPassword;
}

export function getPasswordContext(refs: Map<string, FieldRef>, fieldId: string): PasswordContext {
  const empty: PasswordContext = {
    fieldId,
    minLength: null,
    maxLength: null,
    pattern: null,
    policyText: null,
    confirmFieldId: null,
  };
  const ref = refs.get(fieldId);
  if (!ref || !isPasswordInput(ref.primary)) return empty;
  const input = ref.primary;

  return {
    fieldId,
    minLength: input.minLength >= 0 ? input.minLength : null,
    maxLength: input.maxLength >= 0 ? input.maxLength : null,
    pattern: input.getAttribute("pattern"),
    policyText: gatherPolicyText(input),
    confirmFieldId: findConfirmField(refs, fieldId, input),
  };
}
