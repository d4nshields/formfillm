# Plan — backend-agnostic (OpenAI-compatible) inference

> **Status: PLANNED, not implemented. No code has been changed.**
> This is a reviewable implementation plan only. It exists so the decision to
> proceed (or not) can be made deliberately after reviewing the concurrency
> analysis in [SCALING-LLM.md](./SCALING-LLM.md).

## Context

formfillm talks to a local Ollama through Ollama's **native** `/api/*`
endpoints. The concurrency review (see [SCALING-LLM.md](./SCALING-LLM.md))
concluded that a future **centralized GPU box serving many users** would most
likely run **vLLM or SGLang**, and that all candidate backends (Ollama,
llama-server, vLLM, SGLang) expose the **same OpenAI-compatible
`POST /v1/chat/completions`** endpoint.

The cheap, future-proofing move is therefore to generalize the single inference
call to that wire format, so the extension stays a thin client and "move
inference to a shared box later" becomes a configuration change — **not** an
engine rewrite. Ollama remains the zero-friction local default.

This is a learning/architecture exercise; nothing here is required for the
extension to function today.

## Goal

Make the one inference call backend-agnostic via OpenAI-compatible
`/v1/chat/completions`, keeping Ollama the default and **preserving every
privacy invariant** (local-only, metadata-only classification, value-free
ledger, never-fill-secrets, fail-closed).

## Scope

**In:**
- A backend-neutral chat call targeting `{baseUrl}/v1/chat/completions`.
- Map the existing classification JSON schema to OpenAI `response_format`.
- Per-backend "thinking off" handling (we depend on thinking-off; see
  [MODEL-BENCHMARK.md](./MODEL-BENCHMARK.md)).
- Keep Ollama-native niceties (`/api/tags` model list, `/api/ps` measured GPU
  fit) working when the backend is Ollama; hide/degrade gracefully otherwise.

**Out (unchanged invariants / non-goals):**
- No cloud providers, telemetry, analytics, or remote logging.
- No change to the privacy model or the consent UI.
- No multi-user logic inside the extension.
- **Not** allowing non-localhost hosts by default — a LAN/centralized box is a
  separate, explicit security decision (see Risks).

## Design sketch

- **One seam already exists:** `ollamaChat()` in
  `src/background/service-worker.ts`. Generalize it (or add a sibling
  `chatCompletion()`) that builds `{ model, messages, temperature,
  response_format, stream:false }`, posts to `/v1/chat/completions`, and reads
  `choices[0].message.content`. Keep the current `think:false` and
  schema-then-plain-JSON retry semantics, plus the fail-closed `extractJson`
  safety net.
- **Capability split:** treat the model list (`/api/tags`) and measured fit
  (`/api/ps` → `assessVramFit`) as **Ollama-only capabilities**. Invoke them
  only when the backend is Ollama; otherwise the Settings panel shows a short
  "not available for this backend" note instead of failing.
- **Policy:** `src/shared/ollama-policy.ts` keeps host validation
  (localhost-only by default) and cloud model-name rejection. Relax the
  hard-coded `/api/...` path assumption and make the port configurable rather
  than pinned to `11434`. `manifest.json` CSP `connect-src` + `host_permissions`
  must list the allowed local origin(s).

## Tasks (ordered, each independently verifiable)

1. Add the OpenAI-compatible request builder + response parser behind the
   existing inference seam; map `CLASSIFICATION_JSON_SCHEMA` →
   `response_format: { type: "json_schema", json_schema: {...} }`.
2. Generalize "thinking off": keep `think:false` for Ollama; for OpenAI-style
   backends omit it and document that llama.cpp/vLLM/SGLang disable reasoning at
   **server launch** (e.g. llama.cpp `--reasoning-budget 0`).
3. Settings: add an "API style" choice (Ollama-native vs OpenAI-compatible),
   default Ollama-native; local-only validation unchanged.
4. Gate `/api/tags` + `/api/ps` features behind the Ollama capability; graceful
   empty state otherwise.
5. `manifest.json`: parameterize the allowed local origin; default stays
   `http://127.0.0.1:11434`. (Non-local host remains a separate opt-in.)
6. Tests: `response_format` mapping; OpenAI response parsing; policy still
   rejects remote hosts + cloud model names; capability gating.
7. Docs: update `ARCHITECTURE.md` and `SECURITY.md` for the boundary; cross-link
   `SCALING-LLM.md`.

## Privacy / local-only

- Using the OpenAI **wire format** against a **self-hosted/local** server is not
  a cloud integration; `validateOllamaUrl` still blocks remote hosts and cloud
  model names.
- Pointing at a LAN box (the eventual shared server) is a **deliberate, separate
  change** to host validation + CSP. Even then, classification sends **metadata
  only — never stored profile values** — and the ledger stays value-free, so the
  blast radius of widening the host is bounded by design.

## Risks / wrinkles

- `response_format` support and strictness vary by backend; the fail-closed
  `extractJson` + schema→JSON retry remain the safety net.
- "Thinking" control is partly **server-side** (launch flags) and outside the
  extension's reach — document for whoever operates the backend.
- The crisp `/api/ps` VRAM-fit readout has no clean equivalent on non-Ollama
  backends (llama-server `/props` reports total VRAM only), so that feature
  necessarily degrades off Ollama.

## Verification

- `npm run typecheck && npm run lint && npm run test && npm run build` green.
- Manual A/B: classify the same form via (a) the legacy Ollama `/api/chat` path
  and (b) Ollama's OpenAI `/v1/chat/completions` path; confirm identical
  classifications.
- Confirm remote/cloud URLs and cloud model names are still rejected (tests).

## Decision gate

Do not start coding until the reviewer (project owner) confirms: **proceed to
implement**, or **keep as a documented option**. Rationale and engine analysis:
[SCALING-LLM.md](./SCALING-LLM.md).
