# SGLang (advanced backend)

[SGLang](https://docs.sglang.io) is a high-throughput serving engine. For
formfillm it's an *optional, advanced* backend — most useful as a shared
many-user GPU box (RadixAttention prefix caching, and it **grammar-enforces** the
JSON schema, so the unclosed-array quirk we see on Ollama can't happen). Ollama
stays the default; this is for testing/serving.

## Run it with Docker (recommended)

**Why Docker, not a native install:** on a bleeding-edge OS (e.g. Ubuntu 26.04)
the CUDA toolkit's headers can conflict with a newer system glibc, so SGLang's
runtime kernel JIT fails to compile on the host. The official image ships a
matched glibc + CUDA + prebuilt Blackwell (`sm_120`) kernels, sidestepping that.
See [../SCALING-LLM.md](../SCALING-LLM.md) for the CUDA/Blackwell details.

### 1. One-time host setup — Docker + NVIDIA Container Toolkit

```bash
# Docker engine
sudo apt-get update && sudo apt-get install -y docker.io
sudo systemctl enable --now docker

# NVIDIA Container Toolkit (adds NVIDIA's apt repo)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker

sudo usermod -aG docker "$USER"     # then log out/in (or: newgrp docker)
sudo docker run --rm --gpus all ubuntu:24.04 nvidia-smi   # verify GPU is visible
```

### 2. Launch SGLang (loopback only)

```bash
docker run --rm -it --gpus all --ipc=host --shm-size 16g \
  -p 127.0.0.1:30000:30000 \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  --name formfillm-sglang \
  lmsysorg/sglang:latest \
  python3 -m sglang.launch_server \
    --model-path Qwen/Qwen3.5-4B \
    --host 0.0.0.0 --port 30000 \
    --context-length 8192 --mem-fraction-static 0.85 \
    --reasoning-parser qwen3
```

- `-p 127.0.0.1:30000:30000` binds the port to **loopback only** (never the
  LAN), matching formfillm's local-only model.
- Mounts your HF cache, so an already-downloaded `Qwen/Qwen3.5-4B` isn't
  re-pulled. First launch still pulls the image and warms kernels — be patient.

### 3. Smoke-test the endpoint (second terminal)

```bash
curl -fsS http://127.0.0.1:30000/v1/models | python3 -m json.tool
curl -fsS http://127.0.0.1:30000/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model":"Qwen/Qwen3.5-4B","temperature":0,"stream":false,
  "chat_template_kwargs":{"enable_thinking":false},
  "messages":[{"role":"user","content":"Reply with only this JSON: {\"ok\":true}"}]
}' | python3 -m json.tool
```

## In formfillm

**Settings → Backend → SGLang**, **Base URL** `http://127.0.0.1:30000`, **Model**
`Qwen/Qwen3.5-4B`, **Test connection**, scan. Switch back by choosing **Ollama**.

The SGLang profile disables thinking with `chat_template_kwargs:{enable_thinking:
false}` (SGLang ignores `reasoning_effort`), so no extra request tuning is
needed on your side.

## Troubleshooting

- **OOM at startup:** lower `--mem-fraction-static` to `0.80` (Qwen3.5-4B is a
  hybrid Mamba+MoE model, so its caches run heavier).
- **FlashInfer errors on `sm_120`:** append `--attention-backend triton
  --sampling-backend pytorch`.
