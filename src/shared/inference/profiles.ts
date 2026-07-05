/*
 * formfillm — backend PROFILES.
 *
 * All target backends speak the same OpenAI `/v1` wire format, so they share a
 * single adapter. A profile captures the few GENUINE per-backend deltas: the
 * default local URL and — the one that actually bites — how to disable model
 * "thinking" per request. Getting this right matters: a reasoning model with
 * thinking left ON wastes its token budget and slows every classification.
 *
 * Everything here is local-only; a profile just picks a loopback default port.
 */

import type { BackendId } from "../types.js";

export interface BackendProfile {
  id: BackendId;
  label: string;
  /** Loopback default (user-overridable in Settings). */
  defaultBaseUrl: string;
  /**
   * Mutate a request body to turn model "thinking" OFF for this backend. There
   * is no single standard field across backends:
   *   - Ollama / vLLM: `reasoning_effort: "none"`
   *   - SGLang:        `chat_template_kwargs: { enable_thinking: false }`
   *   - llama.cpp:     none per-request (server-launch `--reasoning-budget 0`)
   */
  applyThinkingOff: (body: Record<string, unknown>) => void;
  /** Repo-relative setup doc. */
  docs: string;
  /** One-line Settings hint. */
  hint: string;
}

function setReasoningEffortNone(body: Record<string, unknown>): void {
  body.reasoning_effort = "none";
}

function setEnableThinkingFalse(body: Record<string, unknown>): void {
  const kwargs = (body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};
  kwargs.enable_thinking = false;
  body.chat_template_kwargs = kwargs;
}

export const BACKEND_PROFILES: Record<BackendId, BackendProfile> = {
  ollama: {
    id: "ollama",
    label: "Ollama",
    defaultBaseUrl: "http://127.0.0.1:11434",
    applyThinkingOff: setReasoningEffortNone,
    docs: "docs/backends/ollama.md",
    hint: "Default — zero setup. `ollama pull qwen3.5:4b`, then run.",
  },
  sglang: {
    id: "sglang",
    label: "SGLang",
    defaultBaseUrl: "http://127.0.0.1:30000",
    applyThinkingOff: setEnableThinkingFalse,
    docs: "docs/backends/sglang.md",
    hint: "Advanced — run via Docker; grammar-enforces JSON. See docs/backends/sglang.md.",
  },
  vllm: {
    id: "vllm",
    label: "vLLM",
    defaultBaseUrl: "http://127.0.0.1:8000",
    applyThinkingOff: setReasoningEffortNone,
    docs: "docs/backends/vllm.md",
    hint: "Advanced — reasoning_effort honored; GET /v1/models may be unavailable.",
  },
  llamacpp: {
    id: "llamacpp",
    label: "llama.cpp (llama-server)",
    defaultBaseUrl: "http://127.0.0.1:8080",
    // No per-request thinking-off: disable at launch with --reasoning-budget 0.
    applyThinkingOff: () => {},
    docs: "docs/backends/llamacpp.md",
    hint: "Advanced — disable reasoning at server launch (--reasoning-budget 0).",
  },
};

/** Resolve a profile, falling back to Ollama for any unknown id. */
export function backendProfile(id: BackendId): BackendProfile {
  return BACKEND_PROFILES[id] ?? BACKEND_PROFILES.ollama;
}
