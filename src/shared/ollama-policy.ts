/*
 * formfillm — Ollama local-only policy
 *
 * The entire privacy promise rests on never talking to anything but a local
 * server. These pure functions are the gatekeepers and are exercised hard by
 * the unit tests. They are intentionally conservative: when in doubt, reject.
 *
 * The host is restricted to localhost, and any local port is allowed so the
 * same OpenAI-compatible client can reach Ollama (11434), SGLang (30000),
 * llama-server (8080), etc. on the same machine. Defense in depth: the manifest
 * CSP `connect-src` + `host_permissions` are scoped to the loopback hosts
 * (127.0.0.1/localhost) on ANY port — loopback only, so even a bug here can
 * never reach the network or the cloud.
 */

/** Hostnames we consider "local". Anything else is rejected outright. */
export const ALLOWED_OLLAMA_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

/** The Ollama default port, used as the settings default and in CSP. */
export const DEFAULT_OLLAMA_PORT = "11434";

export type UrlValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

/**
 * Accept only http://{localhost|127.0.0.1|[::1]}[:port] (trailing slash
 * tolerated). The host must be local; any port is allowed so one client can
 * reach Ollama / llama-server / SGLang on the same machine. Rejects remote
 * hosts and any non-http transport. (The manifest CSP + host_permissions are
 * the harder gate and are scoped to the loopback hosts on any port.)
 */
export function validateOllamaUrl(raw: string): UrlValidation {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, reason: "Ollama URL is empty." };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: `Not a valid URL: "${input}".` };
  }

  if (url.protocol !== "http:") {
    return {
      ok: false,
      reason: `Only http:// is allowed for local Ollama (got "${url.protocol}"). Remote/secure transports are blocked.`,
    };
  }

  // url.hostname returns IPv6 in bracketed form (e.g. "[::1]"); strip brackets.
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLocal) {
    return {
      ok: false,
      reason: `Host "${url.hostname}" is not local. Only localhost, 127.0.0.1, or [::1] are allowed — remote Ollama hosts are disabled in this MVP.`,
    };
  }

  // Any port is accepted for a local host (default remains 11434); the manifest
  // CSP + host_permissions cover loopback on any port.

  if (url.pathname !== "/" && url.pathname !== "") {
    return { ok: false, reason: "Provide only the base URL (no path), e.g. http://127.0.0.1:11434." };
  }

  // Normalise to scheme://host:port with no trailing slash.
  const normalized = `${url.protocol}//${url.host}`;
  return { ok: true, normalized };
}

export type ModelValidation = { ok: true } | { ok: false; reason: string };

// Tokens that indicate a hosted/remote API rather than a local model.
const CLOUD_HOST_TOKENS = [
  "openai",
  "anthropic",
  "openrouter",
  "googleapis",
  "azure",
  "bedrock",
  "together.ai",
  "groq",
];

/**
 * Reject model names that imply cloud/hosted execution:
 *  - contains ":cloud"
 *  - ends with "-cloud"
 *  - has a standalone "cloud" token
 *  - looks like a URL (contains "://")
 *  - references a known hosted-API host token
 */
export function validateModelName(raw: string): ModelValidation {
  const name = (raw ?? "").trim();
  if (!name) return { ok: false, reason: "Model name is empty." };

  const lower = name.toLowerCase();

  if (lower.includes("://")) {
    return { ok: false, reason: `Model name "${name}" looks like a URL. Use a local model name only.` };
  }
  if (lower.includes(":cloud")) {
    return { ok: false, reason: `Model "${name}" uses a ":cloud" tag, which runs remotely. Cloud models are blocked.` };
  }
  if (lower.endsWith("-cloud")) {
    return { ok: false, reason: `Model "${name}" ends with "-cloud", which runs remotely. Cloud models are blocked.` };
  }
  // Standalone "cloud" token bounded by start/end or non-alphanumeric separators.
  if (/(^|[^a-z0-9])cloud([^a-z0-9]|$)/.test(lower)) {
    return { ok: false, reason: `Model "${name}" references "cloud" execution, which is blocked.` };
  }
  for (const token of CLOUD_HOST_TOKENS) {
    if (lower.includes(token)) {
      return {
        ok: false,
        reason: `Model "${name}" references hosted provider "${token}". Only local models are allowed.`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Model size guidance for the target dev machine (RTX 4060, 8 GB VRAM).
// ---------------------------------------------------------------------------

export type ModelFit = "recommended" | "supported" | "large" | "unpinned" | "unknown";

export interface ModelAssessment {
  /** True if the name is rejected as cloud/remote (see validateModelName). */
  cloudRejected: boolean;
  cloudReason?: string;
  fit: ModelFit;
  /** Estimated parameter count in billions, or null if not encoded in name. */
  paramBillions: number | null;
  /** Human-readable warning to show in the UI, or null if none. */
  warning: string | null;
}

/**
 * The model pinned as recommended for the target machine. 4B fully fits an
 * 8 GB GPU; 9B measured at ~28% CPU offload on an RTX 4060, which is slow.
 */
export const RECOMMENDED_MODEL = "qwen3.5:4b";

/** Fallback models, in order of preference, all expected to run locally. */
export const FALLBACK_MODELS = ["qwen3.5:2b", "qwen2.5:7b"] as const;

/** Models explicitly flagged as too large for an 8 GB GPU. */
export const TOO_LARGE_MODELS = ["qwen3.5:27b", "qwen3.5:35b", "qwen3.5:122b"] as const;

/** Above this parameter count we warn about 8 GB VRAM limits. */
const LARGE_PARAM_THRESHOLD_B = 14;

/** Extract the parameter size (in billions) encoded in a model tag, if any. */
export function getModelParamBillions(name: string): number | null {
  const tag = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  const m = tag.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Assess a model for the target dev machine. Never blocks advanced users from
 * typing an arbitrary local model name (except cloud names, which are
 * rejected) but warns clearly when a choice is likely slow or CPU-offloaded.
 */
export function assessModel(raw: string): ModelAssessment {
  const name = (raw ?? "").trim();
  const cloud = validateModelName(name);
  if (!cloud.ok) {
    return { cloudRejected: true, cloudReason: cloud.reason, fit: "unknown", paramBillions: null, warning: cloud.reason };
  }

  const paramBillions = getModelParamBillions(name);

  if (name === RECOMMENDED_MODEL) {
    return {
      cloudRejected: false,
      fit: "recommended",
      paramBillions,
      warning: null,
    };
  }

  if ((TOO_LARGE_MODELS as readonly string[]).includes(name)) {
    return {
      cloudRejected: false,
      fit: "large",
      paramBillions,
      warning: `"${name}" is not recommended by default — large models are often partially CPU-offloaded on smaller GPUs (slow). Load it and check the measured GPU/CPU split.`,
    };
  }

  if ((FALLBACK_MODELS as readonly string[]).includes(name)) {
    return { cloudRejected: false, fit: "supported", paramBillions, warning: null };
  }

  if (paramBillions === null) {
    return {
      cloudRejected: false,
      fit: "unpinned",
      paramBillions,
      warning: `"${name}" has no pinned size tag. "latest"-style tags are not reproducible — pin a size such as ${RECOMMENDED_MODEL}.`,
    };
  }

  if (paramBillions >= LARGE_PARAM_THRESHOLD_B) {
    return {
      cloudRejected: false,
      fit: "large",
      paramBillions,
      warning: `"${name}" (~${paramBillions}B params) is large and may be partially CPU-offloaded (slow) unless your GPU has enough VRAM. Load it to measure the GPU/CPU split.`,
    };
  }

  return { cloudRejected: false, fit: "supported", paramBillions, warning: null };
}
