/*
 * formfillm — OpenAI-compatible ADAPTER.
 *
 * The one adapter implementing the ChatBackend port, over
 * `POST {baseUrl}/v1/chat/completions` + `GET {baseUrl}/v1/models`. It works
 * against any local server that speaks the OpenAI wire format; the per-backend
 * differences live in the injected BackendProfile (thinking-off, default URL).
 *
 * No Chrome APIs — just fetch, so it is unit-testable with a mocked global
 * fetch (see tests/inference-adapter.test.ts).
 */

import { debugLog } from "../debug-consts.js";
import type { BackendProfile } from "./profiles.js";
import type { ChatBackend, ChatRequest } from "./port.js";

const olog = (...args: unknown[]): void => debugLog("ollamaNetwork", ...args);

// Cold model loads (esp. partly CPU-offloaded) can take a while; be generous.
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 10_000;

/** Wrap a JSON schema as an OpenAI `response_format` (json_schema). */
function jsonSchemaFormat(name: string, schema: object) {
  return { type: "json_schema" as const, json_schema: { name, strict: true, schema } };
}

export class OpenAiChatBackend implements ChatBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly profile: BackendProfile,
    private readonly timeoutMs: number = DEFAULT_CHAT_TIMEOUT_MS,
  ) {}

  async chat(req: ChatRequest): Promise<string> {
    // Structured output. json_schema is grammar-enforced by llama-server/vLLM/
    // SGLang and accepted-but-not-enforced by Ollama (so callers still pin the
    // shape in the prompt and fail closed). Retry/plain path uses json_object.
    const responseFormat =
      req.forcePlainJson || !req.jsonSchemaMode
        ? { type: "json_object" as const }
        : jsonSchemaFormat(req.schemaName, req.schema);

    const base: Record<string, unknown> = {
      model: req.model,
      stream: false,
      temperature: req.temperature,
      response_format: responseFormat,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    // Thinking OFF is per-backend (profile). Keep an un-mutated `base` so we can
    // retry without it if the backend rejects the field.
    const withThinkingOff: Record<string, unknown> = { ...base };
    this.profile.applyThinkingOff(withThinkingOff);

    const post = async (body: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        olog("chat ✗ aborting after timeout", { ms: this.timeoutMs });
        controller.abort();
      }, this.timeoutMs);
      try {
        return await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(body),
        });
      } finally {
        clearTimeout(timer);
      }
    };

    const startedAt = Date.now();
    olog("chat → request", { backend: this.profile.id, model: req.model, responseFormat: responseFormat.type });

    let resp: Response;
    try {
      resp = await post(withThinkingOff);
      // A backend/model that doesn't understand the thinking-off field may
      // reject it (4xx mentioning it); retry once without it.
      if (!resp.ok && resp.status >= 400 && resp.status < 500) {
        const peek = await resp.clone().text().catch(() => "");
        if (/reasoning|thinking|chat_template/i.test(peek)) {
          olog("chat ↺ retrying without thinking-off", { status: resp.status });
          resp = await post(base);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Could not reach the ${this.profile.label} server at ${this.baseUrl}. Is it running? (${msg})`,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 403) {
        throw new Error(
          "The local server refused the request (403). If using Ollama, allow the extension origin by setting OLLAMA_ORIGINS to include chrome-extension origins (or '*'), then restart Ollama.",
        );
      }
      throw new Error(`${this.profile.label} returned ${resp.status}: ${text.slice(0, 200)}`);
    }

    olog("chat ← response", { status: resp.status, ms: Date.now() - startedAt });

    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(
        "The model returned no content (a reasoning model may have emitted only hidden thinking).",
      );
    }
    return content;
  }

  async listModels(): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/models`, { signal: controller.signal });
    } catch (e) {
      // Unreachable — surface it so Settings can say "not reachable".
      throw new Error(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
    // Reachable but no usable list (e.g. some vLLM builds 404 here): return [].
    if (!resp.ok) return [];
    const data = (await resp.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((n): n is string => typeof n === "string");
  }
}
