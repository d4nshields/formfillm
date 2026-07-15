# Ollama (default backend)

Ollama is formfillm's default and needs almost no configuration — pull a model
and allow the extension origin (`OLLAMA_ORIGINS`, see below; **required**, or
every scan 403s). It's the right choice for a single workstation. On macOS and
Windows the desktop app runs the server automatically (menu bar / system tray) —
no `ollama serve` needed; on Linux start it with `ollama serve`.

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

## Allow the extension origin (`OLLAMA_ORIGINS`) — required

Not optional: without it every scan 403s, even though `curl` and **Test
connection** succeed (they come from allowed origins; the extension's
`chrome-extension://…` origin does not). Ollama checks the request `Origin` and
rejects unlisted ones. Allow it:

```bash
export OLLAMA_ORIGINS='chrome-extension://*'   # macOS/Linux, current shell
setx OLLAMA_ORIGINS "chrome-extension://*"     # Windows (PowerShell, persistent)
```

Then **restart Ollama so the running server picks up the value** — setting the
variable does not affect the process already running:

- **Windows / macOS:** quit the app from the **system tray / menu bar**
  (right-click the icon → **Quit**; closing the window is not enough), then
  relaunch. `setx` alone will not take effect until you do this.
- **Linux:** restart `ollama serve` (or `systemctl restart ollama`).

A 403 means the request *reached* the server and was refused on origin grounds —
not a "server not running" error (that would be a connection failure instead).

## Notes / quirks

- **Thinking off:** formfillm sends `reasoning_effort:"none"` (Ollama honors it
  over `/v1`). Without it, reasoning models like qwen3.x emit empty content.
- **Schema is NOT hard-enforced.** Ollama's `/v1` `response_format` is a hint,
  not a grammar, so the model can occasionally emit an unclosed JSON array;
  formfillm's parser repairs that (`extractJson`). SGLang/vLLM enforce it.
- Ollama exposes no total-VRAM endpoint, so formfillm doesn't show a GPU-fit
  readout — pick a model that fits and watch for slow (CPU-offloaded) generation.
