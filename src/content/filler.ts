/*
 * formfillm — field filler (content script)
 *
 * Fills ONLY the fields the side panel approved, by id, with values passed in
 * the fill instruction. It never clicks submit, never bypasses validation, and
 * — as defense in depth — refuses to fill <input type="password"> even if asked
 * (the consent layer should never send secrets, but we fail closed anyway).
 *
 * Event dispatch and ARIA-listbox selection techniques were informed by the
 * smartfill-ai reference (MIT); reimplemented here in TypeScript.
 */

import type { FillInstruction, FillResult } from "../shared/messages.js";
import type { FieldOptionRef, FieldRef } from "./scanner.js";

const FILLED_OUTLINE = "2px solid #16a34a";
const SELECTED_OUTLINE = "2px solid #2563eb";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDate(value: string): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  return v;
}

/**
 * Set an input/textarea value through the prototype's native setter so that
 * framework value trackers (React, and Angular/Vue in practice) register the
 * change. Setting `el.value` directly is silently reverted by React.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && typeof desc.set === "function") {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
}

function fireEvents(el: Element): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function simulateClick(el: Element): void {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

function matchOption(target: string, options: FieldOptionRef[]): FieldOptionRef | null {
  const t = foldText(target);
  return (
    options.find((o) => foldText(o.label) === t) ??
    options.find((o) => o.value !== undefined && foldText(o.value) === t) ??
    options.find((o) => foldText(o.label).includes(t) || t.includes(foldText(o.label))) ??
    null
  );
}

function isPasswordField(ref: FieldRef): boolean {
  const el = ref.primary as HTMLInputElement;
  return el.tagName?.toLowerCase() === "input" && (el.type || "").toLowerCase() === "password";
}

async function fillOne(ref: FieldRef, value: string, allowSecret: boolean): Promise<FillResult> {
  const fieldId = ref.fieldId;

  // Defense in depth: never fill password fields UNLESS this is an explicitly
  // allowed, freshly generated password (allowSecret). Stored profile secrets
  // are never stored and never carry allowSecret.
  if (isPasswordField(ref) && !allowSecret) {
    return { fieldId, filled: false, reason: "Password fields are never filled." };
  }

  try {
    switch (ref.kind) {
      case "text":
      case "textarea": {
        const el = ref.primary as HTMLInputElement | HTMLTextAreaElement;
        let v = value;
        if ((el as HTMLInputElement).type === "date") v = normalizeDate(v);
        el.focus();
        setNativeValue(el, v);
        fireEvents(el);
        el.style.outline = FILLED_OUTLINE;
        return { fieldId, filled: true };
      }
      case "select": {
        const el = ref.primary as HTMLSelectElement;
        const opt = matchOption(value, ref.options ?? []);
        if (!opt || opt.value === undefined) return { fieldId, filled: false, reason: "No matching option." };
        el.value = opt.value;
        fireEvents(el);
        el.style.outline = FILLED_OUTLINE;
        return { fieldId, filled: true };
      }
      case "checkbox": {
        const el = ref.primary as HTMLInputElement;
        el.checked = /^(true|yes|1|on|checked)$/i.test(value.trim());
        fireEvents(el);
        (el.parentElement ?? el).setAttribute("data-formfillm-filled", "1");
        el.style.outline = FILLED_OUTLINE;
        return { fieldId, filled: true };
      }
      case "radio": {
        const opt = matchOption(value, ref.options ?? []);
        if (!opt?.el) return { fieldId, filled: false, reason: "No matching option." };
        (opt.el as HTMLInputElement).checked = true;
        fireEvents(opt.el);
        (opt.el as HTMLElement).style.outline = FILLED_OUTLINE;
        return { fieldId, filled: true };
      }
      case "aria-radio": {
        const opt = matchOption(value, ref.options ?? []);
        if (!opt?.el) return { fieldId, filled: false, reason: "No matching option." };
        simulateClick(opt.el);
        opt.el.setAttribute("aria-checked", "true");
        (opt.el as HTMLElement).style.outline = FILLED_OUTLINE;
        return { fieldId, filled: true };
      }
      case "aria-listbox": {
        const opt = matchOption(value, ref.options ?? []);
        if (!opt?.el) return { fieldId, filled: false, reason: "No matching option." };
        simulateClick(ref.primary); // open
        await sleep(250);
        opt.el.scrollIntoView({ block: "center" });
        simulateClick(opt.el);
        try {
          (opt.el as HTMLElement).click();
        } catch {
          /* ignore */
        }
        await sleep(150);
        (ref.primary as HTMLElement).style.outline = FILLED_OUTLINE;
        return { fieldId, filled: true };
      }
      default:
        return { fieldId, filled: false, reason: "Unsupported field kind." };
    }
  } catch (e) {
    return { fieldId, filled: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyFills(
  refs: Map<string, FieldRef>,
  fills: FillInstruction[],
): Promise<FillResult[]> {
  const results: FillResult[] = [];
  for (const fill of fills) {
    const ref = refs.get(fill.fieldId);
    if (!ref) {
      results.push({ fieldId: fill.fieldId, filled: false, reason: "Field not found on page." });
      continue;
    }
    results.push(await fillOne(ref, fill.value, fill.allowSecret === true));
  }
  return results;
}

let lastSelected: HTMLElement | null = null;

/** Highlight the currently reviewed field (clears the previous highlight). */
export function highlightField(refs: Map<string, FieldRef>, fieldId: string | null): void {
  if (lastSelected) {
    lastSelected.style.outline = "";
    lastSelected = null;
  }
  if (!fieldId) return;
  const ref = refs.get(fieldId);
  if (!ref) return;
  const el = ref.primary as HTMLElement;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.style.outline = SELECTED_OUTLINE;
  lastSelected = el;
}
