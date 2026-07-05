import { describe, expect, it } from "vitest";
import { backendProfile, BACKEND_PROFILES } from "../src/shared/inference/profiles.js";

describe("backend profiles — thinking-off strategy", () => {
  it("Ollama disables thinking with reasoning_effort:none", () => {
    const body: Record<string, unknown> = {};
    BACKEND_PROFILES.ollama.applyThinkingOff(body);
    expect(body).toEqual({ reasoning_effort: "none" });
  });

  it("vLLM also uses reasoning_effort:none", () => {
    const body: Record<string, unknown> = {};
    BACKEND_PROFILES.vllm.applyThinkingOff(body);
    expect(body.reasoning_effort).toBe("none");
  });

  it("SGLang uses chat_template_kwargs.enable_thinking=false (NOT reasoning_effort)", () => {
    const body: Record<string, unknown> = {};
    BACKEND_PROFILES.sglang.applyThinkingOff(body);
    expect(body).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("SGLang preserves any existing chat_template_kwargs", () => {
    const body: Record<string, unknown> = { chat_template_kwargs: { foo: 1 } };
    BACKEND_PROFILES.sglang.applyThinkingOff(body);
    expect(body.chat_template_kwargs).toEqual({ foo: 1, enable_thinking: false });
  });

  it("llama.cpp is a per-request no-op (disabled at server launch)", () => {
    const body: Record<string, unknown> = { a: 1 };
    BACKEND_PROFILES.llamacpp.applyThinkingOff(body);
    expect(body).toEqual({ a: 1 });
  });

  it("every profile has a loopback default URL and a docs pointer", () => {
    for (const p of Object.values(BACKEND_PROFILES)) {
      expect(p.defaultBaseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
      expect(p.docs).toMatch(/^docs\/backends\/.+\.md$/);
    }
  });

  it("backendProfile falls back to Ollama for an unknown id", () => {
    expect(backendProfile("nope" as never).id).toBe("ollama");
    expect(backendProfile("sglang").id).toBe("sglang");
  });
});
