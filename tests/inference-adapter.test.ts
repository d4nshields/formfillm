import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiChatBackend } from "../src/shared/inference/openai-adapter.js";
import { BACKEND_PROFILES } from "../src/shared/inference/profiles.js";
import type { ChatRequest } from "../src/shared/inference/port.js";

const BASE = "http://127.0.0.1:11434";

function baseReq(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "qwen3.5:4b",
    system: "sys",
    user: "usr",
    temperature: 0,
    schema: { type: "object" },
    schemaName: "field_classification",
    jsonSchemaMode: true,
    ...over,
  };
}

function okChat(content: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
}

/** A 4xx response, including the clone() the adapter peeks before retrying. */
function errChat(status: number, text: string) {
  return { ok: false, status, text: async () => text, clone: () => ({ text: async () => text }) };
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, i = 0): Record<string, unknown> {
  const call = fetchMock.mock.calls[i];
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAiChatBackend.chat — request shaping", () => {
  it("POSTs /v1/chat/completions with json_schema + Ollama reasoning_effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChat('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).chat(baseReq());
    expect(out).toBe('{"ok":true}');

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/v1/chat/completions`);
    const body = sentBody(fetchMock);
    expect(body.model).toBe("qwen3.5:4b");
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.reasoning_effort).toBe("none");
    const rf = body.response_format as { type: string; json_schema: { name: string; strict: boolean } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("field_classification");
    expect(rf.json_schema.strict).toBe(true);
  });

  it("uses SGLang's chat_template_kwargs instead of reasoning_effort", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChat("[]"));
    vi.stubGlobal("fetch", fetchMock);

    await new OpenAiChatBackend("http://127.0.0.1:30000", BACKEND_PROFILES.sglang).chat(baseReq());
    const body = sentBody(fetchMock);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("forcePlainJson downgrades response_format to json_object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChat("[]"));
    vi.stubGlobal("fetch", fetchMock);

    await new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).chat(baseReq({ forcePlainJson: true }));
    expect(sentBody(fetchMock).response_format).toEqual({ type: "json_object" });
  });
});

describe("OpenAiChatBackend.chat — error handling", () => {
  it("retries WITHOUT thinking-off on a 4xx that mentions reasoning", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errChat(400, "unknown field reasoning_effort"))
      .mockResolvedValueOnce(okChat('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).chat(baseReq());
    expect(out).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // second attempt dropped the thinking-off field
    expect(sentBody(fetchMock, 1).reasoning_effort).toBeUndefined();
  });

  it("gives a clear 403 message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errChat(403, "forbidden")));
    await expect(new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).chat(baseReq())).rejects.toThrow(/403/);
  });

  it("throws when the model returns empty content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okChat("")));
    await expect(new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).chat(baseReq())).rejects.toThrow(/no content/i);
  });

  it("wraps a network failure with the backend label", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).chat(baseReq())).rejects.toThrow(/Ollama server/i);
  });
});

describe("OpenAiChatBackend.listModels", () => {
  it("parses ids from GET /v1/models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "qwen3.5:4b" }, { id: "qwen3.5:2b" }] }) }),
    );
    const models = await new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).listModels();
    expect(models).toEqual(["qwen3.5:4b", "qwen3.5:2b"]);
  });

  it("returns [] when reachable but /v1/models is unavailable (non-ok)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await new OpenAiChatBackend(BASE, BACKEND_PROFILES.vllm).listModels()).toEqual([]);
  });

  it("throws when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(new OpenAiChatBackend(BASE, BACKEND_PROFILES.ollama).listModels()).rejects.toThrow();
  });
});
