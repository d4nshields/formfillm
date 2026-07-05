# Ollama (default backend)

Ollama is formfillm's default and needs no configuration beyond pulling a model.
It's the right choice for a single workstation.

## Setup

```bash
# install from https://ollama.com, then:
ollama pull qwen3.5:4b        # recommended minimum (fits an 8 GB GPU fully)
ollama list
curl http://127.0.0.1:11434/v1/models   # the OpenAI-compatible endpoint formfillm uses
```

Model sizing (pick the largest that fits your GPU's VRAM) is in the
[main README](../../README.md#quick-start); latency-vs-quality numbers behind the
`:4b` default are in [../MODEL-BENCHMARK.md](../MODEL-BENCHMARK.md).

## In formfillm

**Settings → Backend → Ollama** (default), **Base URL** `http://127.0.0.1:11434`,
**Model** `qwen3.5:4b`, **Test connection**.

## If you get a 403

Ollama checks the request `Origin`. Allow the extension and restart Ollama:

```bash
export OLLAMA_ORIGINS='chrome-extension://*'   # macOS/Linux, current shell
setx OLLAMA_ORIGINS "chrome-extension://*"     # Windows (PowerShell, persistent)
```

## Notes / quirks

- **Thinking off:** formfillm sends `reasoning_effort:"none"` (Ollama honors it
  over `/v1`). Without it, reasoning models like qwen3.x emit empty content.
- **Schema is NOT hard-enforced.** Ollama's `/v1` `response_format` is a hint,
  not a grammar, so the model can occasionally emit an unclosed JSON array;
  formfillm's parser repairs that (`extractJson`). SGLang/vLLM enforce it.
- Ollama exposes no total-VRAM endpoint, so formfillm doesn't show a GPU-fit
  readout — pick a model that fits and watch for slow (CPU-offloaded) generation.
