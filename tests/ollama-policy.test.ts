import { describe, expect, it } from "vitest";
import {
  assessModel,
  FALLBACK_MODELS,
  getModelParamBillions,
  RECOMMENDED_MODEL,
  TOO_LARGE_MODELS,
  validateModelName,
  validateOllamaUrl,
} from "../src/shared/ollama-policy.js";

describe("validateOllamaUrl", () => {
  it("accepts the local default", () => {
    const r = validateOllamaUrl("http://127.0.0.1:11434");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe("http://127.0.0.1:11434");
  });

  it("accepts localhost and [::1]", () => {
    expect(validateOllamaUrl("http://localhost:11434").ok).toBe(true);
    expect(validateOllamaUrl("http://[::1]:11434").ok).toBe(true);
  });

  it("tolerates a trailing slash", () => {
    const r = validateOllamaUrl("http://localhost:11434/");
    expect(r.ok).toBe(true);
  });

  it("rejects remote hosts", () => {
    expect(validateOllamaUrl("http://example.com:11434").ok).toBe(false);
    expect(validateOllamaUrl("http://10.0.0.5:11434").ok).toBe(false);
    expect(validateOllamaUrl("https://api.ollama.com").ok).toBe(false);
  });

  it("rejects https (non-http transports)", () => {
    expect(validateOllamaUrl("https://127.0.0.1:11434").ok).toBe(false);
  });

  it("accepts any port on a local host (Ollama 11434, SGLang 30000, llama-server 8080)", () => {
    const r = validateOllamaUrl("http://127.0.0.1:30000");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe("http://127.0.0.1:30000");
    expect(validateOllamaUrl("http://localhost:8080").ok).toBe(true);
  });

  it("still rejects remote hosts regardless of port", () => {
    expect(validateOllamaUrl("http://example.com:30000").ok).toBe(false);
    expect(validateOllamaUrl("http://10.0.0.5:8080").ok).toBe(false);
  });

  it("rejects empty and malformed input", () => {
    expect(validateOllamaUrl("").ok).toBe(false);
    expect(validateOllamaUrl("not a url").ok).toBe(false);
  });
});

describe("validateModelName cloud rejection", () => {
  it("rejects :cloud and -cloud and standalone cloud", () => {
    expect(validateModelName("qwen3.5:cloud").ok).toBe(false);
    expect(validateModelName("some-model-cloud").ok).toBe(false);
    expect(validateModelName("cloud-llm:7b").ok).toBe(false);
  });

  it("rejects hosted provider tokens and URLs", () => {
    expect(validateModelName("openai/gpt-4").ok).toBe(false);
    expect(validateModelName("http://host/model").ok).toBe(false);
    expect(validateModelName("anthropic-claude").ok).toBe(false);
  });

  it("accepts ordinary local models", () => {
    expect(validateModelName("qwen3.5:9b").ok).toBe(true);
    expect(validateModelName("qwen2.5:7b").ok).toBe(true);
    expect(validateModelName("llama3.1:8b").ok).toBe(true);
  });
});

describe("getModelParamBillions", () => {
  it("extracts size from tag", () => {
    expect(getModelParamBillions("qwen3.5:9b")).toBe(9);
    expect(getModelParamBillions("qwen3.5:27b")).toBe(27);
    expect(getModelParamBillions("qwen3.5:122b")).toBe(122);
    expect(getModelParamBillions("qwen2.5:7b")).toBe(7);
  });
  it("returns null when no size tag", () => {
    expect(getModelParamBillions("qwen3.5")).toBeNull();
  });
});

describe("assessModel recommendations", () => {
  it("marks the recommended model", () => {
    const a = assessModel(RECOMMENDED_MODEL);
    expect(a.cloudRejected).toBe(false);
    expect(a.fit).toBe("recommended");
    expect(a.warning).toBeNull();
  });

  it("marks fallbacks supported", () => {
    for (const m of FALLBACK_MODELS) {
      const a = assessModel(m);
      expect(a.cloudRejected).toBe(false);
      expect(a.fit).toBe("supported");
    }
  });

  it("warns on too-large models", () => {
    for (const m of TOO_LARGE_MODELS) {
      const a = assessModel(m);
      expect(a.fit).toBe("large");
      expect(a.warning).toMatch(/not recommended|too large/i);
    }
  });

  it("warns on large param counts generally", () => {
    expect(assessModel("llama3:70b").fit).toBe("large");
  });

  it("warns on unpinned names", () => {
    const a = assessModel("qwen3.5");
    expect(a.fit).toBe("unpinned");
    expect(a.warning).toMatch(/pin/i);
  });

  it("flags sub-4B models as below the tested minimum", () => {
    const a = assessModel("qwen3.5:2b");
    expect(a.cloudRejected).toBe(false);
    expect(a.fit).toBe("below_min");
    expect(a.paramBillions).toBe(2);
    expect(a.warning).toMatch(/minimum|below/i);
  });

  it("flags cloud models as rejected", () => {
    const a = assessModel("qwen3.5:cloud");
    expect(a.cloudRejected).toBe(true);
  });
});
