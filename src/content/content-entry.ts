/*
 * formfillm — content script entry
 *
 * Injected on demand via chrome.scripting.executeScript after explicit user
 * activation. Wires the scanner, filler, and overlay to the message bus. Holds
 * the per-scan element registry in page memory only — element references never
 * leave the page; only metadata does.
 */

import {
  MSG,
  parseMessage,
  type ApplyFillResponse,
  type PasswordContextResponse,
  type ScanPageResponse,
} from "../shared/messages.js";
import { scanFields, type FieldRef } from "./scanner.js";
import { applyFills, highlightField } from "./filler.js";
import { getPasswordContext } from "./password-context.js";
import { mountOverlay, removeOverlay, setOverlayStatus } from "./overlay.js";
import { debugLog } from "../shared/debug-consts.js";

interface ContentGlobal {
  __formfillmInitialized?: boolean;
  __formfillmRefs?: Map<string, FieldRef>;
}

const g = window as unknown as ContentGlobal;

// Tracks the last field id we told the side panel about, so click + focusin on
// the same field don't double-report. Reset on each scan.
let lastFocusFieldId: string | null = null;
// While we're programmatically filling, the focus we trigger must NOT be
// reported back as a user selection (that would yank the wizard backwards).
let suppressFocusReporting = false;

function pageContext() {
  return { origin: location.origin, title: document.title || null };
}

/** Find which scanned field, if any, owns the given event target. */
function fieldIdForTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const refs = g.__formfillmRefs;
  if (!refs || refs.size === 0) return null;
  for (const [fieldId, ref] of refs) {
    if (ref.primary === target || ref.primary.contains(target)) return fieldId;
    if (ref.els.some((e) => e === target || e.contains(target))) return fieldId;
    if (ref.options?.some((o) => o.el && (o.el === target || o.el.contains(target)))) return fieldId;
  }
  return null;
}

/** Report a user-driven field selection so the side panel can jump to its step. */
function reportFieldSelection(target: EventTarget | null): void {
  if (suppressFocusReporting) return;
  const fieldId = fieldIdForTarget(target);
  if (!fieldId || fieldId === lastFocusFieldId) return;
  lastFocusFieldId = fieldId;
  debugLog("fill", "user selected field on page", fieldId);
  void chrome.runtime.sendMessage({ type: MSG.FieldFocused, fieldId }).catch(() => undefined);
}

/** Briefly ignore focus we cause ourselves (e.g. when filling a field). */
function suppressSelfFocus(): void {
  suppressFocusReporting = true;
  window.setTimeout(() => {
    suppressFocusReporting = false;
  }, 400);
}

function init(): void {
  if (g.__formfillmInitialized) return;
  g.__formfillmInitialized = true;
  g.__formfillmRefs = new Map();

  // When the user picks a field on the page, tell the side panel so its guided
  // wizard can jump to that field. Delegated + capture so it works for fields
  // added after load and for clicks on non-focusable ARIA widgets.
  document.addEventListener("focusin", (e) => reportFieldSelection(e.target), true);
  document.addEventListener("click", (e) => reportFieldSelection(e.target), true);

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = parseMessage(raw);
    if (!msg) {
      sendResponse({ ok: false, error: "Unrecognized message." });
      return false;
    }

    switch (msg.type) {
      case MSG.Ping:
        sendResponse({ ok: true });
        return false;

      case MSG.ScanPage: {
        try {
          const { fields, refs } = scanFields();
          g.__formfillmRefs = refs;
          lastFocusFieldId = null;
          mountOverlay();
          setOverlayStatus(`Scanned ${fields.length} field${fields.length === 1 ? "" : "s"}.`);
          const res: ScanPageResponse = { ok: true, fields, page: pageContext() };
          sendResponse(res);
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } as ScanPageResponse);
        }
        return false;
      }

      case MSG.ApplyFill: {
        const refs = g.__formfillmRefs ?? new Map<string, FieldRef>();
        debugLog("fill", "ApplyFill received", {
          requested: msg.fills.map((f) => f.fieldId),
          knownRefs: refs.size,
        });
        // Filling focuses the field; don't let that echo back as a user
        // selection and pull the wizard backwards.
        suppressSelfFocus();
        applyFills(refs, msg.fills)
          .then((results) => {
            debugLog("fill", "fill results", results);
            const filled = results.filter((r) => r.filled).length;
            setOverlayStatus(`Filled ${filled} of ${results.length} approved field${results.length === 1 ? "" : "s"}.`);
            const res: ApplyFillResponse = { ok: true, results };
            sendResponse(res);
          })
          .catch((e: unknown) =>
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } as ApplyFillResponse),
          );
        return true; // async
      }

      case MSG.HighlightField: {
        highlightField(g.__formfillmRefs ?? new Map<string, FieldRef>(), msg.fieldId);
        sendResponse({ ok: true });
        return false;
      }

      case MSG.PasswordContext: {
        const refs = g.__formfillmRefs ?? new Map<string, FieldRef>();
        const context = getPasswordContext(refs, msg.fieldId);
        const res: PasswordContextResponse = { ok: true, context };
        sendResponse(res);
        return false;
      }

      case MSG.RemoveOverlay:
        removeOverlay();
        sendResponse({ ok: true });
        return false;

      case MSG.FieldFocused:
        // Outbound only (content → side panel); never received here.
        return false;

      case MSG.Classify:
      case MSG.TestBackend:
      case MSG.ParsePasswordPolicy:
        // These are background-only messages; the content script ignores them.
        sendResponse({ ok: false, error: "Not handled in content script." });
        return false;
    }
  });
}

init();
