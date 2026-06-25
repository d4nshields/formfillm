/*
 * formfillm — background service worker
 *
 * Responsibilities:
 *  - Configure the side panel to open on action click.
 *  - Route messages between the side panel and the injected content script.
 *  - Call the LOCAL Ollama service (and nothing else) for classification.
 *  - Enforce local-only URL/model policy and fail closed.
 *
 * Privacy notes:
 *  - This worker never reads the user's profile. Classification uses field
 *    metadata only (see prompts.ts). Fill values pass through ApplyFill purely
 *    in transit to the content script; they are never stored or logged here.
 *  - No personal data is kept in module-level variables.
 */

import {
  MSG,
  parseMessage,
  type ApplyFillResponse,
  type ClassifyResponse,
  type Message,
  type ScanPageResponse,
  type TestOllamaResponse,
} from "../shared/messages.js";
import {
  CLASSIFICATION_JSON_SCHEMA,
  extractJson,
  validateClassificationResponse,
} from "../shared/classification-schema.js";
import { buildClassificationPrompt, CLASSIFIER_SYSTEM_PROMPT } from "../shared/prompts.js";
import { reconcileClassification } from "../shared/sensitivity.js";
import { sanitizeFieldsForModel } from "../shared/sanitize.js";
import { validateModelName, validateOllamaUrl } from "../shared/ollama-policy.js";
import { DEFAULT_SETTINGS, STORAGE_KEYS, type Settings } from "../shared/types.js";

const OLLAMA_TIMEOUT_MS = 60_000;

// --- Side panel wiring ------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* older Chrome without setPanelBehavior — side_panel.default_path still works */
  });
});

// --- Settings ---------------------------------------------------------------

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = (stored[STORAGE_KEYS.settings] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    localOnly: true, // locked on for the MVP
  };
}

// --- Ollama client (local only) --------------------------------------------

interface OllamaChatOptions {
  baseUrl: string;
  model: string;
  temperature: number;
  jsonSchemaMode: boolean;
}

/** POST to the local Ollama /api/chat and return the raw message content. */
async function ollamaChat(
  opts: OllamaChatOptions,
  system: string,
  user: string,
  forceJsonString: boolean,
): Promise<string> {
  const format = forceJsonString
    ? "json"
    : opts.jsonSchemaMode
      ? CLASSIFICATION_JSON_SCHEMA
      : "json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        format,
        options: { temperature: opts.temperature },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not reach local Ollama at ${opts.baseUrl}. Is Ollama running? (${msg})`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 403) {
      throw new Error(
        "Ollama refused the request (403). Allow the extension origin by setting OLLAMA_ORIGINS to include chrome-extension origins (or '*'), then restart Ollama.",
      );
    }
    throw new Error(`Ollama returned ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { message?: { content?: string } };
  const content = data?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Ollama returned no content.");
  }
  return content;
}

// --- Handlers ---------------------------------------------------------------

async function handleClassify(
  fields: import("../shared/types.js").FieldMetadata[],
  page: { origin: string; title: string | null },
): Promise<ClassifyResponse> {
  const settings = await getSettings();

  const url = validateOllamaUrl(settings.ollamaBaseUrl);
  if (!url.ok) return { ok: false, error: url.reason };
  const model = validateModelName(settings.model);
  if (!model.ok) return { ok: false, error: model.reason };

  // Defense in depth: sanitize again in case anything reached us unsanitized.
  const safeFields = sanitizeFieldsForModel(fields);
  const knownIds = safeFields.map((f) => f.fieldId);
  const userPrompt = buildClassificationPrompt(safeFields, {
    origin: page.origin,
    ...(page.title ? { title: page.title } : {}),
  });

  const opts: OllamaChatOptions = {
    baseUrl: url.normalized,
    model: settings.model,
    temperature: settings.temperature,
    jsonSchemaMode: settings.jsonSchemaMode,
  };

  // Attempt 1 (schema or json), then one retry forcing plain JSON. If both
  // fail to parse, fall through to fail-closed validation (all manual_review).
  let parsed: unknown = null;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
    try {
      const content = await ollamaChat(opts, CLASSIFIER_SYSTEM_PROMPT, userPrompt, attempt === 1);
      parsed = extractJson(content);
      if (parsed === null) lastError = "Model output was not valid JSON.";
    } catch (e) {
      // A transport/HTTP error is terminal — report it rather than retrying blind.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const { classifications, errors } = validateClassificationResponse(parsed, knownIds);
  const reconciled = classifications.map(reconcileClassification);
  const allErrors = lastError ? [lastError, ...errors] : errors;
  return { ok: true, classifications: reconciled, ...(allErrors.length ? { errors: allErrors } : {}) };
}

async function handleTestOllama(): Promise<TestOllamaResponse> {
  const settings = await getSettings();
  const url = validateOllamaUrl(settings.ollamaBaseUrl);
  if (!url.ok) return { ok: false, reachable: false, error: url.reason };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(`${url.normalized}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, reachable: false, error: `Ollama returned ${resp.status}.`, current: settings.model };
    }
    const data = (await resp.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
    return { ok: true, reachable: true, models, current: settings.model };
  } catch (e) {
    return {
      ok: false,
      reachable: false,
      error: e instanceof Error ? e.message : String(e),
      current: settings.model,
    };
  }
}

/** Inject the content script (idempotent) and ask it to scan the page. */
async function handleScanPage(tabId: number): Promise<ScanPageResponse> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not access this tab. Click the formfillm toolbar icon on the page you want to scan, then try again. " +
        (e instanceof Error ? `(${e.message})` : ""),
    };
  }
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: MSG.ScanPage })) as ScanPageResponse;
    return res ?? { ok: false, error: "No response from page scanner." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function forwardToContent<T>(tabId: number, message: Message): Promise<T> {
  return (await chrome.tabs.sendMessage(tabId, message)) as T;
}

// --- Message router ---------------------------------------------------------

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
      if (typeof msg.tabId !== "number") {
        sendResponse({ ok: false, error: "Missing tabId for scan." });
        return false;
      }
      handleScanPage(msg.tabId).then(sendResponse);
      return true;
    }

    case MSG.Classify:
      handleClassify(msg.fields, msg.page).then(sendResponse);
      return true;

    case MSG.TestOllama:
      handleTestOllama().then(sendResponse);
      return true;

    case MSG.ApplyFill: {
      if (typeof msg.tabId !== "number") {
        sendResponse({ ok: false, error: "Missing tabId for fill." });
        return false;
      }
      // Values are forwarded in transit only — not stored, not logged.
      forwardToContent<ApplyFillResponse>(msg.tabId, { type: MSG.ApplyFill, fills: msg.fills })
        .then(sendResponse)
        .catch((e: unknown) =>
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      return true;
    }

    case MSG.HighlightField: {
      if (typeof msg.tabId !== "number") {
        sendResponse({ ok: false });
        return false;
      }
      forwardToContent(msg.tabId, { type: MSG.HighlightField, fieldId: msg.fieldId })
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    case MSG.RemoveOverlay: {
      if (typeof msg.tabId !== "number") {
        sendResponse({ ok: false });
        return false;
      }
      forwardToContent(msg.tabId, { type: MSG.RemoveOverlay })
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  }
});
