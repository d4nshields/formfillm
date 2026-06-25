/*
 * formfillm — content script entry
 *
 * Injected on demand via chrome.scripting.executeScript after explicit user
 * activation. Wires the scanner, filler, and overlay to the message bus. Holds
 * the per-scan element registry in page memory only — element references never
 * leave the page; only metadata does.
 */

import { MSG, parseMessage, type ApplyFillResponse, type ScanPageResponse } from "../shared/messages.js";
import { scanFields, type FieldRef } from "./scanner.js";
import { applyFills, highlightField } from "./filler.js";
import { mountOverlay, removeOverlay, setOverlayStatus } from "./overlay.js";

interface ContentGlobal {
  __formfillmInitialized?: boolean;
  __formfillmRefs?: Map<string, FieldRef>;
}

const g = window as unknown as ContentGlobal;

function pageContext() {
  return { origin: location.origin, title: document.title || null };
}

function init(): void {
  if (g.__formfillmInitialized) return;
  g.__formfillmInitialized = true;
  g.__formfillmRefs = new Map();

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
        console.log("[formfillm:content] ApplyFill received", {
          requested: msg.fills.map((f) => f.fieldId),
          knownRefs: refs.size,
        });
        applyFills(refs, msg.fills)
          .then((results) => {
            console.log("[formfillm:content] fill results", results);
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

      case MSG.RemoveOverlay:
        removeOverlay();
        sendResponse({ ok: true });
        return false;

      case MSG.Classify:
      case MSG.TestOllama:
        // These are background-only messages; the content script ignores them.
        sendResponse({ ok: false, error: "Not handled in content script." });
        return false;
    }
  });
}

init();
