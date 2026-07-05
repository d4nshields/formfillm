/*
 * formfillm — inference PORT (ports-and-adapters).
 *
 * The single boundary the rest of the extension uses to talk to a model. The
 * only adapter today is the OpenAI-compatible HTTP one (openai-adapter.ts),
 * because every local backend we target (Ollama, SGLang, vLLM, llama-server)
 * speaks the same `/v1` wire format — so "switch backend" is a profile/URL
 * choice, not a new adapter. The port keeps that choice out of the handlers.
 */

/** One classification/extraction request, backend-agnostic. */
export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  temperature: number;
  /** JSON schema for structured output, and a name for it. */
  schema: object;
  schemaName: string;
  /** Prefer json_schema response_format; else plain json_object. */
  jsonSchemaMode: boolean;
  /** Force plain json_object (used by the schema→JSON retry). */
  forcePlainJson?: boolean;
}

export interface ChatBackend {
  /**
   * Run one chat completion and return the raw message content (still
   * untrusted/unparsed — callers run it through extractJson + validation).
   * Throws on transport error, HTTP error, or empty content.
   */
  chat(req: ChatRequest): Promise<string>;

  /**
   * List available model ids (for Settings). Returns [] when the backend is
   * reachable but exposes no list (e.g. some vLLM builds); THROWS when the
   * server is unreachable, so the caller can report "not reachable".
   */
  listModels(): Promise<string[]>;
}
