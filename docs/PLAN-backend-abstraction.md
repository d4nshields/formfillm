# Plan — backend-agnostic inference via the OpenAI-compatible endpoint

> **Status: PLANNED, not implemented. No code has been changed.**
> A reviewable implementation plan only, so the decision to proceed can be made
> deliberately. Rationale and engine analysis: [SCALING-LLM.md](./SCALING-LLM.md).

## Context

formfillm talks to a local Ollama through Ollama's **native** `/api/*` endpoints.
The concurrency review ([SCALING-LLM.md](./SCALING-LLM.md)) concluded a future
**centralized GPU box serving many users** would most likely run **vLLM or
SGLang**, and that all candidate backends (Ollama, llama-server, vLLM, SGLang)
expose the same **OpenAI-compatible `POST /v1/chat/completions`**.

Two design decisions are settled:

- **Agnostic, not architecture-specific.** SGLang's advantage (RadixAttention
  prefix caching) is automatic and **server-side**, and its API is
  OpenAI-compatible — so targeting SGLang specifically would add a second code
  path for **zero client-side gain**. The OpenAI wire format is the common
  denominator, so "agnostic" here means *write to one standard*, not *build
  adapters*.
- **Pure OpenAI-compatible shape.** One inference path for **all** backends,
  including Ollama via its own `/v1` endpoint. This is the simplest shape; its
  one cost is dropping the Ollama-only measured-fit feature (see below).

This is a learning/architecture exercise; nothing here is required for the
extension to function today. Ollama remains the zero-friction local default.

## Goal

One inference path via `{baseUrl}/v1/chat/completions` for every backend, with
Ollama the default and **every privacy invariant preserved** (local-only,
metadata-only classification, value-free ledger, never-fill secrets,
fail-closed).

## Key finding — disabling "thinking" over `/v1` is not uniform

formfillm depends on **thinking-off** for reasoning models like qwen3.5
(otherwise empty content + high latency; see [MODEL-BENCHMARK.md](./MODEL-BENCHMARK.md)).
There is **no single standard OpenAI field** that disables reasoning across all
backends:

| Backend | Per-request thinking-off | Over `/v1`? | `GET /v1/models`? |
|---------|--------------------------|-------------|-------------------|
| **Ollama** | `reasoning_effort:"none"` (native `think:false` is rejected on `/v1`) | ✅ yes | ✅ yes |
| **vLLM** | `reasoning_effort:"none"` or `chat_template_kwargs:{enable_thinking:false}` | ✅ yes | ⚠️ not yet |
| **llama.cpp** | none — server launch only (`--reasoning-budget 0`) | ❌ server-side | ✅ yes |
| **SGLang** | `chat_template_kwargs:{enable_thinking:false}` (model-specific) | ⚠️ model-specific | ✅ yes |

**Approach:** send `reasoning_effort:"none"` on every request — honored by the
default Ollama backend (and vLLM), harmless on the others — and **document** that
llama.cpp/SGLang operators disable reasoning **server-side**. (Sources: Ollama
issues [#14820](https://github.com/ollama/ollama/issues/14820),
[#15635](https://github.com/ollama/ollama/issues/15635),
[#15288](https://github.com/ollama/ollama/issues/15288); vLLM
[reasoning docs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/);
llama.cpp server README; SGLang OpenAI API docs. Version-sensitive.)

## Design

- **Inference seam.** Replace `ollamaChat()` (`src/background/service-worker.ts`)
  with `chatCompletion()` that POSTs to `${baseUrl}/v1/chat/completions`:
  ```jsonc
  {
    "model": "...", "messages": [...], "temperature": 0, "stream": false,
    "reasoning_effort": "none",
    "response_format": { "type": "json_schema",
      "json_schema": { "name": "classification", "strict": true,
        "schema": /* CLASSIFICATION_JSON_SCHEMA */ } }
  }
  ```
  Read `choices[0].message.content`. Keep the schema→plain-JSON retry and the
  fail-closed `extractJson` safety net (`src/shared/classification-schema.ts`).
- **Model list + reachability.** `GET /v1/models` replaces Ollama's `/api/tags`
  (agnostic; shows "unavailable" on vLLM). It doubles as the reachability check
  the status bar uses.
- **Drop the `/api/ps` measured GPU/CPU fit** (no OpenAI equivalent): remove
  `getLoadedModels` (service worker), `LoadedModelInfo` + `loaded[]` from
  `TestOllamaResponse` (`src/shared/messages.ts`), the Settings "Measured GPU
  fit" panel (`src/sidepanel/sidepanel.ts`), and `assessVramFit` + its tests
  (now unused).
- **Policy** (`src/shared/ollama-policy.ts`): keep local-only host validation
  and cloud model-name rejection; relax `validateOllamaUrl` to accept a base URL
  (the `/v1/...` path is appended in code) and stop hard-pinning port `11434`
  (default stays `11434`).
- **Manifest: unchanged for the default.** Ollama serves `/v1` on the same
  `127.0.0.1:11434`, so `manifest.json` CSP `connect-src` + `host_permissions`
  need **no edit**. A different backend port (e.g. llama-server `8080`) or a LAN
  host is a **separate, explicit opt-in**, out of scope here.

## Tasks (ordered, each independently verifiable)

1. **Spike:** confirm Ollama `/v1/chat/completions` + `reasoning_effort:"none"` +
   `response_format` returns valid, thinking-free classifications for the
   qwen3.5 default — reuse the bench harness from the `MODEL-BENCHMARK.md` work.
2. Add `chatCompletion()` and the `response_format` wrapper around
   `CLASSIFICATION_JSON_SCHEMA`; swap the classifier/password-policy calls onto
   it; keep retry + `extractJson`.
3. Replace `/api/tags` with `GET /v1/models` for the model list + reachability.
4. Remove the `/api/ps` measured-fit feature and its now-unused code/tests.
5. Relax `validateOllamaUrl` (base URL, configurable port) — keep host local-only
   + cloud rejection; update `tests/ollama-policy.test.ts`.
6. Docs: update `ARCHITECTURE.md`, `SECURITY.md`, `README.md` from `/api/*` to
   `/v1/*`; note server-side thinking-off for non-Ollama backends.

## Privacy / local-only

Unchanged. Using the OpenAI **wire format** against a **self-hosted/local**
server is not a cloud integration; `validateOllamaUrl` still blocks remote hosts
and cloud model names; classification stays **metadata-only — never stored
values**; the ledger stays value-free. Pointing at a LAN box later is a
**deliberate, separate** change to host validation + CSP.

## Risks / wrinkles

- Ollama `/v1` reasoning has known regressions on some models (#15635, #15288);
  qwen3.5 is reported working — the task-1 spike de-risks this before any
  refactor.
- `response_format` / `strict` support varies by backend; the fail-closed parser
  + retry remain the net.
- The crisp measured GPU/CPU fit is Ollama-only and is intentionally dropped (no
  OpenAI equivalent; llama-server `/props` reports total VRAM only).

## Verification (of the eventual implementation)

- `npm run typecheck && npm run lint && npm run test && npm run build` green.
- A/B with the bench harness: same form via native `/api/chat` + `think:false`
  vs `/v1/chat/completions` + `reasoning_effort:"none"` on Ollama → identical
  classifications and similar latency.
- Policy tests still reject remote hosts and cloud model names.

## Decision gate

Do not start coding until the reviewer confirms: **proceed to implement**, or
**keep as a documented option**.
