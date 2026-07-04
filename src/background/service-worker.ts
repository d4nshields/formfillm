/*
 * formfillm — background service worker
 *
 * Responsibilities:
 *  - Configure the side panel to open on action click.
 *  - Route messages between the side panel and the injected content script.
 *  - Call a LOCAL model server (and nothing else) for classification, via the
 *    OpenAI-compatible /v1 endpoint (Ollama by default). See
 *    docs/PLAN-backend-abstraction.md.
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
  type ParsePasswordPolicyResponse,
  type PasswordContext,
  type PasswordContextResponse,
  type ScanPageResponse,
  type TestOllamaResponse,
} from "../shared/messages.js";
import {
  CLASSIFICATION_JSON_SCHEMA,
  extractJson,
  validateClassificationResponse,
} from "../shared/classification-schema.js";
import {
  buildClassificationPrompt,
  buildPasswordPolicyPrompt,
  CLASSIFIER_SYSTEM_PROMPT,
  PASSWORD_POLICY_SYSTEM_PROMPT,
} from "../shared/prompts.js";
import { reconcileClassification } from "../shared/sensitivity.js";
import { sanitizeFieldsForModel } from "../shared/sanitize.js";
import { validateModelName, validateOllamaUrl } from "../shared/ollama-policy.js";
import { mergePolicyExtraction, PASSWORD_POLICY_SCHEMA, policyFromAttributes } from "../shared/password.js";
import { debugLog } from "../shared/debug-consts.js";
import { DEFAULT_SETTINGS, STORAGE_KEYS, type Settings } from "../shared/types.js";

// Cold model loads (especially when partly CPU-offloaded) can take a while,
// so allow generous headroom before aborting.
const OLLAMA_TIMEOUT_MS = 120_000;

// Diagnostics, gated per channel in shared/debug-consts.ts. Logs appear in the
// SERVICE WORKER console: chrome://extensions → formfillm → "Inspect views:
// service worker". `log` = messaging/gesture/injection; `olog` = Ollama network.
const log = (...args: unknown[]): void => debugLog("messaging", ...args);
const olog = (...args: unknown[]): void => debugLog("ollamaNetwork", ...args);

// Tabs for which the user invoked the formfillm action icon (which grants
// activeTab). This is purely a diagnostic/UX signal — the real permission is
// the activeTab grant held by Chrome. The grant is cleared on navigation.
const activatedTabs = new Set<number>();

// --- Side panel wiring ------------------------------------------------------
//
// We open the side panel from action.onClicked rather than via
// setPanelBehavior({ openPanelOnActionClick: true }). The latter suppresses the
// onClicked event, and onClicked is the gesture that grants `activeTab`. By
// opening the panel here, clicking the toolbar icon both opens the panel AND
// grants activeTab for that tab, so a later "Scan this page" can inject.
//
// IMPORTANT: openPanelOnActionClick is persisted in the user profile, so we
// must explicitly set it false to undo any value left by a previous version —
// otherwise Chrome opens the panel itself and never fires onClicked.
async function configureSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    log("openPanelOnActionClick set to false (onClicked will fire on icon click)");
  } catch (e) {
    log("setPanelBehavior failed", e);
  }
}
chrome.runtime.onInstalled.addListener(() => void configureSidePanel());
chrome.runtime.onStartup.addListener(() => void configureSidePanel());
void configureSidePanel();

chrome.action.onClicked.addListener((tab) => {
  log("action.onClicked fired", { tabId: tab.id, url: tab.url, windowId: tab.windowId });
  if (tab.id !== undefined) {
    activatedTabs.add(tab.id);
    void chrome.sidePanel.open({ tabId: tab.id }).catch((e) => {
      log("sidePanel.open({tabId}) failed; falling back to window", e);
      if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
    });
  } else if (tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// A full navigation revokes activeTab; track that so we can give a precise hint.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && activatedTabs.has(tabId)) {
    activatedTabs.delete(tabId);
    log("tab navigated — activeTab grant cleared", { tabId, url: changeInfo.url });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => activatedTabs.delete(tabId));

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

// --- Chat client (local, OpenAI-compatible /v1) -----------------------------

interface ChatOptions {
  baseUrl: string;
  model: string;
  temperature: number;
  jsonSchemaMode: boolean;
}

/** Wrap a JSON schema as an OpenAI `response_format` (json_schema). */
function jsonSchemaFormat(name: string, schema: object) {
  return { type: "json_schema" as const, json_schema: { name, strict: true, schema } };
}

/**
 * POST to the local server's OpenAI-compatible /v1/chat/completions and return
 * the raw message content. Works against any local backend that speaks the
 * OpenAI wire format (Ollama by default; also llama-server, vLLM, SGLang).
 * See docs/PLAN-backend-abstraction.md.
 */
async function chatCompletion(
  opts: ChatOptions,
  system: string,
  user: string,
  schema: object,
  schemaName: string,
  forceJsonObject: boolean,
): Promise<string> {
  // Structured output. `json_schema` when schema mode is on — enforced as a
  // hard grammar by llama-server/vLLM/SGLang, and accepted-but-not-enforced by
  // Ollama (which is why the prompt still pins the shape and validation fails
  // closed). The forced retry and non-schema path use plain `json_object`.
  const responseFormat =
    forceJsonObject || !opts.jsonSchemaMode
      ? { type: "json_object" as const }
      : jsonSchemaFormat(schemaName, schema);

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  // Disable model "thinking" via the OpenAI-standard field. Reasoning models
  // (e.g. qwen3.x) otherwise spend their whole token budget on hidden reasoning
  // and return EMPTY content under constrained JSON — slow and unusable, so
  // this is both a correctness and a speed fix. Honored by Ollama + vLLM over
  // /v1; harmless where ignored (llama.cpp/SGLang disable reasoning server-side).
  const postChat = async (sendReasoning: boolean): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      olog("chatCompletion ✗ aborting after timeout", { ms: OLLAMA_TIMEOUT_MS });
      controller.abort();
    }, OLLAMA_TIMEOUT_MS);
    try {
      return await fetch(`${opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: opts.model,
          stream: false,
          temperature: opts.temperature,
          ...(sendReasoning ? { reasoning_effort: "none" } : {}),
          response_format: responseFormat,
          messages,
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const startedAt = Date.now();
  olog("chatCompletion → request", {
    model: opts.model,
    responseFormat: responseFormat.type,
    promptChars: system.length + user.length,
  });

  let resp: Response;
  try {
    resp = await postChat(true);
    // A backend/model that doesn't understand reasoning_effort may reject it
    // (4xx mentioning "reasoning"); retry once without it so it still works.
    if (!resp.ok && resp.status >= 400 && resp.status < 500) {
      const peek = await resp.clone().text().catch(() => "");
      if (/reasoning/i.test(peek)) {
        olog("chatCompletion ↺ retrying without reasoning_effort", { status: resp.status });
        resp = await postChat(false);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not reach the local model server at ${opts.baseUrl}. Is it running? (${msg})`,
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 403) {
      throw new Error(
        "The local server refused the request (403). If using Ollama, allow the extension origin by setting OLLAMA_ORIGINS to include chrome-extension origins (or '*'), then restart Ollama.",
      );
    }
    throw new Error(`Local server returned ${resp.status}: ${text.slice(0, 200)}`);
  }

  olog("chatCompletion ← response", { status: resp.status, ms: Date.now() - startedAt });

  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(
      "The model returned no content (a reasoning model may have emitted only hidden thinking).",
    );
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
  olog("classify start", {
    model: settings.model,
    baseUrl: url.normalized,
    jsonSchemaMode: settings.jsonSchemaMode,
    fields: knownIds.length,
  });
  const userPrompt = buildClassificationPrompt(safeFields, {
    origin: page.origin,
    ...(page.title ? { title: page.title } : {}),
  });

  const opts: ChatOptions = {
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
      const content = await chatCompletion(opts, CLASSIFIER_SYSTEM_PROMPT, userPrompt, CLASSIFICATION_JSON_SCHEMA, "field_classification", attempt === 1);
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
    // OpenAI-compatible model list (Ollama/llama-server/SGLang expose it; vLLM
    // may not). Doubles as the reachability check for the status line.
    const resp = await fetch(`${url.normalized}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, reachable: false, error: `Server returned ${resp.status}.`, current: settings.model };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
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

/**
 * Extract a structured password policy. Always succeeds: starts from the
 * input's own constraints and, when policy text is present and Ollama is
 * configured, asks the local model to refine it — failing closed to the
 * attribute baseline on any error. Never sees user data.
 */
async function handleParsePasswordPolicy(context: PasswordContext): Promise<ParsePasswordPolicyResponse> {
  const base = policyFromAttributes({
    minLength: context.minLength,
    maxLength: context.maxLength,
    pattern: context.pattern,
  });

  if (!context.policyText) return { ok: true, policy: base };

  const settings = await getSettings();
  const url = validateOllamaUrl(settings.ollamaBaseUrl);
  const model = validateModelName(settings.model);
  if (!url.ok || !model.ok) return { ok: true, policy: base };

  const opts: ChatOptions = {
    baseUrl: url.normalized,
    model: settings.model,
    temperature: settings.temperature,
    jsonSchemaMode: settings.jsonSchemaMode,
  };
  const userPrompt = buildPasswordPolicyPrompt({
    minLength: context.minLength,
    maxLength: context.maxLength,
    pattern: context.pattern,
    policyText: context.policyText,
  });

  try {
    let parsed: unknown = null;
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      const content = await chatCompletion(opts, PASSWORD_POLICY_SYSTEM_PROMPT, userPrompt, PASSWORD_POLICY_SCHEMA, "password_policy", attempt === 1);
      parsed = extractJson(content);
    }
    return { ok: true, policy: mergePolicyExtraction(base, parsed) };
  } catch (e) {
    olog("password policy extraction failed; using attribute baseline", e);
    return { ok: true, policy: base };
  }
}

/** Inject the content script (idempotent) and ask it to scan the page. */
async function handleScanPage(tabId: number): Promise<ScanPageResponse> {
  const iconClicked = activatedTabs.has(tabId);
  log("handleScanPage start", { tabId, iconClickedForThisTab: iconClicked });

  // Inspect the tab so we can distinguish "restricted URL" from "no grant".
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab = await chrome.tabs.get(tabId);
    log("target tab", { url: tab.url, status: tab.status, title: tab.title });
  } catch (e) {
    log("chrome.tabs.get failed", e);
  }

  const url = tab?.url ?? "";
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|view-source|devtools):/i.test(url) ||
      /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) {
    const msg = `formfillm cannot run on browser/system pages (${url || "restricted URL"}). Open a normal web page and try again.`;
    log("blocked: restricted URL", url);
    return { ok: false, error: msg };
  }

  try {
    const injected = await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    log("executeScript ok", { frames: injected.length });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log("executeScript FAILED", detail, { iconClickedForThisTab: iconClicked, url });
    const hint = iconClicked
      ? "You activated this tab via the icon, but injection was still denied — the page likely navigated/reloaded since (which revokes access). Reload the page, click the formfillm icon on it, then scan."
      : "This tab was NOT opened via the formfillm action icon, so activeTab was never granted. Click the formfillm toolbar icon directly on this page (not Chrome's side-panel menu), then scan.";
    return { ok: false, error: `Could not access this tab. ${hint} (${detail})` };
  }

  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: MSG.ScanPage })) as ScanPageResponse;
    log("scan response", { ok: res?.ok, fields: res?.fields?.length });
    return res ?? { ok: false, error: "No response from page scanner." };
  } catch (e) {
    log("sendMessage(ScanPage) failed", e);
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
    log("received UNRECOGNIZED message", raw);
    sendResponse({ ok: false, error: "Unrecognized message." });
    return false;
  }
  log("received message", msg.type, "tabId" in msg ? { tabId: msg.tabId } : "");

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

    case MSG.PasswordContext: {
      if (typeof msg.tabId !== "number") {
        sendResponse({ ok: false, error: "Missing tabId." });
        return false;
      }
      forwardToContent<PasswordContextResponse>(msg.tabId, { type: MSG.PasswordContext, fieldId: msg.fieldId })
        .then(sendResponse)
        .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true;
    }

    case MSG.ParsePasswordPolicy:
      handleParsePasswordPolicy(msg.context).then(sendResponse);
      return true;

    case MSG.FieldFocused:
      // A page→side-panel signal; the worker is not involved. Ignore quietly.
      return false;
  }
});
