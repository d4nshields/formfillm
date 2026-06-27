# Model benchmark — classification latency & quality (`qwen3.5:4b` vs `:2b`)

**TL;DR.** On the reference 8 GB machine, a full 10-field form classifies in
**~9.0 s on `qwen3.5:4b`** versus **~7.2 s on `qwen3.5:2b`**. The time is almost
entirely token generation. `:2b` is ~1.5× faster per token, but on this task it
was **unreliable** (it emitted malformed JSON that fail-closes every field to
"manual review") and, when it does parse, rates sensitivity more coarsely. `:4b`
classified **10/10 fields correctly and deterministically**. We keep `:4b` as
the default. The benchmarking also surfaced and fixed a correctness bug and an
output-size optimization (details below).

## Test environment

| | |
|---|---|
| GPU | NVIDIA GeForce RTX 4060, 8 GB (8188 MiB), driver 595.71.05 |
| CPU | AMD Ryzen 5 3600 (6 cores / 12 threads) |
| RAM | 45 GiB |
| OS | Ubuntu 26.04 LTS, kernel 7.0.0 |
| Ollama | 0.21.2 |
| Model A | `qwen3.5:4b` — 4.7B params, Q4_K_M, 3.39 GB on disk (~5.9 GB resident, **0 % CPU offload**) |
| Model B | `qwen3.5:2b` — 2.3B params, Q8_0, 2.74 GB on disk |

Both models fit fully in the 8 GB GPU (verified via Ollama `/api/ps`:
`size_vram == size`), so neither pays a CPU-offload penalty.

## Method

- **Workload:** a representative 10-field registration form — first name, last
  name, email, date of birth, phone, street address, city, postal code,
  password, confirm-password.
- **Faithful request:** the harness bundles the *actual* extension modules
  (`src/shared/prompts.ts`, `src/shared/classification-schema.ts`) and sends the
  exact request the service worker builds: `POST /api/chat`, `stream:false`,
  schema-constrained `format`, `think:false`, `temperature:0`, `keep_alive:30m`.
- **Warm measurement:** each model is called twice back-to-back; the second
  (warm) call is measured so model-load time is excluded. Reported figures are
  the median of 3 warm runs. `temperature:0` makes generation deterministic, so
  run-to-run variance was < 1 %.
- **Timing source:** Ollama's own `total_duration` / `load_duration` /
  `prompt_eval_*` / `eval_*` fields, plus client wall-clock.
- **Correctness:** the model output is run through the real
  `validateClassificationResponse`; "classified N/10" counts fields that came
  back with a concrete (non-`unknown`) sensitivity.

## Results (warm, median of 3)

| Metric | `:4b` (optimized) | `:2b` (optimized) |
|---|---|---|
| Wall-clock | **8.97 s** | **7.22 s** |
| Generation time | 8.0 s | 6.5 s |
| Generation tokens | 499 | 588 |
| Throughput | 62.3 tok/s | 91.0 tok/s |
| Prompt eval | ~0.09 s (≈2.1–5 k tok/s) | ~0.04 s |
| Warm load | ~0.2 s | ~0.2 s |
| **Correctly classified** | **10 / 10** | **0 / 10** |
| Validator errors | 0 | 1 |

Per-field sensitivity from `:4b` (correct and well-differentiated):

```
first/last name, email, phone, street, city, postal → medium
date of birth                                        → high
password, confirm password                           → secret
```

## Analysis

**It's generation-bound.** Prompt evaluation is ~0.1 s (the GPU ingests the
prompt at thousands of tok/s) and warm load is ~0.2 s. Essentially all the wall
time is the model emitting output tokens, so:

```
generation_time ≈ output_tokens ÷ throughput(tok/s)
```

That gives two independent levers — **fewer tokens** (numerator) or **a faster
model** (denominator) — and the numerator is the one that doesn't cost quality.

**`:2b` is faster per token but unreliable here.** Throughput was 91 vs 62
tok/s (~1.46×, in line with its smaller active-parameter count; note `:2b` ships
at Q8_0 vs `:4b` at Q4_K_M, so it is not a clean "half the size"). But on this
form `:2b` consistently produced **structurally invalid JSON** — an unbalanced
`{"classifications":[…]` wrapper — which the validator rejects, fail-closing all
ten fields to `unknown` / `manual_review`. It is brittle: trivial prompt changes
(e.g. adding `autocomplete="new-password"` to the password fields, as real forms
do) flip it between valid and invalid output. Even in an earlier run where it
*did* parse, `:2b` rated sensitivity more coarsely (marking email, DOB, phone,
and address as `low` rather than `medium`).

**Two issues were found and fixed while benchmarking (commit alongside this doc):**

1. **Correctness bug (pre-existing).** With the original prompt, `qwen3.5`
   returned a *nested* per-field shape — `{fieldId, classifications:[{…}]}` —
   that `validateClassificationItem` couldn't read, silently collapsing every
   field to `unknown`. Ollama 0.21.2 did **not** enforce our JSON schema as a
   hard grammar (schema-mode and plain-`json` mode produced identical output),
   so the *prompt* has to pin the shape. Fix: the prompt now shows the exact
   **flat** one-object-per-field shape, and `validateClassificationResponse` +
   `extractJson` now also accept a bare top-level `[…]` array (and a
   `{fields:[…]}` wrapper), which is what `:4b` actually emits.
2. **Output-size optimization.** ~89 tokens/field was mostly free-text
   (`plainLanguageReason` + `possiblePurpose`). Constraining those to a short
   clause / short phrase, emptying `warnings` unless a field is high-risk, and
   dropping the unused `confidence` field cut `:4b` from **630 → 499 generation
   tokens (~21 %)** and **11.1 s → 9.0 s (~19 %)** with **no loss of
   classification quality** (still 10/10). This stacks with — and is cheaper
   than — switching models.

**Secret safety does not depend on the model.** `reconcileClassification`
applies a category-sensitivity floor and forces password / SSN / banking / 2FA
fields to `never_fill` in code, and unreadable output fails closed to
`manual_review`. So a weaker model can only ever *under-explain* or *under-warn*
— it can never cause formfillm to fill a secret or fill against the user's
intent.

## Decision & justification

**Keep `qwen3.5:4b` as the default; `:2b` remains an optional fast fallback,
not recommended.**

- **Correctness over ~1.8 s.** After the optimization, `:4b` is only ~1.8 s
  slower than `:2b` per form, and it classifies 10/10 deterministically with
  correct, differentiated sensitivity. `:2b` returned 0/10 on this form and is
  prompt-fragile.
- **It's a consent tool.** The entire value is accurate, legible per-field
  sensitivity so a human can decide what to disclose. A model that flattens
  sensitive personal data to "low" — or fail-closes everything to "manual
  review" — defeats that purpose, even if it's faster.
- **`:4b` fits the 8 GB minimum fully** (0 % CPU offload) and now runs a full
  10-field form in ~9 s. Larger/faster GPUs can run bigger qwen3.5 variants for
  higher quality; smaller setups can fall back to `:2b` understanding the
  reliability trade-off.

Users can always change the model in **Settings**, and **Settings → Test Ollama
connection** reports the measured GPU/CPU split for whatever they load.

---

*Numbers are for one synthetic 10-field form at `temperature:0` on the hardware
above; absolute times scale with form size and GPU, but the generation-bound
profile and the `:4b`-vs-`:2b` reliability gap hold.*
