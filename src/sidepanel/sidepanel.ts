/*
 * formfillm — side panel controller
 *
 * The consent surface. It scans on explicit request, shows what the page asks
 * for with plain-language explanations, and fills ONLY fields the user
 * approves. Profile values are read locally here and sent straight to the
 * content script for filling — they never touch the model. Every fill writes a
 * value-free disclosure ledger entry.
 */

import {
  MSG,
  type ApplyFillResponse,
  type ClassifyResponse,
  type FillInstruction,
  type PageContext,
  type ScanPageResponse,
  type TestOllamaResponse,
} from "../shared/messages.js";
import type { FieldClassification, FieldMetadata, LedgerEntry, Profile, Settings } from "../shared/types.js";
import { PROFILE_KEYS } from "../shared/types.js";
import {
  assessModel,
  FALLBACK_MODELS,
  RECOMMENDED_MODEL,
  validateModelName,
  validateOllamaUrl,
} from "../shared/ollama-policy.js";
import { isFillable, isLowSensitivityBatchable } from "../shared/sensitivity.js";
import { getProfileValue, resolveProfileKey } from "../shared/profile-keys.js";
import { buildLedgerEntry } from "../shared/ledger.js";
import {
  appendLedger,
  clearLedger,
  demoProfile,
  getLedger,
  getProfile,
  getSettings,
  saveProfile,
  saveSettings,
} from "./storage.js";
import { button, clear, el } from "./ui.js";

type View = "scan" | "profile" | "ledger" | "settings";
type Decision = "pending" | "approved" | "edited" | "skipped" | "marked_wrong";

interface ReviewState {
  tabId: number | null;
  page: PageContext | null;
  fields: FieldMetadata[];
  classifications: Map<string, FieldClassification>;
  decisions: Map<string, Decision>;
  editedValues: Map<string, string>;
}

const state: ReviewState = {
  tabId: null,
  page: null,
  fields: [],
  classifications: new Map(),
  decisions: new Map(),
  editedValues: new Map(),
};

let settings: Settings;
let profile: Profile;
let currentView: View = "scan";

const viewRoot = () => document.getElementById("view") as HTMLElement;
const statusRoot = () => document.getElementById("status") as HTMLElement;
const guidanceText = (msg: string) => {
  const g = document.getElementById("guidance");
  if (g) g.textContent = msg;
};

function sendBg<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function labelFor(f: FieldMetadata): string {
  return (
    f.labelText ||
    f.ariaLabel ||
    f.ariaLabelledByText ||
    f.placeholder ||
    f.name ||
    f.domId ||
    "(no label)"
  );
}

function maskValue(value: string, sensitivity: string): string {
  if (sensitivity === "high") {
    if (value.length <= 2) return "••";
    return value[0] + "•".repeat(Math.max(2, value.length - 2)) + value[value.length - 1];
  }
  return value;
}

/** Resolve the value that would be used to fill a field (edited overrides profile). */
function resolveValue(c: FieldClassification): string | undefined {
  const edited = state.editedValues.get(c.fieldId);
  if (edited !== undefined && edited.trim() !== "") return edited;
  const key = resolveProfileKey(c.category, c.profileKeySuggestion);
  if (!key) return undefined;
  return getProfileValue(profile, key);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  const root = statusRoot();
  clear(root);
  const modelLine = el("div", { class: "ff-status-line" }, [
    el("span", { class: "ff-status-key", text: "Model:" }),
    el("span", { text: " " + settings.model }),
  ]);
  const localLine = el("div", { class: "ff-status-line" }, [
    el("span", { class: "ff-badge ff-badge-local", text: "Local-only" }),
  ]);
  const ollamaLine = el("div", { class: "ff-status-line" }, [
    el("span", { class: "ff-status-key", text: "Ollama:" }),
    el("span", { class: "ff-status-ollama", text: " checking…" }),
  ]);
  root.append(ollamaLine, modelLine, localLine);

  const res = await sendBg<TestOllamaResponse>({ type: MSG.TestOllama }).catch(
    () => ({ ok: false, reachable: false }) as TestOllamaResponse,
  );
  const span = ollamaLine.querySelector(".ff-status-ollama") as HTMLElement;
  if (res.reachable) {
    span.textContent = " reachable";
    span.classList.add("ff-ok");
  } else {
    span.textContent = " unreachable" + (res.error ? ` — ${res.error}` : "");
    span.classList.add("ff-err");
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function setView(view: View): void {
  currentView = view;
  for (const b of Array.from(document.querySelectorAll(".ff-nav-btn"))) {
    b.classList.toggle("ff-nav-active", b.getAttribute("data-view") === view);
    b.setAttribute("aria-selected", b.getAttribute("data-view") === view ? "true" : "false");
  }
  render();
}

function render(): void {
  const root = viewRoot();
  clear(root);
  switch (currentView) {
    case "scan":
      renderScanView(root);
      break;
    case "profile":
      renderProfileView(root);
      break;
    case "ledger":
      void renderLedgerView(root);
      break;
    case "settings":
      void renderSettingsView(root);
      break;
  }
}

// ---------------------------------------------------------------------------
// Scan view
// ---------------------------------------------------------------------------

function renderScanView(root: HTMLElement): void {
  const actions = el("div", { class: "ff-actions" }, [
    button("Scan this page", () => void doScan(), { class: "ff-btn ff-btn-primary" }),
  ]);
  root.append(actions);

  const guidance = el("div", {
    class: "ff-guidance",
    attrs: { id: "guidance", role: "status", "aria-live": "polite" },
    text:
      state.fields.length === 0
        ? "Click “Scan this page” to detect form fields. formfillm classifies fields using a local model and explains each requested disclosure before anything is filled."
        : `Found ${state.fields.length} field(s). Review each disclosure, then approve only what you want filled.`,
  });
  root.append(guidance);

  if (state.fields.length === 0) return;

  // Batch actions
  const batch = el("div", { class: "ff-actions" }, [
    button("Fill approved fields", () => void fillApproved(), { class: "ff-btn ff-btn-primary" }),
    button("Fill all low-sensitivity fields", () => previewLowSensitivity(), { class: "ff-btn" }),
  ]);
  root.append(batch);
  root.append(
    el("p", {
      class: "ff-note",
      text: "formfillm never submits forms. Review filled values before you submit.",
    }),
  );

  const list = el("div", { class: "ff-fields" });
  for (const f of state.fields) {
    const c = state.classifications.get(f.fieldId);
    if (c) list.append(renderFieldCard(f, c));
  }
  root.append(list);
}

function renderFieldCard(f: FieldMetadata, c: FieldClassification): HTMLElement {
  const decision = state.decisions.get(f.fieldId) ?? "pending";
  const card = el("div", { class: `ff-card ff-sens-${c.sensitivity}` });
  card.setAttribute("data-decision", decision);

  // Header: label + sensitivity badge
  const header = el("div", { class: "ff-card-head" }, [
    el("span", { class: "ff-card-label", text: labelFor(f) }),
    el("span", { class: `ff-badge ff-badge-${c.sensitivity}`, text: c.sensitivity }),
  ]);
  card.append(header);

  // Meta line
  const typeStr = f.inputType ? `${f.kind}/${f.inputType}` : f.kind;
  const meta = el("div", { class: "ff-card-meta" }, [
    el("span", { text: typeStr }),
    el("span", { text: f.required ? "required" : "optional" }),
    el("span", { text: c.category }),
    el("span", { text: `${Math.round(c.confidence * 100)}% conf.` }),
  ]);
  card.append(meta);

  card.append(el("p", { class: "ff-card-reason", text: c.plainLanguageReason }));
  if (c.possiblePurpose) {
    card.append(el("p", { class: "ff-card-purpose", text: `Possible purpose: ${c.possiblePurpose}` }));
  }
  card.append(el("p", { class: "ff-card-action", text: `Suggested: ${c.recommendedAction.replace(/_/g, " ")}` }));

  for (const w of c.warnings) {
    card.append(el("p", { class: "ff-card-warning", text: `⚠ ${w}` }));
  }

  // Value preview / availability
  if (!isFillable(c)) {
    card.append(el("p", { class: "ff-card-neverfill", text: "🔒 This field will never be filled by formfillm." }));
  } else {
    const value = resolveValue(c);
    if (value !== undefined) {
      card.append(
        el("p", { class: "ff-card-value", text: `Value to fill: ${maskValue(value, c.sensitivity)}` }),
      );
    } else {
      card.append(
        el("p", { class: "ff-card-value ff-muted", text: "No matching profile value — add one in Review profile, or use “Edit then fill”." }),
      );
    }
  }

  // Decision controls
  if (decision !== "pending") {
    card.append(el("p", { class: "ff-card-decision", text: `Your decision: ${decision.replace(/_/g, " ")}` }));
  }

  if (isFillable(c)) {
    const controls = el("div", { class: "ff-card-controls" });
    const hasValue = resolveValue(c) !== undefined;
    controls.append(
      button("Approve fill", () => setDecision(f.fieldId, "approved"), {
        class: "ff-btn ff-btn-sm" + (decision === "approved" ? " ff-btn-on" : ""),
        disabled: !hasValue,
      }),
    );
    controls.append(
      button("Edit then fill", () => promptEdit(f, c), {
        class: "ff-btn ff-btn-sm" + (decision === "edited" ? " ff-btn-on" : ""),
      }),
    );
    controls.append(
      button("Skip", () => setDecision(f.fieldId, "skipped"), {
        class: "ff-btn ff-btn-sm" + (decision === "skipped" ? " ff-btn-on" : ""),
      }),
    );
    controls.append(
      button("Mark wrong", () => setDecision(f.fieldId, "marked_wrong"), {
        class: "ff-btn ff-btn-sm" + (decision === "marked_wrong" ? " ff-btn-on" : ""),
      }),
    );
    card.append(controls);
  }

  // Highlight on hover/focus of the card.
  card.addEventListener("mouseenter", () => void highlight(f.fieldId));
  card.tabIndex = 0;
  card.addEventListener("focus", () => void highlight(f.fieldId));
  return card;
}

function setDecision(fieldId: string, decision: Decision): void {
  state.decisions.set(fieldId, decision);
  render();
}

function promptEdit(f: FieldMetadata, c: FieldClassification): void {
  const existing = state.editedValues.get(f.fieldId) ?? resolveValue(c) ?? "";
  const input = el("input", {
    class: "ff-edit-input",
    attrs: { type: "text", value: existing, "aria-label": `Value for ${labelFor(f)}` },
  }) as HTMLInputElement;
  input.value = existing;

  const wrap = el("div", { class: "ff-edit" }, [
    el("label", { class: "ff-edit-label", text: `Enter value for “${labelFor(f)}”:` }),
    input,
    el("div", { class: "ff-card-controls" }, [
      button("Save & approve", () => {
        state.editedValues.set(f.fieldId, input.value);
        state.decisions.set(f.fieldId, "edited");
        render();
      }, { class: "ff-btn ff-btn-sm ff-btn-primary" }),
      button("Cancel", () => render(), { class: "ff-btn ff-btn-sm" }),
    ]),
  ]);

  // Replace the card's controls area by re-rendering with an inline editor.
  const root = viewRoot();
  clear(root);
  renderScanView(root);
  root.append(wrap);
  input.focus();
}

async function highlight(fieldId: string | null): Promise<void> {
  if (state.tabId === null) return;
  await sendBg({ type: MSG.HighlightField, tabId: state.tabId, fieldId }).catch(() => undefined);
}

async function doScan(): Promise<void> {
  guidanceText("Scanning…");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  console.log("[formfillm:panel] active tab query →", { id: tab?.id, url: tab?.url, title: tab?.title });
  const tabId = tab?.id ?? null;
  if (tabId === null) {
    guidanceText("Could not find the active tab.");
    return;
  }
  state.tabId = tabId;
  console.log("[formfillm:panel] sending ScanPage for tabId", tabId);

  const scan = await sendBg<ScanPageResponse>({ type: MSG.ScanPage, tabId });
  if (!scan.ok || !scan.fields || !scan.page) {
    guidanceText(scan.error ?? "Scan failed.");
    return;
  }
  state.fields = scan.fields;
  state.page = scan.page;
  state.classifications = new Map();
  state.decisions = new Map();
  state.editedValues = new Map();

  guidanceText(`Found ${scan.fields.length} field(s). Classifying with the local model…`);
  render();

  const classify = await sendBg<ClassifyResponse>({
    type: MSG.Classify,
    fields: scan.fields,
    page: scan.page,
  });
  if (!classify.ok || !classify.classifications) {
    guidanceText(classify.error ?? "Classification failed. Fields default to manual review.");
    return;
  }
  for (const c of classify.classifications) state.classifications.set(c.fieldId, c);
  const errNote = classify.errors && classify.errors.length ? ` (${classify.errors.length} note(s))` : "";
  guidanceText(`Classified ${classify.classifications.length} field(s)${errNote}. Review and approve below.`);
  render();
}

interface LedgerPlan {
  fieldId: string;
  base: Omit<Parameters<typeof buildLedgerEntry>[0], "filled">;
  attempted: boolean;
}

function buildApprovedFills(): { fills: FillInstruction[]; plans: LedgerPlan[] } {
  const fills: FillInstruction[] = [];
  const plans: LedgerPlan[] = [];
  const now = Date.now();
  const origin = state.page?.origin ?? "unknown";
  const title = state.page?.title ?? null;

  for (const f of state.fields) {
    const c = state.classifications.get(f.fieldId);
    if (!c) continue;
    const decision = state.decisions.get(f.fieldId) ?? "pending";
    const fillable = isFillable(c);

    let attempted = false;
    if ((decision === "approved" || decision === "edited") && fillable) {
      const value = resolveValue(c);
      if (value !== undefined) {
        fills.push({ fieldId: f.fieldId, value });
        attempted = true;
      }
    }

    // Record a ledger plan for any field with a non-pending decision, plus
    // secrets (recorded as never_fill) so the ledger reflects what was seen.
    const ledgerDecision =
      !fillable ? "never_fill" :
      decision === "approved" ? "approved" :
      decision === "edited" ? "edited" :
      decision === "skipped" ? "skipped" :
      decision === "marked_wrong" ? "marked_wrong" :
      null;

    if (ledgerDecision) {
      plans.push({
        fieldId: f.fieldId,
        attempted,
        base: {
          timestamp: now,
          siteOrigin: origin,
          pageTitle: title,
          fieldLabel: labelFor(f),
          category: c.category,
          sensitivity: c.sensitivity,
          decision: ledgerDecision,
        },
      });
    }
  }
  return { fills, plans };
}

async function fillApproved(): Promise<void> {
  if (state.tabId === null) {
    guidanceText("Scan a page first.");
    return;
  }
  const { fills, plans } = buildApprovedFills();

  const commitLedger = async (filledIds: Set<string>) => {
    const entries: LedgerEntry[] = plans.map((p) =>
      buildLedgerEntry({ ...p.base, filled: p.attempted && filledIds.has(p.fieldId) }),
    );
    if (entries.length) await appendLedger(entries);
  };

  if (fills.length === 0) {
    await commitLedger(new Set());
    guidanceText("No approved fields with available values to fill.");
    return;
  }

  guidanceText(`Filling ${fills.length} approved field(s)…`);
  const res = await sendBg<ApplyFillResponse>({ type: MSG.ApplyFill, tabId: state.tabId, fills });

  const filledIds = new Set((res.results ?? []).filter((r) => r.filled).map((r) => r.fieldId));
  await commitLedger(filledIds);

  if (!res.ok) {
    guidanceText(res.error ?? "Fill failed.");
    return;
  }
  const ok = filledIds.size;
  const fail = (res.results ?? []).length - ok;
  guidanceText(
    `Filled ${ok} field(s)${fail ? `, ${fail} could not be filled` : ""}. Review before submitting. (Recorded in ledger; no values stored.)`,
  );
}

function previewLowSensitivity(): void {
  const candidates = state.fields.filter((f) => {
    const c = state.classifications.get(f.fieldId);
    return c && isLowSensitivityBatchable(c) && resolveValue(c) !== undefined;
  });

  const root = viewRoot();
  clear(root);
  renderScanView(root);

  if (candidates.length === 0) {
    guidanceText("No low-sensitivity fields with available values to fill.");
    return;
  }

  const list = el("div", { class: "ff-preview" }, [
    el("h3", { text: "These low-sensitivity fields will be filled:" }),
  ]);
  for (const f of candidates) {
    const c = state.classifications.get(f.fieldId)!;
    list.append(
      el("div", { class: "ff-preview-row" }, [
        el("span", { text: labelFor(f) }),
        el("span", { class: "ff-muted", text: resolveValue(c) ?? "" }),
      ]),
    );
  }
  list.append(
    el("div", { class: "ff-card-controls" }, [
      button("Confirm & fill", () => {
        for (const f of candidates) state.decisions.set(f.fieldId, "approved");
        void fillApproved();
      }, { class: "ff-btn ff-btn-sm ff-btn-primary" }),
      button("Cancel", () => render(), { class: "ff-btn ff-btn-sm" }),
    ]),
  );
  root.append(list);
}

// ---------------------------------------------------------------------------
// Profile view
// ---------------------------------------------------------------------------

function renderProfileView(root: HTMLElement): void {
  root.append(el("h2", { text: "Profile (local only)" }));
  root.append(
    el("p", {
      class: "ff-warning-box",
      text: "⚠ This MVP does not yet encrypt profile data at rest. Do not store secrets (passwords, SIN/SSN, banking, 2FA). Stored only in this browser via chrome.storage.local.",
    }),
  );

  const form = el("div", { class: "ff-profile-form" });
  const inputs = new Map<string, HTMLInputElement>();

  for (const key of PROFILE_KEYS) {
    const input = el("input", { class: "ff-input", attrs: { type: "text", id: `pf-${key}` } }) as HTMLInputElement;
    input.value = profile.values[key] ?? "";
    inputs.set(key, input);
    form.append(
      el("label", { class: "ff-field-row" }, [
        el("span", { class: "ff-field-key", text: key }),
        input,
      ]),
    );
  }
  root.append(form);

  // Custom key/value pairs (anything not in PROFILE_KEYS).
  const customWrap = el("div", { class: "ff-custom" }, [el("h3", { text: "Custom fields" })]);
  const customRows = el("div", {});
  const customEntries = Object.entries(profile.values).filter(
    ([k]) => !(PROFILE_KEYS as readonly string[]).includes(k),
  );
  const customState = new Map<string, { keyEl: HTMLInputElement; valEl: HTMLInputElement }>();

  const addCustomRow = (k = "", v = "") => {
    const keyEl = el("input", { class: "ff-input ff-input-key", attrs: { type: "text", placeholder: "key" } }) as HTMLInputElement;
    const valEl = el("input", { class: "ff-input", attrs: { type: "text", placeholder: "value" } }) as HTMLInputElement;
    keyEl.value = k;
    valEl.value = v;
    const rowId = `custom-${customState.size}-${k}`;
    customState.set(rowId, { keyEl, valEl });
    customRows.append(el("div", { class: "ff-field-row" }, [keyEl, valEl]));
  };
  for (const [k, v] of customEntries) addCustomRow(k, v);
  customWrap.append(customRows);
  customWrap.append(button("Add custom field", () => addCustomRow(), { class: "ff-btn ff-btn-sm" }));
  root.append(customWrap);

  const save = async () => {
    const values: Record<string, string> = {};
    for (const [key, input] of inputs) {
      if (input.value.trim()) values[key] = input.value.trim();
    }
    for (const { keyEl, valEl } of customState.values()) {
      const k = keyEl.value.trim();
      if (k && valEl.value.trim()) values[k] = valEl.value.trim();
    }
    profile = { values };
    await saveProfile(profile);
    if (currentView === "scan") render();
    flash("Profile saved locally.");
  };

  root.append(
    el("div", { class: "ff-actions" }, [
      button("Save profile", () => void save(), { class: "ff-btn ff-btn-primary" }),
      button("Create demo profile", () => {
        profile = demoProfile();
        void saveProfile(profile).then(() => {
          render();
          flash("Demo profile created (fake values).");
        });
      }, { class: "ff-btn" }),
      button("Clear profile", () => {
        profile = { values: {} };
        void saveProfile(profile).then(() => {
          render();
          flash("Profile cleared.");
        });
      }, { class: "ff-btn ff-btn-danger" }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Ledger view
// ---------------------------------------------------------------------------

async function renderLedgerView(root: HTMLElement): Promise<void> {
  root.append(el("h2", { text: "Disclosure ledger" }));
  root.append(
    el("p", {
      class: "ff-note",
      text: "Records categories and your decisions only. Actual values are never stored (valueStored is always false).",
    }),
  );
  const entries = await getLedger();
  if (entries.length === 0) {
    root.append(el("p", { class: "ff-muted", text: "No entries yet." }));
    return;
  }

  root.append(
    el("div", { class: "ff-actions" }, [
      button("Clear ledger", () => {
        void clearLedger().then(() => {
          render();
          flash("Ledger cleared.");
        });
      }, { class: "ff-btn ff-btn-danger" }),
    ]),
  );

  const list = el("div", { class: "ff-ledger" });
  for (const e of [...entries].reverse()) {
    list.append(renderLedgerEntry(e));
  }
  root.append(list);
}

function renderLedgerEntry(e: LedgerEntry): HTMLElement {
  const date = new Date(e.timestamp).toLocaleString();
  return el("div", { class: "ff-ledger-row" }, [
    el("div", { class: "ff-ledger-top" }, [
      el("span", { class: "ff-ledger-label", text: e.fieldLabel }),
      el("span", { class: `ff-badge ff-badge-${e.sensitivity}`, text: e.sensitivity }),
    ]),
    el("div", { class: "ff-ledger-meta" }, [
      el("span", { text: e.category }),
      el("span", { text: e.decision.replace(/_/g, " ") }),
      el("span", { text: e.filled ? "filled" : "not filled" }),
    ]),
    el("div", { class: "ff-ledger-sub", text: `${e.siteOrigin} · ${date}` }),
  ]);
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

async function renderSettingsView(root: HTMLElement): Promise<void> {
  root.append(el("h2", { text: "Settings" }));

  const urlInput = el("input", { class: "ff-input", attrs: { type: "text", id: "set-url" } }) as HTMLInputElement;
  urlInput.value = settings.ollamaBaseUrl;
  const modelInput = el("input", { class: "ff-input", attrs: { type: "text", id: "set-model" } }) as HTMLInputElement;
  modelInput.value = settings.model;
  const tempInput = el("input", { class: "ff-input", attrs: { type: "number", id: "set-temp", min: "0", max: "2", step: "0.1" } }) as HTMLInputElement;
  tempInput.value = String(settings.temperature);

  const fieldRow = (labelText: string, input: HTMLElement, hint?: string) =>
    el("div", { class: "ff-set-field" }, [
      el("label", { class: "ff-set-label", text: labelText }),
      input,
      ...(hint ? [el("p", { class: "ff-note", text: hint })] : []),
    ]);

  root.append(fieldRow("Ollama base URL", urlInput, "Local only: 127.0.0.1, localhost, or [::1] on port 11434."));

  const modelWarning = el("p", { class: "ff-card-warning" });
  const refreshModelWarning = () => {
    const a = assessModel(modelInput.value.trim());
    if (a.cloudRejected) {
      modelWarning.textContent = `⛔ ${a.cloudReason}`;
      modelWarning.className = "ff-card-warning ff-err";
    } else if (a.warning) {
      modelWarning.textContent = `⚠ ${a.warning}`;
      modelWarning.className = "ff-card-warning";
    } else if (a.fit === "recommended") {
      modelWarning.textContent = `✓ Recommended for this machine (RTX 4060, 8 GB).`;
      modelWarning.className = "ff-card-warning ff-ok";
    } else {
      modelWarning.textContent = "";
    }
  };
  modelInput.addEventListener("input", refreshModelWarning);
  root.append(fieldRow("Model", modelInput));
  root.append(modelWarning);
  refreshModelWarning();

  root.append(fieldRow("Temperature", tempInput, "0 is recommended for consistent classification."));

  // Local-only toggle (locked on)
  const localToggle = el("input", { attrs: { type: "checkbox", id: "set-local" } }) as HTMLInputElement;
  localToggle.checked = true;
  localToggle.disabled = true;
  root.append(
    el("div", { class: "ff-set-field" }, [
      el("label", { class: "ff-checkbox-row" }, [localToggle, el("span", { text: " Local-only enforcement (locked on for this MVP)" })]),
    ]),
  );

  // JSON schema mode toggle
  const schemaToggle = el("input", { attrs: { type: "checkbox", id: "set-schema" } }) as HTMLInputElement;
  schemaToggle.checked = settings.jsonSchemaMode;
  root.append(
    el("div", { class: "ff-set-field" }, [
      el("label", { class: "ff-checkbox-row" }, [schemaToggle, el("span", { text: " Use JSON-schema constrained output when supported" })]),
    ]),
  );

  // Recommended / fallback models reference
  const ref = el("div", { class: "ff-models-ref" }, [
    el("h3", { text: "Recommended models" }),
    el("p", { class: "ff-note", text: `Recommended (RTX 4060, 8 GB): ${RECOMMENDED_MODEL}` }),
    el("pre", { class: "ff-cmd", text: `ollama pull ${RECOMMENDED_MODEL}` }),
    el("p", { class: "ff-note", text: "Fallbacks:" }),
    el("pre", { class: "ff-cmd", text: FALLBACK_MODELS.map((m) => `ollama pull ${m}`).join("\n") }),
    el("p", { class: "ff-note", text: "Not recommended for this machine: qwen3.5:27b, qwen3.5:35b, qwen3.5:122b (likely slow / CPU-offloaded)." }),
  ]);
  root.append(ref);

  // Test connection + model list
  const testResult = el("div", { class: "ff-test-result", attrs: { role: "status", "aria-live": "polite" } });
  const doTest = async () => {
    testResult.textContent = "Testing…";
    clear(testResult);
    testResult.append(el("p", { text: "Testing…" }));
    const res = await sendBg<TestOllamaResponse>({ type: MSG.TestOllama });
    clear(testResult);
    if (!res.reachable) {
      testResult.append(el("p", { class: "ff-err", text: `Unreachable: ${res.error ?? "unknown error"}` }));
      return;
    }
    testResult.append(el("p", { class: "ff-ok", text: "Ollama reachable." }));
    const models = res.models ?? [];
    if (!models.includes(RECOMMENDED_MODEL)) {
      testResult.append(el("p", { class: "ff-card-warning", text: `Recommended model ${RECOMMENDED_MODEL} not installed. Run:` }));
      testResult.append(el("pre", { class: "ff-cmd", text: `ollama pull ${RECOMMENDED_MODEL}` }));
    }
    if (models.length) {
      testResult.append(el("h3", { text: "Installed models (click to select)" }));
      const ul = el("div", { class: "ff-model-list" });
      for (const m of models) {
        const a = assessModel(m);
        const bt = button(m + (a.fit === "large" ? "  (large)" : ""), () => {
          modelInput.value = m;
          refreshModelWarning();
        }, { class: "ff-btn ff-btn-sm" + (m === modelInput.value ? " ff-btn-on" : "") });
        ul.append(bt);
      }
      testResult.append(ul);
    }
  };
  root.append(
    el("div", { class: "ff-actions" }, [button("Test Ollama connection", () => void doTest(), { class: "ff-btn" })]),
  );
  root.append(testResult);

  // Save
  const saveError = el("p", { class: "ff-err" });
  const save = async () => {
    saveError.textContent = "";
    const url = validateOllamaUrl(urlInput.value.trim());
    if (!url.ok) {
      saveError.textContent = url.reason;
      return;
    }
    const model = validateModelName(modelInput.value.trim());
    if (!model.ok) {
      saveError.textContent = model.reason;
      return;
    }
    let temp = Number(tempInput.value);
    if (!Number.isFinite(temp) || temp < 0) temp = 0;
    settings = {
      ollamaBaseUrl: url.normalized,
      model: modelInput.value.trim(),
      temperature: temp,
      localOnly: true,
      jsonSchemaMode: schemaToggle.checked,
    };
    await saveSettings(settings);
    await refreshStatus();
    flash("Settings saved.");
  };
  root.append(
    el("div", { class: "ff-actions" }, [button("Save settings", () => void save(), { class: "ff-btn ff-btn-primary" })]),
  );
  root.append(saveError);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function flash(message: string): void {
  const f = document.getElementById("flash");
  if (!f) return;
  f.textContent = message;
  f.classList.add("ff-flash-show");
  window.setTimeout(() => f.classList.remove("ff-flash-show"), 2500);
}

function wireNav(): void {
  for (const b of Array.from(document.querySelectorAll(".ff-nav-btn"))) {
    b.addEventListener("click", () => setView(b.getAttribute("data-view") as View));
  }
}

async function main(): Promise<void> {
  settings = await getSettings();
  profile = await getProfile();
  state.tabId = await activeTabId();
  wireNav();
  await refreshStatus();
  setView("scan");
}

void main();
