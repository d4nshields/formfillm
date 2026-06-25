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
  TestOllama: "formfillm/test_ollama",
  ApplyFill: "formfillm/apply_fill",
  HighlightField: "formfillm/highlight_field",
  RemoveOverlay: "formfillm/remove_overlay",
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
export interface TestOllamaRequest {
  type: typeof MSG.TestOllama;
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
export interface PingRequest {
  type: typeof MSG.Ping;
}

export type Message =
  | ScanPageRequest
  | ClassifyRequest
  | TestOllamaRequest
  | ApplyFillRequest
  | HighlightFieldRequest
  | RemoveOverlayRequest
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
export interface TestOllamaResponse {
  ok: boolean;
  reachable: boolean;
  models?: string[];
  current?: string;
  error?: string;
}
export interface ApplyFillResponse {
  ok: boolean;
  results?: FillResult[];
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
    case MSG.TestOllama:
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
          fills.push({ fieldId: f.fieldId, value: f.value });
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
  }
}
