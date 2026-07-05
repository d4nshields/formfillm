# llama.cpp / llama-server (advanced backend)

[`llama-server`](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
is llama.cpp's built-in OpenAI-compatible server — good for GGUF models, Apple
Silicon, and aggressive quantization. Ollama actually embeds llama.cpp, so this
is mainly for running a specific GGUF or server flags directly. Ollama stays
formfillm's default.

## Run it

```bash
llama-server -m /path/to/model.gguf \
  --host 127.0.0.1 --port 8080 \
  --reasoning-budget 0            # disable model "thinking" (see below)
```

Bind to `127.0.0.1` (loopback) so it isn't exposed on the LAN.

## In formfillm

**Settings → Backend → llama.cpp**, **Base URL** `http://127.0.0.1:8080`,
**Model** (the served name), **Test connection**.

## Notes / quirks

- **Thinking off is server-side only.** llama.cpp has no per-request field for
  it, so the llama.cpp profile sends nothing — you must disable reasoning at
  launch with `--reasoning-budget 0`. (llama.cpp also disables grammar
  enforcement while thinking is *on*, so running it off is doubly correct.)
- **Grammar-enforced JSON:** llama-server enforces `response_format` as a hard
  grammar, so structured output is strict.
