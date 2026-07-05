# Model-server backends

formfillm talks to **one local, OpenAI-compatible model server at a time** via
`POST /v1/chat/completions`. Because every supported engine speaks that same
wire format, switching between them is **configuration, not code**: pick a
backend in **Settings**, which selects a *profile*
(`src/shared/inference/profiles.ts`) — its default loopback URL and how it
disables model "thinking".

| Backend | Default URL | Setup | Notes |
|---------|-------------|-------|-------|
| **[Ollama](./ollama.md)** | `http://127.0.0.1:11434` | trivial | **Default.** Best for a single workstation. |
| **[SGLang](./sglang.md)** | `http://127.0.0.1:30000` | Docker | Grammar-enforces JSON; strong for a shared many-user GPU box. |
| **[vLLM](./vllm.md)** | `http://127.0.0.1:8000` | pip/Docker | Datacenter-grade concurrency. |
| **[llama.cpp](./llamacpp.md)** | `http://127.0.0.1:8080` | build/binary | GGUF, Apple Silicon, aggressive quantization. |

**Privacy is unchanged across all of them.** The host must be loopback
(`127.0.0.1`/`localhost`) — remote/cloud is rejected by both the URL policy
(`validateOllamaUrl`) and the manifest CSP. Any port is allowed so these can
coexist on one machine. Classification always sends **metadata only**.

For *why* one might move to a shared serving box (concurrency, prefix caching)
and the hardware path, see [../SCALING-LLM.md](../SCALING-LLM.md).
