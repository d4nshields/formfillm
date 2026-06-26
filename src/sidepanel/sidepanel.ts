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
  parseMessage,
  type ApplyFillResponse,
  type ClassifyResponse,
  type FillInstruction,
  type PageContext,
  type ParsePasswordPolicyResponse,
  type PasswordContextResponse,
  type ScanPageResponse,
  type TestOllamaResponse,
} from "../shared/messages.js";
import type { FieldClassification, FieldMetadata, LedgerEntry, Profile, Settings } from "../shared/types.js";
import { PROFILE_KEYS } from "../shared/types.js";
import {
  assessModel,
  assessVramFit,
  FALLBACK_MODELS,
  RECOMMENDED_MODEL,
  validateModelName,
  validateOllamaUrl,
} from "../shared/ollama-policy.js";
import {
  DEFAULT_PASSWORD_POLICY,
  generatePassword,
  type PasswordPolicy,
} from "../shared/password.js";
import { isFillable } from "../shared/sensitivity.js";
import { debugLog } from "../shared/debug-consts.js";
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
type Decision = "pending" | "approved" | "edited" | "skipped" | "marked_wrong" | "generated";
type ScanStage = "idle" | "guided" | "summary";

interface ReviewState {
  tabId: number | null;
  page: PageContext | null;
  fields: FieldMetadata[];
  classifications: Map<string, FieldClassification>;
  decisions: Map<string, Decision>;
  editedValues: Map<string, string>;
  /** Per-field fill outcome, recorded as each field is approved. */
  fillResults: Map<string, boolean>;
  /** Generated passwords held in memory only (never stored), keyed by field id. */
  generatedPasswords: Map<string, string>;
  /** Field id currently generating a password, or null. */
  generating: string | null;
  /** Guided wizard: which field index we are on, and the overall stage. */
  stage: ScanStage;
  guidedIndex: number;
  /** Inline editor open for this field id (guided step), or null. */
  editing: string | null;
  /** Whether this session's decisions have been written to the ledger. */
  ledgerCommitted: boolean;
}

const state: ReviewState = {
  tabId: null,
  page: null,
  fields: [],
  classifications: new Map(),
  decisions: new Map(),
  editedValues: new Map(),
  fillResults: new Map(),
  generatedPasswords: new Map(),
  generating: null,
  stage: "idle",
  guidedIndex: 0,
  editing: null,
  ledgerCommitted: false,
};

let settings: Settings;
let profile: Profile;
let currentView: View = "scan";
/** When set, the scan view shows a "page changed — re-scan" prompt. */
let pageChangedNotice: string | null = null;
/** Last scan/classify failure, shown in the intro so it survives re-render. */
let scanError: string | null = null;

const viewRoot = () => document.getElementById("view") as HTMLElement;
const statusRoot = () => document.getElementById("status") as HTMLElement;

/** Show the blocking busy overlay (grays out + blocks input) with a message. */
function showBusy(message: string, sub?: string): void {
  const busy = document.getElementById("busy");
  const msg = document.getElementById("busy-msg");
  const subEl = document.querySelector(".ff-busy-sub");
  if (msg) msg.textContent = message;
  if (subEl && sub !== undefined) subEl.textContent = sub;
  if (busy) busy.hidden = false;
}

function hideBusy(): void {
  const busy = document.getElementById("busy");
  if (busy) busy.hidden = true;
}

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

// The scan view is a guided, one-field-at-a-time wizard aimed at users who
// want hand-holding: it walks through each detected field, explains it in
// plain language, and fills each one immediately when the user approves.
function renderScanView(root: HTMLElement): void {
  if (state.fields.length === 0 || state.stage === "idle") {
    renderIntro(root);
    // Stale-scan modal sits on top of the (reset) intro.
    if (pageChangedNotice) renderPageChangedModal(root);
    return;
  }
  if (state.stage === "summary") {
    renderSummary(root);
    return;
  }
  renderGuidedStep(root);
}

function renderIntro(root: HTMLElement): void {
  const hasError = scanError !== null;
  root.append(
    el("div", { class: "ff-actions" }, [
      button(hasError ? "Try again" : "Scan this page", () => void doScan(), { class: "ff-btn ff-btn-primary" }),
    ]),
  );
  root.append(
    el("div", {
      class: "ff-guidance" + (hasError ? " ff-guidance-error" : ""),
      attrs: { id: "guidance", role: hasError ? "alert" : "status", "aria-live": "polite" },
      text: hasError
        ? (scanError ?? "")
        : "Click “Scan this page”. formfillm looks at the form, then walks you through each thing it asks for — one at a time — and explains it before anything is filled.",
    }),
  );
}

/**
 * Modal shown over the Form Guidance view after the bound page reloaded or
 * navigated: the prior scan is stale, so we block it with a simple "page
 * changed" prompt whose only action is to re-scan the current form.
 */
function renderPageChangedModal(root: HTMLElement): void {
  root.append(
    el(
      "div",
      { class: "ff-modal", attrs: { role: "alertdialog", "aria-modal": "true", "aria-label": "Page changed" } },
      [
        el("div", { class: "ff-modal-card" }, [
          el("h2", { class: "ff-modal-title", text: "Page changed" }),
          el("p", { class: "ff-modal-sub", text: "This scan is out of date. Re-scan to review the current form." }),
          el("div", { class: "ff-modal-actions" }, [
            button("Rescan", () => void doScan(), { class: "ff-btn ff-btn-primary" }),
          ]),
        ]),
      ],
    ),
  );
}

const SENSITIVITY_HELP: Record<string, string> = {
  low: "Low sensitivity — generally safe to share.",
  medium: "Personal info — share only with sites you trust.",
  high: "Sensitive personal info — be careful, and only share if you really trust this site.",
  secret: "Secret — formfillm will never fill this. If the site truly needs it, type it in yourself.",
  unknown: "Unclear — take a careful look before deciding.",
};

function siteHost(): string {
  const origin = state.page?.origin ?? "";
  try {
    return new URL(origin).host || origin || "this site";
  } catch {
    return origin || "this site";
  }
}

function progressDots(total: number, index: number): HTMLElement {
  const wrap = el("div", { class: "ff-progress", attrs: { "aria-hidden": "true" } });
  for (let i = 0; i < total; i++) {
    const cls = i < index ? " ff-dot-done" : i === index ? " ff-dot-current" : "";
    wrap.append(el("span", { class: "ff-dot" + cls }));
  }
  return wrap;
}

function navRow(idx: number, total: number): HTMLElement {
  const row = el("div", { class: "ff-nav-row" });
  row.append(button("‹ Back", () => goBack(), { class: "ff-btn ff-btn-sm", disabled: idx === 0 }));
  row.append(
    button(idx === total - 1 ? "Finish ›" : "Next ›", () => advance(), { class: "ff-btn ff-btn-sm" }),
  );
  return row;
}

function renderGuidedStep(root: HTMLElement): void {
  const total = state.fields.length;
  const idx = Math.min(state.guidedIndex, total - 1);
  const field = state.fields[idx]!;
  const c = state.classifications.get(field.fieldId);
  void highlight(field.fieldId); // scroll to + outline the field on the page

  root.append(
    el("div", { class: "ff-guided-head" }, [
      el("span", { class: "ff-step-count", text: `Field ${idx + 1} of ${total}` }),
      button("Scan again", () => void doScan(), { class: "ff-btn ff-btn-sm" }),
    ]),
  );
  root.append(progressDots(total, idx));

  if (!c) {
    root.append(el("p", { class: "ff-card-warning", text: "This field could not be classified — please review it manually." }));
    root.append(navRow(idx, total));
    return;
  }

  const card = el("div", { class: `ff-card ff-guided ff-sens-${c.sensitivity}` });
  card.append(
    el("div", { class: "ff-card-head" }, [
      el("span", { class: "ff-card-label", text: labelFor(field) }),
      el("span", { class: `ff-badge ff-badge-${c.sensitivity}`, text: c.sensitivity }),
    ]),
  );
  card.append(el("p", { class: "ff-card-reason", text: c.plainLanguageReason }));
  if (c.possiblePurpose) {
    card.append(el("p", { class: "ff-card-purpose", text: `Why a site might ask: ${c.possiblePurpose}` }));
  }
  card.append(el("p", { class: "ff-sens-help", text: SENSITIVITY_HELP[c.sensitivity] ?? "" }));
  for (const w of c.warnings) card.append(el("p", { class: "ff-card-warning", text: `⚠ ${w}` }));

  const decided = state.decisions.get(field.fieldId);
  const filled = state.fillResults.get(field.fieldId);

  const isPassword = (field.inputType ?? "").toLowerCase() === "password";
  // Only offer generation for new/registration passwords, not login fields.
  const isLoginPassword = isPassword && (field.autocomplete ?? "").toLowerCase().includes("current-password");

  if (isPassword && !isLoginPassword) {
    renderPasswordStep(card, field);
  } else if (!isFillable(c)) {
    card.append(el("p", { class: "ff-card-neverfill", text: "🔒 formfillm will not fill this field." }));
    card.append(
      el("div", { class: "ff-card-controls" }, [
        button("OK, next", () => advance(), { class: "ff-btn ff-btn-primary ff-btn-sm" }),
      ]),
    );
  } else if (state.editing === field.fieldId) {
    const existing = state.editedValues.get(field.fieldId) ?? resolveValue(c) ?? "";
    const input = el("input", {
      class: "ff-input",
      attrs: { type: "text", "aria-label": `Value for ${labelFor(field)}` },
    }) as HTMLInputElement;
    input.value = existing;
    card.append(el("label", { class: "ff-edit-label", text: "Type the value to fill:" }));
    card.append(input);
    card.append(
      el("div", { class: "ff-card-controls" }, [
        button("Save & fill", () => void saveEditAndFill(field, input.value), { class: "ff-btn ff-btn-primary ff-btn-sm" }),
        button("Cancel", () => {
          state.editing = null;
          render();
        }, { class: "ff-btn ff-btn-sm" }),
      ]),
    );
    window.setTimeout(() => input.focus(), 0);
  } else {
    const value = resolveValue(c);
    if (value !== undefined) {
      card.append(el("p", { class: "ff-card-value", text: `What we'd fill: ${maskValue(value, c.sensitivity)}` }));
    } else {
      card.append(el("p", { class: "ff-card-value ff-muted", text: "No saved value for this. Use “Type it in” to enter one, or skip." }));
    }
    if (decided) {
      const note =
        decided === "skipped" ? "You skipped this." :
        decided === "marked_wrong" ? "You flagged this as wrong." :
        filled ? "✓ Filled on the page." : "Approved (could not fill).";
      card.append(el("p", { class: "ff-card-decision", text: note }));
    }
    card.append(el("p", { class: "ff-card-question", text: `Share this with ${siteHost()}?` }));

    const controls = el("div", { class: "ff-card-controls" });
    controls.append(
      button(value !== undefined ? "Yes, fill it" : "Type it in", () => {
        if (value !== undefined) void guidedApprove(field, c);
        else {
          state.editing = field.fieldId;
          render();
        }
      }, { class: "ff-btn ff-btn-primary ff-btn-sm" }),
    );
    if (value !== undefined) {
      controls.append(button("Edit", () => {
        state.editing = field.fieldId;
        render();
      }, { class: "ff-btn ff-btn-sm" }));
    }
    controls.append(button("Skip", () => guidedDecision(field, "skipped"), { class: "ff-btn ff-btn-sm" }));
    controls.append(button("This looks wrong", () => guidedDecision(field, "marked_wrong"), { class: "ff-btn ff-btn-sm" }));
    card.append(controls);
  }

  root.append(card);
  root.append(navRow(idx, total));
}

/** Profile-derived substrings a generated password must not contain. */
function passwordAvoidList(): string[] {
  const v = profile.values;
  const out: string[] = [];
  for (const k of ["identity.first_name", "identity.last_name", "identity.full_name", "contact.email"]) {
    const val = v[k];
    if (typeof val === "string" && val.trim()) out.push(val.trim());
  }
  const email = v["contact.email"];
  if (typeof email === "string" && email.includes("@")) out.push(email.split("@")[0]!);
  return out;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash("Password copied to clipboard.");
  } catch {
    flash("Could not copy — select and copy it manually.");
  }
}

/** Render the password step: either the generate prompt or the generated result. */
function renderPasswordStep(card: HTMLElement, field: FieldMetadata): void {
  card.append(
    el("p", {
      class: "ff-pw-intro",
      text: "formfillm never stores passwords. It can generate a strong one that meets this site's rules, fill it here, and you save it in your password manager.",
    }),
  );

  const generated = state.generatedPasswords.get(field.fieldId);

  if (state.generating === field.fieldId) {
    card.append(el("p", { class: "ff-card-decision", text: "Generating a strong password…" }));
    return;
  }

  if (generated) {
    card.append(
      el("div", { class: "ff-pw-result" }, [
        el("code", { class: "ff-pw-value", text: generated }),
      ]),
    );
    card.append(
      el("p", {
        class: "ff-card-warning",
        text: "✓ Filled. Save this in your password manager NOW. When you submit the form, your browser or manager should offer to save it — formfillm does not keep it.",
      }),
    );
    card.append(
      el("div", { class: "ff-card-controls" }, [
        button("Copy password", () => void copyText(generated), { class: "ff-btn ff-btn-sm" }),
        button("Regenerate", () => void generatePasswordFor(field), { class: "ff-btn ff-btn-sm" }),
        button("Next ›", () => advance(), { class: "ff-btn ff-btn-primary ff-btn-sm" }),
      ]),
    );
    return;
  }

  card.append(el("p", { class: "ff-card-question", text: `Create a strong password for ${siteHost()}?` }));
  card.append(
    el("div", { class: "ff-card-controls" }, [
      button("Generate strong password", () => void generatePasswordFor(field), { class: "ff-btn ff-btn-primary ff-btn-sm" }),
      button("Skip", () => guidedDecision(field, "skipped"), { class: "ff-btn ff-btn-sm" }),
    ]),
  );
}

async function generatePasswordFor(field: FieldMetadata): Promise<void> {
  if (state.tabId === null) {
    flash("Scan a page first.");
    return;
  }
  state.generating = field.fieldId;
  showBusy("Generating a strong password…", "Reading this site's rules with your local model.");
  try {
    // 1) Read live constraints + policy text from the page.
    const ctxRes = await sendBg<PasswordContextResponse>({
      type: MSG.PasswordContext,
      tabId: state.tabId,
      fieldId: field.fieldId,
    }).catch(() => ({ ok: false }) as PasswordContextResponse);
    const context = ctxRes.context ?? {
      fieldId: field.fieldId,
      minLength: null,
      maxLength: null,
      pattern: null,
      policyText: null,
      confirmFieldId: null,
    };

    // 2) Extract a structured policy (local LLM, fail-closed to attributes).
    const polRes = await sendBg<ParsePasswordPolicyResponse>({
      type: MSG.ParsePasswordPolicy,
      context,
    }).catch(() => ({ ok: false }) as ParsePasswordPolicyResponse);
    const policy = (polRes.policy as PasswordPolicy | undefined) ?? DEFAULT_PASSWORD_POLICY;

    // 3) Generate locally, avoiding the user's name/email.
    const { password } = generatePassword(policy, passwordAvoidList());

    // 4) Fill the password field (and a confirm field, if any).
    const fills: FillInstruction[] = [{ fieldId: field.fieldId, value: password, allowSecret: true }];
    if (context.confirmFieldId) {
      fills.push({ fieldId: context.confirmFieldId, value: password, allowSecret: true });
    }
    const fillRes = await sendBg<ApplyFillResponse>({ type: MSG.ApplyFill, tabId: state.tabId, fills }).catch(
      () => ({ ok: false }) as ApplyFillResponse,
    );
    const filled = Boolean(fillRes.results?.some((r) => r.fieldId === field.fieldId && r.filled));

    // 5) Record (in memory only) — never persisted.
    state.generatedPasswords.set(field.fieldId, password);
    state.decisions.set(field.fieldId, "generated");
    state.fillResults.set(field.fieldId, filled);
    if (context.confirmFieldId) {
      state.generatedPasswords.set(context.confirmFieldId, password);
      state.decisions.set(context.confirmFieldId, "generated");
      state.fillResults.set(
        context.confirmFieldId,
        Boolean(fillRes.results?.some((r) => r.fieldId === context.confirmFieldId && r.filled)),
      );
    }
  } finally {
    state.generating = null;
    hideBusy();
    render();
  }
}

async function fillCurrentField(field: FieldMetadata, value: string): Promise<boolean> {
  if (state.tabId === null) return false;
  const fills: FillInstruction[] = [{ fieldId: field.fieldId, value }];
  const res = await sendBg<ApplyFillResponse>({ type: MSG.ApplyFill, tabId: state.tabId, fills });
  return Boolean(res.results?.some((r) => r.fieldId === field.fieldId && r.filled));
}

async function guidedApprove(field: FieldMetadata, c: FieldClassification): Promise<void> {
  state.decisions.set(field.fieldId, "approved");
  const value = resolveValue(c);
  if (value !== undefined) {
    state.fillResults.set(field.fieldId, await fillCurrentField(field, value));
  }
  advance();
}

async function saveEditAndFill(field: FieldMetadata, value: string): Promise<void> {
  state.editing = null;
  if (value.trim() === "") {
    guidedDecision(field, "skipped");
    return;
  }
  state.editedValues.set(field.fieldId, value);
  state.decisions.set(field.fieldId, "edited");
  state.fillResults.set(field.fieldId, await fillCurrentField(field, value));
  advance();
}

function guidedDecision(field: FieldMetadata, decision: Decision): void {
  state.decisions.set(field.fieldId, decision);
  state.editing = null;
  advance();
}

function advance(): void {
  state.editing = null;
  if (state.guidedIndex < state.fields.length - 1) {
    state.guidedIndex++;
    render();
  } else {
    state.stage = "summary";
    void commitSessionLedger().finally(() => render());
  }
}

function goBack(): void {
  state.editing = null;
  if (state.guidedIndex > 0) state.guidedIndex--;
  render();
}

async function highlight(fieldId: string | null): Promise<void> {
  if (state.tabId === null) return;
  await sendBg({ type: MSG.HighlightField, tabId: state.tabId, fieldId }).catch(() => undefined);
}

/** Clear all per-scan session state back to the idle intro. */
function resetScanSession(): void {
  state.fields = [];
  state.classifications = new Map();
  state.decisions = new Map();
  state.editedValues = new Map();
  state.fillResults = new Map();
  state.generatedPasswords = new Map();
  state.generating = null;
  state.editing = null;
  state.ledgerCommitted = false;
  state.guidedIndex = 0;
  state.stage = "idle";
  scanError = null;
}

/**
 * The bound tab reloaded or navigated, so the scanned fields no longer match
 * what's on screen. Preserve any decisions already made in the ledger, then
 * reset and prompt a re-scan. Element refs in the page are gone after a load,
 * so keeping the old fields would only mislead.
 */
async function handlePageChanged(reason: string): Promise<void> {
  if (state.fields.length === 0 && state.stage === "idle") return; // nothing to invalidate
  debugLog("panel", "bound page changed — invalidating scan", { reason, tabId: state.tabId });
  // Best-effort: record what the user actually decided before they left.
  if (state.decisions.size > 0) {
    try {
      await commitSessionLedger();
    } catch {
      /* ledger is best-effort here */
    }
  }
  resetScanSession();
  state.page = null;
  pageChangedNotice = "stale"; // flag; the modal renders its own copy
  if (currentView === "scan") render();
}

/** Invalidate the scan when the bound tab reloads or navigates (incl. SPA). */
function wirePageChangeReset(): void {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.tabId) return;
    // status "loading" = full reload/navigation (URL may be unchanged);
    // changeInfo.url = SPA/hash sub-page navigation without a reload.
    if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
      void handlePageChanged(changeInfo.url ? `url:${changeInfo.url}` : "reload");
    }
  });
}

async function doScan(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  debugLog("panel", "active tab query →", { id: tab?.id, url: tab?.url, title: tab?.title });
  const tabId = tab?.id ?? null;

  // Reset session state and show the intro so status/errors have a home.
  state.tabId = tabId;
  pageChangedNotice = null;
  resetScanSession();
  render();

  if (tabId === null) {
    scanError = "Could not find the active tab.";
    render();
    return;
  }
  debugLog("panel", "sending ScanPage for tabId", tabId);

  showBusy("Scanning the page…", "Looking for form fields.");
  try {
    const scan = await sendBg<ScanPageResponse>({ type: MSG.ScanPage, tabId });
    // If the page changed mid-scan, the modal owns the view — don't fight it.
    if (pageChangedNotice !== null || state.tabId !== tabId) return;
    if (!scan.ok || !scan.fields || !scan.page) {
      scanError = scan.error ?? "Scan failed.";
      return;
    }
    state.fields = scan.fields;
    state.page = scan.page;

    showBusy(
      `Reading ${scan.fields.length} field(s) with your local model…`,
      "This can take several seconds depending on your hardware.",
    );
    const classify = await sendBg<ClassifyResponse>({
      type: MSG.Classify,
      fields: scan.fields,
      page: scan.page,
    });
    if (pageChangedNotice !== null || state.tabId !== tabId) return;
    if (!classify.ok || !classify.classifications) {
      scanError = classify.error ?? "The local model could not classify this form. Check that Ollama is running and reachable (Settings → Test Ollama connection), then try again.";
      debugLog("panel", "classify failed", { error: classify.error, errors: classify.errors });
      return;
    }
    for (const c of classify.classifications) state.classifications.set(c.fieldId, c);
    // Enter the guided wizard at the first field.
    state.stage = "guided";
    state.guidedIndex = 0;
    if (classify.errors?.length) debugLog("panel", "classify warnings", classify.errors);
  } catch (e) {
    scanError = e instanceof Error ? e.message : "Something went wrong during scan.";
    debugLog("panel", "scan threw", e);
  } finally {
    hideBusy();
    render();
  }
}

/**
 * Write this session's decisions to the disclosure ledger exactly once, when
 * the user reaches the summary. Records categories and decisions only — never
 * values (valueStored is always false; see ledger.ts).
 */
async function commitSessionLedger(): Promise<void> {
  if (state.ledgerCommitted) return;
  state.ledgerCommitted = true;

  const now = Date.now();
  const origin = state.page?.origin ?? "unknown";
  const title = state.page?.title ?? null;
  const entries: LedgerEntry[] = [];

  for (const f of state.fields) {
    const c = state.classifications.get(f.fieldId);
    if (!c) continue;
    const fillable = isFillable(c);
    const d = state.decisions.get(f.fieldId);
    const ledgerDecision =
      d === "generated" ? "generated" :
      !fillable ? "never_fill" :
      d === "approved" ? "approved" :
      d === "edited" ? "edited" :
      d === "skipped" ? "skipped" :
      d === "marked_wrong" ? "marked_wrong" :
      null; // not reviewed → not recorded

    if (!ledgerDecision) continue;
    entries.push(
      buildLedgerEntry({
        timestamp: now,
        siteOrigin: origin,
        pageTitle: title,
        fieldLabel: labelFor(f),
        category: c.category,
        sensitivity: c.sensitivity,
        decision: ledgerDecision,
        filled: state.fillResults.get(f.fieldId) ?? false,
      }),
    );
  }
  if (entries.length) await appendLedger(entries);
}

function renderSummary(root: HTMLElement): void {
  let filled = 0;
  let skipped = 0;
  let wrong = 0;
  let never = 0;
  let pending = 0;
  const rows: HTMLElement[] = [];

  for (const f of state.fields) {
    const c = state.classifications.get(f.fieldId);
    if (!c) continue;
    const d = state.decisions.get(f.fieldId);
    let outcome: string;
    if (d === "generated") {
      outcome = state.fillResults.get(f.fieldId) ? "strong password generated & filled" : "password generated (could not fill)";
      if (state.fillResults.get(f.fieldId)) filled++;
    } else if (!isFillable(c)) {
      outcome = "never filled (secret)";
      never++;
    } else if ((d === "approved" || d === "edited") && state.fillResults.get(f.fieldId)) {
      outcome = "filled";
      filled++;
    } else if (d === "approved" || d === "edited") {
      outcome = "approved, but could not fill";
    } else if (d === "skipped") {
      outcome = "skipped";
      skipped++;
    } else if (d === "marked_wrong") {
      outcome = "flagged wrong";
      wrong++;
    } else {
      outcome = "not reviewed";
      pending++;
    }
    rows.push(
      el("div", { class: "ff-preview-row" }, [
        el("span", { text: labelFor(f) }),
        el("span", { class: "ff-muted", text: outcome }),
      ]),
    );
  }

  root.append(el("h2", { text: "All done" }));
  root.append(
    el("div", {
      class: "ff-guidance",
      attrs: { role: "status", "aria-live": "polite" },
      text:
        `Filled ${filled} field(s). ${skipped} skipped, ${wrong} flagged, ${never} never-fill` +
        (pending ? `, ${pending} not reviewed` : "") +
        ". Nothing was submitted — please review the page and submit it yourself when you're ready.",
    }),
  );
  root.append(el("div", { class: "ff-preview" }, [el("h3", { text: "Summary" }), ...rows]));
  root.append(
    el("div", { class: "ff-actions" }, [
      button("Review again", () => {
        state.stage = "guided";
        state.guidedIndex = 0;
        render();
      }, { class: "ff-btn" }),
      button("Scan again", () => void doScan(), { class: "ff-btn ff-btn-primary" }),
    ]),
  );
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
      modelWarning.textContent = `✓ Recommended default — small and fast. Actual GPU fit is measured when it's loaded (see Test Ollama connection).`;
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
    el("p", { class: "ff-note", text: `Default (small, fast, reproducible): ${RECOMMENDED_MODEL}` }),
    el("pre", { class: "ff-cmd", text: `ollama pull ${RECOMMENDED_MODEL}` }),
    el("p", { class: "ff-note", text: "Fallbacks:" }),
    el("pre", { class: "ff-cmd", text: FALLBACK_MODELS.map((m) => `ollama pull ${m}`).join("\n") }),
    el("p", {
      class: "ff-note",
      text: "Larger models give higher quality but may be partially offloaded to CPU (slower). formfillm can't read your GPU directly — use Test Ollama connection below to measure the actual GPU/CPU split for whatever you load.",
    }),
  ]);
  root.append(ref);

  // Test connection + model list
  const testResult = el("div", { class: "ff-test-result", attrs: { role: "status", "aria-live": "polite" } });
  const doTest = async () => {
    clear(testResult);
    showBusy("Testing the Ollama connection…", "Querying installed models.");
    let res: TestOllamaResponse;
    try {
      res = await sendBg<TestOllamaResponse>({ type: MSG.TestOllama });
    } finally {
      hideBusy();
    }
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

    // Measured GPU/CPU split for whatever is loaded right now (from /api/ps).
    const loaded = res.loaded ?? [];
    const fitWrap = el("div", { class: "ff-fit" }, [el("h3", { text: "Measured GPU fit" })]);
    if (loaded.length) {
      for (const lm of loaded) {
        const fit = assessVramFit(lm.size, lm.sizeVram);
        const cls =
          fit.severity === "ok" ? "ff-note ff-ok" : fit.severity === "warn" ? "ff-note ff-card-warning" : "ff-note ff-muted";
        fitWrap.append(el("p", { class: cls, text: `${lm.name}: ${fit.label}` }));
      }
      fitWrap.append(
        el("p", {
          class: "ff-note ff-muted",
          text: "Measured from Ollama /api/ps — no hardware assumptions. Anything on CPU is what slows generation.",
        }),
      );
    } else {
      fitWrap.append(
        el("p", {
          class: "ff-note ff-muted",
          text: "No model is loaded yet, so there's nothing to measure. Run a scan with your selected model, then Test again to see its real GPU/CPU split.",
        }),
      );
    }
    testResult.append(fitWrap);
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

/**
 * Jump the guided wizard to the field the user just selected on the page.
 * No-op unless a guided session exists for the active tab and that field was
 * part of the scan. Does not interrupt an in-flight password generation.
 */
function jumpToField(fieldId: string): void {
  if (state.fields.length === 0 || state.stage === "idle") return;
  if (state.generating !== null) return;
  const idx = state.fields.findIndex((f) => f.fieldId === fieldId);
  if (idx < 0) return;
  if (state.stage === "guided" && state.guidedIndex === idx && currentView === "scan") return;
  debugLog("panel", "jump to field from page selection", { fieldId, idx });
  state.stage = "guided";
  state.guidedIndex = idx;
  state.editing = null;
  if (currentView === "scan") render();
  else setView("scan");
}

/** Listen for page field selections relayed from the content script. */
function wireFieldFocusJump(): void {
  chrome.runtime.onMessage.addListener((raw, sender) => {
    const msg = parseMessage(raw);
    if (!msg || msg.type !== MSG.FieldFocused) return false;
    // Only honor selections from the tab this session is bound to.
    if (state.tabId === null || sender.tab?.id !== state.tabId) return false;
    jumpToField(msg.fieldId);
    return false;
  });
}

async function main(): Promise<void> {
  settings = await getSettings();
  profile = await getProfile();
  state.tabId = await activeTabId();
  wireNav();
  wireFieldFocusJump();
  wirePageChangeReset();
  await refreshStatus();
  setView("scan");
}

void main();
