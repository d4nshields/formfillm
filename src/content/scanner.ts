/*
 * formfillm — DOM field scanner (content script)
 *
 * Produces FieldMetadata describing what a form asks for. It extracts ONLY
 * structural metadata and labels — never the field's current value (only a
 * boolean `hasValue`) and never unrelated page text. Element references are
 * kept in a separate in-page registry so the side panel can later fill
 * approved fields by id, without those references ever leaving the page.
 *
 * Reimplemented in TypeScript for formfillm. Label-resolution and ARIA-widget
 * handling techniques were informed by the smartfill-ai reference project
 * (MIT, Phạm Văn Huynh); no source was copied — see docs/ARCHITECTURE.md.
 */

import type { FieldKind, FieldMetadata, FieldOption } from "../shared/types.js";

export interface FieldOptionRef extends FieldOption {
  el?: Element;
}

export interface FieldRef {
  fieldId: string;
  kind: FieldKind;
  /** Primary element (the widget container for ARIA kinds). */
  primary: Element;
  /** All elements involved (e.g. radio group members). */
  els: Element[];
  options?: FieldOptionRef[];
}

export interface ScanResult {
  fields: FieldMetadata[];
  refs: Map<string, FieldRef>;
}

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "file"]);

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

function text(node: Element | null): string {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function ariaLabelledByText(el: Element): string | null {
  const ref = el.getAttribute("aria-labelledby");
  if (!ref) return null;
  const t = ref
    .split(/\s+/)
    .map((id) => text(document.getElementById(id)))
    .filter(Boolean)
    .join(" ");
  return t || null;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // Minimal fallback for environments without CSS.escape (e.g. test runners).
  return value.replace(/["\\\]]/g, "\\$&");
}

function associatedLabelText(el: Element): string | null {
  const id = el.getAttribute("id");
  if (id) {
    const byFor = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (byFor && text(byFor)) return text(byFor);
  }
  const parentLabel = el.closest("label");
  if (parentLabel && text(parentLabel)) return text(parentLabel);
  return null;
}

/** Find a short run of nearby visible text by walking up the DOM. */
function findNearbyText(el: Element): string | null {
  let node: Element | null = el;
  for (let i = 0; i < 5 && node; i++) {
    node = node.parentElement;
    if (!node) break;
    const clone = node.cloneNode(true) as Element;
    clone
      .querySelectorAll("input, select, textarea, button, option, [role='radio'], [role='option']")
      .forEach((n) => n.remove());
    const t = text(clone);
    if (t.length > 1 && t.length < 200) return t;
  }
  return null;
}

function sectionHeading(el: Element): string | null {
  const fieldset = el.closest("fieldset");
  const legend = fieldset?.querySelector("legend");
  if (legend && text(legend)) return text(legend);

  // Nearest preceding heading by document order.
  const headings = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"),
  ) as Element[];
  let best: string | null = null;
  for (const h of headings) {
    if (!isVisible(h)) continue;
    const pos = h.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      const t = text(h);
      if (t) best = t;
    }
  }
  return best;
}

function formContext(el: Element): string | null {
  const form = (el as HTMLInputElement).form ?? el.closest("form");
  if (!form) return null;
  return form.getAttribute("name") || form.getAttribute("id") || null;
}

function attr(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  return v && v.trim() ? v.trim() : null;
}

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function makeBaseMeta(el: Element, fieldId: string, kind: FieldKind, inputType: string | null): FieldMetadata {
  return {
    fieldId,
    kind,
    tagName: el.tagName.toLowerCase(),
    inputType,
    name: attr(el, "name"),
    domId: attr(el, "id"),
    autocomplete: attr(el, "autocomplete"),
    placeholder: attr(el, "placeholder"),
    ariaLabel: attr(el, "aria-label"),
    ariaLabelledByText: ariaLabelledByText(el),
    labelText: associatedLabelText(el),
    nearbyText: findNearbyText(el),
    sectionHeading: sectionHeading(el),
    required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
    disabled: (el as HTMLInputElement).disabled === true,
    readonly: (el as HTMLInputElement).readOnly === true,
    hasValue: false,
    rect: rectOf(el),
    visible: true,
    formContext: formContext(el),
  };
}

export function scanFields(): ScanResult {
  const fields: FieldMetadata[] = [];
  const refs = new Map<string, FieldRef>();
  const claimed = new WeakSet<Element>();
  const seenRadioGroups = new Set<string>();
  let counter = 0;
  const nextId = () => `ff-${counter++}`;

  const push = (meta: FieldMetadata, ref: FieldRef) => {
    fields.push(meta);
    refs.set(meta.fieldId, ref);
  };

  // 1) Native controls: input / select / textarea
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    if (claimed.has(el) || !isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const inputType = ((el as HTMLInputElement).type || tag).toLowerCase();
    if (tag === "input" && SKIP_INPUT_TYPES.has(inputType)) continue;

    if (inputType === "radio") {
      const name = (el as HTMLInputElement).name;
      if (name && seenRadioGroups.has(name)) continue;
      if (name) seenRadioGroups.add(name);
      const group = name
        ? (Array.from(document.getElementsByName(name)).filter((n) => n instanceof HTMLInputElement) as HTMLInputElement[])
        : [el as HTMLInputElement];
      group.forEach((r) => claimed.add(r));
      const id = nextId();
      const options: FieldOptionRef[] = group.map((r) => ({
        label: associatedLabelText(r) || r.value || "",
        value: r.value,
        el: r,
      }));
      const meta = makeBaseMeta(el, id, "radio", "radio");
      meta.labelText = meta.sectionHeading ?? findNearbyText(el);
      meta.options = options.map(({ label, value }) => ({ label, value }));
      meta.hasValue = group.some((r) => r.checked);
      push(meta, { fieldId: id, kind: "radio", primary: el, els: group, options });
      continue;
    }

    if (inputType === "checkbox") {
      claimed.add(el);
      const id = nextId();
      const meta = makeBaseMeta(el, id, "checkbox", "checkbox");
      meta.hasValue = (el as HTMLInputElement).checked;
      push(meta, { fieldId: id, kind: "checkbox", primary: el, els: [el] });
      continue;
    }

    if (tag === "select") {
      claimed.add(el);
      const sel = el as HTMLSelectElement;
      const id = nextId();
      const options: FieldOptionRef[] = Array.from(sel.options)
        .map((o) => ({ label: text(o), value: o.value }))
        .filter((o) => o.label && o.value !== "");
      const meta = makeBaseMeta(el, id, "select", sel.multiple ? "select-multiple" : "select-one");
      meta.options = options.map(({ label, value }) => ({ label, value }));
      meta.hasValue = sel.selectedIndex > 0 && sel.value !== "";
      push(meta, { fieldId: id, kind: "select", primary: el, els: [el], options });
      continue;
    }

    // text-like inputs and textarea
    claimed.add(el);
    const id = nextId();
    const meta = makeBaseMeta(el, id, tag === "textarea" ? "textarea" : "text", inputType);
    meta.hasValue = Boolean((el as HTMLInputElement | HTMLTextAreaElement).value);
    push(meta, { fieldId: id, kind: tag === "textarea" ? "textarea" : "text", primary: el, els: [el] });
  }

  // 2) ARIA radio groups (e.g. Google Forms <div role="radiogroup">)
  for (const rg of Array.from(document.querySelectorAll('[role="radiogroup"]'))) {
    if (claimed.has(rg) || !isVisible(rg)) continue;
    const radios = Array.from(rg.querySelectorAll('[role="radio"]')).filter(
      (r) => isVisible(r) && !claimed.has(r),
    );
    if (!radios.length) continue;
    radios.forEach((r) => claimed.add(r));
    const id = nextId();
    const options: FieldOptionRef[] = radios
      .map((r) => ({ label: attr(r, "aria-label") || text(r), el: r }))
      .filter((o) => o.label);
    if (!options.length) continue;
    const meta = makeBaseMeta(rg, id, "aria-radio", null);
    meta.labelText = ariaLabelledByText(rg) || attr(rg, "aria-label") || findNearbyText(rg);
    meta.options = options.map(({ label }) => ({ label }));
    meta.hasValue = radios.some((r) => r.getAttribute("aria-checked") === "true");
    push(meta, { fieldId: id, kind: "aria-radio", primary: rg, els: radios, options });
  }

  // 3) ARIA listboxes / comboboxes (custom dropdowns)
  for (const lb of Array.from(document.querySelectorAll('[role="listbox"], [role="combobox"]'))) {
    if (claimed.has(lb) || !isVisible(lb)) continue;
    if (lb.tagName.toLowerCase() === "input" || lb.tagName.toLowerCase() === "select") continue;
    const optEls = Array.from(lb.querySelectorAll('[role="option"]'));
    const options: FieldOptionRef[] = optEls
      .map((o) => ({ label: attr(o, "aria-label") || text(o), el: o }))
      .filter((o) => o.label && !/^(select|choose|--|none)\b/i.test(o.label));
    if (!options.length) continue;
    claimed.add(lb);
    const id = nextId();
    const meta = makeBaseMeta(lb, id, "aria-listbox", null);
    meta.labelText = ariaLabelledByText(lb) || attr(lb, "aria-label") || findNearbyText(lb);
    meta.options = options.map(({ label }) => ({ label }));
    meta.hasValue = lb.getAttribute("aria-activedescendant") !== null;
    push(meta, { fieldId: id, kind: "aria-listbox", primary: lb, els: [lb], options });
  }

  return { fields, refs };
}
