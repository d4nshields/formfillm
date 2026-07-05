# vLLM (advanced backend)

[vLLM](https://docs.vllm.ai) is a datacenter-grade serving engine
(PagedAttention) — an option for a shared many-user GPU box. Ollama stays
formfillm's default; this is advanced/optional.

## Run it

```bash
# pip (into a venv) — or use the official vLLM Docker image
vllm serve Qwen/Qwen3.5-4B --host 127.0.0.1 --port 8000
```

Bind to `127.0.0.1` (loopback) so it isn't exposed on the LAN.

## In formfillm

**Settings → Backend → vLLM**, **Base URL** `http://127.0.0.1:8000`, **Model**
`Qwen/Qwen3.5-4B`, **Test connection**.

## Notes / quirks

- **Thinking off:** the vLLM profile sends `reasoning_effort:"none"` (honored by
  vLLM's reasoning support). For some models you may instead need
  `chat_template_kwargs:{enable_thinking:false}` set server-side.
- **`GET /v1/models`** may be unavailable on some builds — Settings will then
  show the server as reachable with an empty model list; just type the model
  name. vLLM **grammar-enforces** `response_format`, so structured output is
  strict.
