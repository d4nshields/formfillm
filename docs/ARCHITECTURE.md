# Architecture — formfillm

formfillm is a Manifest V3 Chrome extension split into three runtime contexts plus a dependency-free shared core. The shared core holds all privacy-critical logic so it can be unit-tested without Chrome APIs.

## Component diagram (text)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Chrome extension                                                      │
│                                                                        │
│  ┌────────────────────┐        ┌──────────────────────────┐           │
│  │  Side panel        │  msgs  │  Background service worker │          │
│  │  (sidepanel.*)     │◀──────▶│  (service-worker.ts)       │          │
│  │  - consent UI      │        │  - side panel wiring       │          │
│  │  - profile vault   │        │  - message router          │          │
│  │  - ledger view     │        │  - Ollama client (local)   │──┐       │
│  │  - settings        │        │  - URL/model policy        │  │       │
│  └─────────┬──────────┘        └─────────────┬─────────────┘  │       │
│            │ reads profile (local)           │ executeScript    │      │
│            │ builds approved fills           │ + tabs.sendMessage│     │
│            ▼                                  ▼                  │      │
│  ┌───────────────────┐         ┌────────────────────────────┐  │      │
│  │ chrome.storage     │        │  Content script (injected)  │  │      │
│  │ .local             │        │  (content-entry.ts)         │  │      │
│  │ - settings         │        │  - scanner.ts (metadata)    │  │      │
│  │ - profile (values) │        │  - filler.ts (approved only)│  │      │
│  │ - ledger (no vals) │        │  - overlay.ts (shadow DOM)  │  │      │
│  └───────────────────┘         └────────────────────────────┘  │      │
│                                                                  │      │
└──────────────────────────────────────────────────────────────┼──────┘
                                                                   │
                                                  ┌────────────────▼─────────────┐
                                                  │  Local Ollama                 │
                                                  │  http://127.0.0.1:11434       │
                                                  │  /api/chat, /api/tags         │
                                                  └───────────────────────────────┘
```

## Message flow

```
1. side panel  → background : ScanPage { tabId }
2. background  → content     : executeScript(content.js) then ScanPage
3. content     → scanner     : scanFields()  → FieldMetadata[] (+ in-page ref registry)
4. content     → background  : { fields, page }            (metadata only)
5. background  → side panel  : { fields, page }
6. side panel  → background  : Classify { fields, page }   (NO profile)
7. background  → Ollama       : /api/chat (system + metadata prompt)
8. Ollama      → background  : classifications (raw)
9. background  → (validate + reconcile + fail-closed) → side panel
10. user approves fields in the side panel
11. side panel reads matching profile values locally (resolveProfileKey + getProfileValue)
12. side panel → background : ApplyFill { tabId, fills:[{fieldId, value}] }
13. background → content     : ApplyFill (values in transit only)
14. content    → filler      : applyFills(refs, fills) → fires input/change, highlights
15. content    → background  → side panel : per-field FillResult[]
16. side panel writes value-free ledger entries (filled flag from real results)
```

**Never:** the form is submitted, validation is bypassed, secret fields are filled, or profile values reach the model.

## Privacy boundaries

| Boundary | Crosses it | Never crosses it |
|----------|-----------|------------------|
| Page → content script | DOM structure | (stays in page) |
| Content → background → model | Field **metadata** | Profile values, field values |
| Side panel → page (fill) | Approved values, in transit | (not stored/logged in background) |
| Anything → disk (storage) | Categories, decisions, settings, profile | Values in the ledger |
| Anything → network | Requests to local Ollama only | Any cloud/remote destination (also blocked by CSP) |

## Module map

### Shared core (`src/shared/`) — pure, testable, no Chrome APIs
- `types.ts` — categories, sensitivities, actions, field metadata, classification, profile, ledger, settings.
- `messages.ts` — discriminated-union message contracts + `parseMessage` boundary validator.
- `ollama-policy.ts` — `validateOllamaUrl`, `validateModelName` (cloud rejection), `assessModel` (8 GB-VRAM size guidance).
- `sensitivity.ts` — category→sensitivity floor, `reconcileClassification` (fail-closed, secrets → `never_fill`).
- `classification-schema.ts` — JSON schema for Ollama + `validateClassificationResponse` (one entry per field, fail-closed) + `extractJson`.
- `profile-keys.ts` — category → local profile key resolution (returns null for unsafe categories).
- `ledger.ts` — `buildLedgerEntry` (+ `redactLedgerEntry` defensive pass).
- `sanitize.ts` — field-metadata sanitization (caps, control-char stripping, fixed key set).
- `prompts.ts` — classifier system prompt + metadata-only user prompt builder.

### Background (`src/background/service-worker.ts`)
Side-panel wiring, message routing, local Ollama client (timeout, 403 guidance, schema-then-JSON retry), policy enforcement. Holds no profile data.

### Content (`src/content/`)
- `scanner.ts` — DOM → `FieldMetadata[]` + an in-page registry mapping `fieldId` → element refs (refs never leave the page).
- `filler.ts` — fills only approved fields, fires events, highlights, refuses password fields, never submits.
- `overlay.ts` — minimal shadow-DOM status widget.
- `content-entry.ts` — idempotent init + message listener.

### Side panel (`src/sidepanel/`)
- `sidepanel.ts` — controller and views (scan/consent, profile, ledger, settings).
- `storage.ts` — typed `chrome.storage.local` access; ledger writes pass through redaction.
- `ui.ts` — DOM helpers (no `innerHTML` with data; text via `textContent`).
- `sidepanel.html` / `sidepanel.css` — local assets only.

## Why activeTab + dynamic injection

The extension declares **no** static `content_scripts` and does **not** request `<all_urls>`. Instead it uses `activeTab` plus `chrome.scripting.executeScript`, so a scanner runs on a page **only** after the user opens formfillm on that page and clicks **Scan**. This minimizes the extension's reach: by default it can see and touch nothing. The only standing host permission is for the **local** Ollama origins — required so the background worker can reach your model, and granting no website access.

## Type contracts

All cross-context messages are discriminated unions keyed on `type` (`src/shared/messages.ts`) and validated by `parseMessage` at every boundary. The classifier's output is validated by `validateClassificationResponse`, which always returns exactly one classification per requested field id (validated where present, fail-closed `unknown`/`manual_review` where absent), then reconciled against the sensitivity floor.

## Build

`scripts/build.mjs` (esbuild) produces three bundles into `dist/`:
- `background.js` — ESM service worker.
- `content.js` — **IIFE** classic script (injected via `executeScript`).
- `sidepanel.js` — ESM, loaded by `sidepanel.html`.

Static files (`manifest.json`, `sidepanel.html`, `sidepanel.css`, `icons/`) are copied verbatim. No plugins, no remote fetches at build time — deliberately minimal and auditable.

## Reference use

The label-resolution strategy (label-for → closest label → aria-label → aria-labelledby → placeholder → nearby text), radio-group dedup by `name`, ARIA `radiogroup`/`listbox` handling, event dispatch (`input`/`change`/`blur`), and simulated pointer clicks for custom dropdowns were **studied** from the MIT-licensed [SmartFill AI](https://github.com/) project (© Phạm Văn Huynh). formfillm reimplements these ideas in strict TypeScript with a different architecture and an inverted privacy model:

| | SmartFill AI (reference) | formfillm |
|--|--------------------------|-----------|
| Profile → model | Full profile sent in the prompt | **Never** sent; metadata only |
| Injection | Static `content_scripts` on `<all_urls>` | `activeTab` + on-demand `executeScript` |
| Flow | One-click autofill | Per-field informed consent |
| Secrets | Filled like any field | Detected, flagged, **never filled** |
| Language | Plain JS | Strict TypeScript |
| Record | — | Value-free disclosure ledger |

**No source code was copied.** If any meaningful snippet were ever reused, the MIT notice would be preserved and the copied portion documented here.
