/*
 * formfillm — message contracts
 *
 * Discriminated unions for every message that crosses an extension boundary
 * (side panel <-> background <-> content). Each boundary validates incoming
 * messages with `parseMessage` before acting; unrecognized shapes are ignored.
 */

import type { FieldClassification, FieldMetadata } from "./types.js";

export const MSG = {
  ScanPage: "formfillm/scan_page",
  Classify: "formfillm/classify",
  TestBackend: "formfillm/test_backend",
  ApplyFill: "formfillm/apply_fill",
  HighlightField: "formfillm/highlight_field",
  RemoveOverlay: "formfillm/remove_overlay",
  PasswordContext: "formfillm/password_context",
  ParsePasswordPolicy: "formfillm/parse_password_policy",
  FieldFocused: "formfillm/field_focused",
  Ping: "formfillm/ping",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface PageContext {
  origin: string;
  title: string | null;
}

export interface FillInstruction {
  fieldId: string;
  value: string;
  /**
   * Permits filling a password field. ONLY set for freshly generated
   * passwords; the content script refuses password fills without it. Stored
   * profile secrets are never filled (and never stored in the first place).
   */
  allowSecret?: boolean;
}

/** Live password-field context gathered on demand from the page. */
export interface PasswordContext {
  fieldId: string;
  minLength: number | null;
  maxLength: number | null;
  pattern: string | null;
  /** Visible/aria policy text near the field (e.g. "8 to 50 characters…"). */
  policyText: string | null;
  /** A matching confirm-password field on the page, if detected. */
  confirmFieldId: string | null;
}

export interface FillResult {
  fieldId: string;
  filled: boolean;
  reason?: string;
}

// --- Requests ---------------------------------------------------------------

export interface ScanPageRequest {
  type: typeof MSG.ScanPage;
  /** Tab to scan; required when sent from the side panel to the background. */
  tabId?: number;
}
export interface ClassifyRequest {
  type: typeof MSG.Classify;
  fields: FieldMetadata[];
  page: PageContext;
}
export interface TestBackendRequest {
  type: typeof MSG.TestBackend;
}
export interface ApplyFillRequest {
  type: typeof MSG.ApplyFill;
  tabId?: number;
  fills: FillInstruction[];
}
export interface HighlightFieldRequest {
  type: typeof MSG.HighlightField;
  tabId?: number;
  fieldId: string | null;
}
export interface RemoveOverlayRequest {
  type: typeof MSG.RemoveOverlay;
  tabId?: number;
}
export interface PasswordContextRequest {
  type: typeof MSG.PasswordContext;
  tabId?: number;
  fieldId: string;
}
export interface ParsePasswordPolicyRequest {
  type: typeof MSG.ParsePasswordPolicy;
  context: PasswordContext;
}
/**
 * Broadcast by the content script when the user focuses or clicks a previously
 * scanned field on the page. The side panel uses it to jump the guided wizard
 * to the matching step. Carries only the opaque scan-time field id — no value.
 */
export interface FieldFocusedRequest {
  type: typeof MSG.FieldFocused;
  fieldId: string;
}
export interface PingRequest {
  type: typeof MSG.Ping;
}

export type Message =
  | ScanPageRequest
  | ClassifyRequest
  | TestBackendRequest
  | ApplyFillRequest
  | HighlightFieldRequest
  | RemoveOverlayRequest
  | PasswordContextRequest
  | ParsePasswordPolicyRequest
  | FieldFocusedRequest
  | PingRequest;

// --- Responses --------------------------------------------------------------

export interface ScanPageResponse {
  ok: boolean;
  fields?: FieldMetadata[];
  page?: PageContext;
  error?: string;
}
export interface ClassifyResponse {
  ok: boolean;
  classifications?: FieldClassification[];
  errors?: string[];
  error?: string;
}
export interface TestBackendResponse {
  ok: boolean;
  reachable: boolean;
  /** Installed model ids from the OpenAI-compatible GET /v1/models. */
  models?: string[];
  current?: string;
  error?: string;
}
export interface ApplyFillResponse {
  ok: boolean;
  results?: FillResult[];
  error?: string;
}
export interface PasswordContextResponse {
  ok: boolean;
  context?: PasswordContext;
  error?: string;
}
export interface ParsePasswordPolicyResponse {
  ok: boolean;
  /** Structured PasswordPolicy (see shared/password.ts), or undefined on error. */
  policy?: unknown;
  error?: string;
}
export interface PingResponse {
  ok: true;
}

// --- Validation -------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const TYPES: ReadonlySet<string> = new Set(Object.values(MSG));

/** Validate and narrow an incoming message; returns null if unrecognized. */
export function parseMessage(raw: unknown): Message | null {
  if (!isObj(raw) || typeof raw.type !== "string" || !TYPES.has(raw.type)) return null;
  const type = raw.type as MessageType;

  switch (type) {
    case MSG.ScanPage:
      return { type, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) };
    case MSG.TestBackend:
      return { type };
    case MSG.Ping:
      return { type };
    case MSG.RemoveOverlay:
      return { type, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) };
    case MSG.Classify: {
      if (!Array.isArray(raw.fields) || !isObj(raw.page)) return null;
      const page = raw.page as Record<string, unknown>;
      if (typeof page.origin !== "string") return null;
      return {
        type,
        fields: raw.fields as FieldMetadata[],
        page: { origin: page.origin, title: typeof page.title === "string" ? page.title : null },
      };
    }
    case MSG.ApplyFill: {
      if (!Array.isArray(raw.fills)) return null;
      const fills: FillInstruction[] = [];
      for (const f of raw.fills) {
        if (isObj(f) && typeof f.fieldId === "string" && typeof f.value === "string") {
          fills.push({
            fieldId: f.fieldId,
            value: f.value,
            ...(f.allowSecret === true ? { allowSecret: true } : {}),
          });
        } else {
          return null; // reject the whole batch if any instruction is malformed
        }
      }
      return { type, fills, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) };
    }
    case MSG.HighlightField: {
      const fieldId = typeof raw.fieldId === "string" ? raw.fieldId : raw.fieldId === null ? null : undefined;
      if (fieldId === undefined) return null;
      return { type, fieldId, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) };
    }
    case MSG.PasswordContext: {
      if (typeof raw.fieldId !== "string") return null;
      return { type, fieldId: raw.fieldId, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) };
    }
    case MSG.ParsePasswordPolicy: {
      if (!isObj(raw.context) || typeof (raw.context as Record<string, unknown>).fieldId !== "string") {
        return null;
      }
      return { type, context: raw.context as unknown as PasswordContext };
    }
    case MSG.FieldFocused: {
      if (typeof raw.fieldId !== "string") return null;
      return { type, fieldId: raw.fieldId };
    }
  }
}
