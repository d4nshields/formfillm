# Scaling the LLM backend — concurrency, engine tiers, and a future-proof boundary

> **Status: forward-looking design memo, not a current requirement.**
> formfillm today talks only to a local Ollama on the same machine, and that is
> the right design for the extension as it stands. This memo records what we
> learned while asking a bigger question: *if* inference were later moved off the
> workstation onto a **dedicated GPU box serving many users**, what changes, and
> what would make that transition cheap?

## 1. Why this memo

The extension runs a local model per workstation. For heavier or more complex
queries — or simply to avoid putting an expensive GPU in every workstation — a
natural future architecture is **one shared inference server** that many clients
hit concurrently. That raises a concrete question the rest of this memo answers:
how do local LLM servers actually handle **concurrent** requests, and which one
belongs on a shared box?

None of this is needed for the current extension. It is a roadmap.

## 2. The concurrency claim, fact-checked

A common claim (e.g. in YouTube comparisons) is:

> *"Ollama serves requests one at a time and blocks concurrency, while llama.cpp
> divides GPU resources between concurrent processes."*

It is **half right, with one outright misconception.**

### "Ollama serves one at a time" — true for the default, not a hard limit

Ollama gained real concurrency in mid-2024 (PRs
[#3418](https://github.com/ollama/ollama/pull/3418) and
[#4218](https://github.com/ollama/ollama/pull/4218)). It is controlled by:

- `OLLAMA_NUM_PARALLEL` — concurrent requests per loaded model. **Default is
  conservative (1 in current versions)**, so out of the box requests are
  effectively serialized.
- `OLLAMA_MAX_LOADED_MODELS` — how many models can be resident at once.
- `OLLAMA_MAX_QUEUE` — how many requests queue before rejection (default ~512).

So the "one at a time" behavior is a **default you didn't change**, not a
capability gap. Set `OLLAMA_NUM_PARALLEL>1` and Ollama serves concurrently —
using llama.cpp's batching underneath, because **Ollama embeds llama.cpp as its
engine.** Memory scales roughly linearly with the parallelism × context.

### "llama.cpp divides the GPU between concurrent processes" — mechanism is wrong

`llama-server` does **not** spin up multiple OS processes. It runs **one process
with multiple logical "slots"** doing **continuous (in-flight) batching**:

- Model weights are loaded **once and shared** across all slots.
- A **single unified KV cache** (`--ctx-size`) is split across slots
  (`--parallel N` / `-np N`); a per-sequence mask keeps each request attending
  only to its own tokens.
- Each decode step **batches tokens from all active slots into one GPU kernel
  launch**, which is exactly what makes a GPU efficient.

Separate processes would each need a **full copy of the model in VRAM** — the
*opposite* of efficient. The reason llama.cpp scales under load is **batching,
not processes**.

**Net:** the claim's *conclusion* (llama.cpp handles concurrency better than
stock Ollama) is directionally true; its *explanation* is a misconception, and
the real mechanism is continuous batching plus less-conservative defaults.

## 3. Engine tiers — which tool for which job

Because Ollama *is* llama.cpp under the hood, for a shared many-user box the real
choice is not "Ollama vs llama.cpp" — it is whether to step up to a
purpose-built serving engine.

| Engine | Concurrency model | Best for |
|--------|-------------------|----------|
| **Ollama** | llama.cpp batching, but **opt-in & conservative** (`OLLAMA_NUM_PARALLEL=1` default) | Zero-friction local/desktop dev; single user |
| **llama.cpp / llama-server** | One process, slots, continuous batching, shared KV | Edge / GGUF / Apple Silicon / aggressive quantization; hard JSON-grammar enforcement |
| **vLLM** | **PagedAttention** — paged KV cache, near-zero fragmentation, prefix sharing | Datacenter NVIDIA GPUs, **many concurrent users**, FP16/AWQ/GPTQ |
| **SGLang** | **RadixAttention** — prefix-tree KV reuse | High concurrency **plus structured/JSON output** and shared-prefix workloads |

Indicative throughput under concurrency (version- and hardware-dependent; treat
as orders of magnitude, not guarantees):

- vLLM is roughly **1.2–1.8× faster than llama.cpp at ~16 concurrent requests**,
  and dramatically faster than **default** Ollama (one benchmark cited ~19×).
- SGLang is competitive with or ahead of vLLM on structured-output workloads.

### Why SGLang is interesting *for formfillm specifically*

Every classification call sends the **same large system prompt + JSON schema**
(see `src/shared/prompts.ts` and `src/shared/classification-schema.ts`); only the
per-form field metadata changes. Engines with **prefix caching** (SGLang's
RadixAttention, and prefix sharing in vLLM) would process that shared prefix
**once** and reuse it across users, instead of re-ingesting it on every request.
At single-user scale this is irrelevant; at many-user scale it is a large win.

## 4. The architecture takeaway — one boundary makes the rest cheap

All four engines — Ollama, llama-server, vLLM, SGLang — expose the **same
OpenAI-compatible `POST /v1/chat/completions`** endpoint. So the future-proof
move is not to pivot the engine; it is to make the extension's single inference
call **speak that wire format**. Then:

- **Today:** point at local Ollama (`http://127.0.0.1:11434/v1/...`).
- **Later:** point at a shared `llama-server` / vLLM / SGLang box — a **URL
  change**, with no extension-code change, and free A/B between engines.

### Privacy / local-only consideration (important)

Using the OpenAI **wire format** against a **self-hosted** server is **not** a
cloud integration — it is a protocol, served locally. The local-only guard in
`src/shared/ollama-policy.ts` (`validateOllamaUrl`) still applies. **However**, a
centralized box on the LAN would mean relaxing the strict
`localhost`/`127.0.0.1`/`[::1]` + port-`11434` pin to allow a specific trusted
host. That is a **deliberate, separate security decision** (it widens where
profile-derived prompts can travel — though note classification still sends
*metadata only*, never stored values), not something to enable by default. It
would also touch the `manifest.json` CSP `connect-src` and `host_permissions`.

## 5. Running it on your hardware (dev → LAN service)

The target is a **dedicated LLM service on the local network serving a fixed
number of workstations**, reached by upgrading hardware incrementally. Because
the extension is just an OpenAI-compatible `/v1` client, every stage below is a
**config/URL change, not a code change.**

**Stage 0 — RTX 4060 8 GB (current): dev/test only.**
- Fine for *learning* the serving engines and validating the `/v1` client path
  end to end. **Not** representative of the serving goal — 8 GB leaves almost no
  room for concurrent KV caches once weights are loaded, so the concurrency
  payoff barely materializes.
- If trying SGLang/vLLM here: use a **quantized** small model (AWQ/GPTQ/FP8 —
  their **GGUF support is experimental**, so the Ollama `qwen3.5:4b` GGUF won't
  carry over directly), and cap KV pre-allocation (SGLang `--mem-fraction-static`,
  vLLM `--gpu-memory-utilization`) or it may OOM while reserving cache. For
  day-to-day dev, **Ollama remains the easiest** on this card.

**Stage 1 — RTX 5060 Ti 16 GB (incoming): first real serving box.**
- 16 GB comfortably holds a 4B at FP16 or a 7–14B quantized model **with real KV
  headroom** for modest concurrency — the point where SGLang/vLLM begin to earn
  their keep.
- **Both cards are first-class under CUDA 13.** The 4060 is Ada (`sm_89`) and the
  5060 Ti is Blackwell (`sm_120`); CUDA 13 supports both (only much older archs
  were dropped). A recent driver already exposes CUDA 13.x — note that
  `nvidia-smi`'s "CUDA Version" is the driver's *maximum* supported runtime, not
  an installed toolkit. SGLang now **defaults to CUDA 13** (`cu130`, PyTorch
  2.9.x; CUDA 12.9/`cu129` still supported). So switching the 4060 for the 5060
  Ti is **not** a CUDA-version compatibility problem.
- **The real consideration is build freshness, not the CUDA version.** Ensure
  PyTorch / SGLang / FlashInfer are built with `sm_120` kernels: use **current
  `cu130` wheels or the official SGLang Docker image** (the docs steer Blackwell
  users toward Docker) and don't pin old `cu128` builds. Some Blackwell rough
  edges remain — mostly on large datacenter parts — so verify with current builds
  when the card arrives, and if the attention backend errors, switch it
  (FlashInfer ↔ FlashAttention). For day-to-day dev on either card, **Ollama**
  ships its own runtime and just works on a CUDA 13 driver.

**Stage 2 — dedicated LAN box for N workstations.**
- A **fixed, known client count** makes sizing tractable: provision a bounded
  number of concurrent slots (`--parallel` / `OLLAMA_NUM_PARALLEL`) and size VRAM
  for *N* KV caches, not open-ended scale. Real simultaneity is usually well
  below *N* (workstations rarely classify at the same instant), so a single
  mid-range GPU (16–24 GB) can serve a small office.
- This is where **SGLang's prefix caching** pays off most: every workstation
  reuses the same system-prompt + schema, processed once.
- **The network crossing — not the engine — is the real change.** Pointing the
  extension at a LAN host means relaxing the localhost-only pin (host validation
  + `manifest.json` CSP) to *one trusted host*, ideally fronted by HTTPS/mTLS.
  Treat it as a deliberate security step (see §4). The privacy model still
  holds: classification sends **metadata only**, never stored profile values.

**Recommended path:** keep **Ollama on the 4060 / 5060 Ti for local dev**, stand
up **SGLang or vLLM on the 5060 Ti** to learn the serving side, then graduate to
a **dedicated LAN box** once the workstation count justifies it — all behind the
same `/v1` boundary, so the extension never changes.

## 6. Appendix — if/when you do the backend-agnostic refactor

Not implemented here; this is the map for later.

- **The seam is already clean:** all inference goes through `ollamaChat()` in
  `src/background/service-worker.ts`. That is the one function to generalize.
- **Two real wrinkles:**
  1. **Structured output mapping.** Ollama's native `format: <schema>` becomes
     OpenAI `response_format: { type: "json_schema", json_schema: {...} }`.
     Bonus: llama-server / vLLM / SGLang enforce the schema as a **hard grammar
     constraint** during sampling — stronger than Ollama 0.21.2, which (as we
     found) did not enforce ours. See `docs/MODEL-BENCHMARK.md`.
  2. **"Thinking" control is per-backend.** formfillm relies on thinking-off
     (`think:false`) for both correctness and speed. The equivalent differs by
     engine: Ollama `think:false`; llama.cpp `--reasoning-budget 0`; vLLM/SGLang
     via model/template args. (Caveat: llama.cpp disables grammar enforcement
     when thinking is *on* — fine for us, since we run it off.)
- **What stays Ollama-native and should degrade gracefully:** the Settings model
  list (`/api/tags`) and the measured GPU/CPU fit (`/api/ps` → `assessVramFit` in
  `src/shared/ollama-policy.ts`). These have no clean equivalent on a generic
  OpenAI endpoint; treat them as Ollama-only conveniences that simply hide when
  the backend isn't Ollama.
- **Rough blast radius:** ~3–5 source files (`service-worker.ts`,
  `ollama-policy.ts`, `messages.ts`, `sidepanel.ts`, `types.ts`) plus
  `manifest.json` (CSP/port/host) if a non-localhost host is ever allowed.

## 7. Sources

Figures are version- and hardware-dependent; verify against current releases.

- Ollama concurrency: PRs [#3418](https://github.com/ollama/ollama/pull/3418),
  [#4218](https://github.com/ollama/ollama/pull/4218); [Ollama FAQ](https://docs.ollama.com/faq).
- llama.cpp server & batching: [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md),
  batching discussions [#4130](https://github.com/ggml-org/llama.cpp/discussions/4130)
  and [#15180](https://github.com/ggml-org/llama.cpp/discussions/15180).
- vLLM / PagedAttention: [Inside vLLM](https://vllm.ai/blog/anatomy-of-vllm),
  [vLLM repo](https://github.com/vllm-project/vllm).
- SGLang vs vLLM: [benchmark](https://github.com/qiulang/vllm-sglang-perf).
- SGLang install / CUDA: [install docs — "the major version of CUDA is 13 by default"](https://docs.sglang.io/get_started/install.html),
  [SGLang Release 26.02 (NVIDIA, June 2026)](https://docs.nvidia.com/deeplearning/frameworks/sglang-release-notes/rel-26-02.html),
  consumer-GPU [install guide](https://www.gpu-mart.com/blog/how-to-install-and-use-sglang).
- Blackwell (RTX 50-series, `sm_120`): PyTorch sm_120 in stable
  [#164342](https://github.com/pytorch/pytorch/issues/164342), SGLang Blackwell +
  CUDA 13 [#13342](https://github.com/sgl-project/sglang/issues/13342). (Earlier
  CUDA-12.8-era reports — vLLM [#13306](https://github.com/vllm-project/vllm/issues/13306)
  / [#14452](https://github.com/vllm-project/vllm/issues/14452) — are now
  historical.)
