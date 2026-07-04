# Security & Privacy — formfillm

formfillm's purpose is **personal information protection through local-only, consent-driven form filling.** This document describes the design, what data moves where, and the known limits of the MVP.

## Design principles

1. **Local only.** The only network destination is a local Ollama instance (`127.0.0.1`, `localhost`, or `[::1]` on port `11434`). There are no cloud LLMs, hosted APIs, analytics, telemetry, remote logging, CDN scripts, or external fonts.
2. **Metadata-only classification.** The model is given form field *metadata* (labels, types, options, nearby text). It is **never** given your stored profile values.
3. **Consent before disclosure.** Nothing is filled until you approve it, field by field. Low-sensitivity fields can be batch-approved only after the exact values are shown.
4. **Fail closed.** If classification fails or is malformed, fields default to `unknown` / `manual_review`. Secrets are never fillable.
5. **No value persistence.** The disclosure ledger stores categories and decisions, never values.

## What data is scanned

When you click **Scan this page**, the content script extracts, per field:

- Structural metadata: tag, input type, `name`, `id`, `autocomplete`, `placeholder`.
- Label text: associated `<label>`, `aria-label`, `aria-labelledby`, nearby visible text, section heading.
- State: required, disabled, readonly, **whether** the field has a value (a boolean — never the value), options for selects/radios.
- Geometry: bounding rectangle and visibility.

It does **not** extract hidden field values, current field values, or unrelated page text. All extracted text is sanitized (control characters stripped, lengths capped) before any use.

## What data is stored

Stored in `chrome.storage.local` only (this browser, this machine):

| Data | Contents | Notes |
|------|----------|-------|
| Settings | Ollama URL, model, temperature, toggles | Local-only enforcement is locked on. |
| Profile | Your key/value data | **Not encrypted at rest (MVP).** Do not store secrets here. |
| Ledger | Per-disclosure: timestamp, origin, page title, field label, category, sensitivity, decision, `filled`, `valueStored:false` | **Never contains values.** A redaction pass strips any stray keys before writing. |

## What data is sent to Ollama

Only **field metadata** and non-personal page context (origin, title), wrapped in the classifier prompt. The classifier system prompt explicitly forbids requesting or using personal data. Your profile values are **never** included in any prompt.

Fill values (your profile data) are read locally in the side panel after you approve a field and are sent **only to the page's content script** to fill the field. They pass through the background worker purely in transit and are never stored or logged there.

## Why the full profile is not sent to the classifier

Sending an entire personal profile to any model — even a local one — needlessly broadens the data's exposure surface (model context, logs, swap, future features). formfillm classifies using metadata alone, then maps an approved category to a single local value at fill time. This keeps the principle of least disclosure intact even within the local boundary.

## Defense in depth

- **Manifest CSP** scopes `connect-src` to the loopback hosts (`http://127.0.0.1:*`, `http://localhost:*`) plus `'self'`, and disallows remote scripts (`script-src 'self'`), objects, and remote styles/fonts. Any port is allowed so advanced users can run SGLang/vLLM/llama-server locally, but the host is **loopback only** — even a logic bug cannot reach the network or a cloud endpoint.
- **URL validation** rejects any non-local host and any non-`http` transport (any local port is accepted; default `11434`).
- **Model validation** rejects names containing `:cloud`, ending in `-cloud`, a standalone `cloud` token, URLs, or known hosted-provider tokens.
- **Sensitivity floor** raises (never lowers) the model's sensitivity per category and forces secrets to `never_fill`.
- **Password guard** in the content script refuses to fill `<input type="password">` regardless of instruction.
- **Message validation** on every extension boundary; malformed messages are ignored.
- **LLM output validation** with fail-closed defaults and JSON-extraction + retry.

## Permission choices

- `activeTab` + `chrome.scripting.executeScript` — the content script is injected **only** on the tab you invoked formfillm on, only after you click the toolbar icon / scan. No static `content_scripts`, no `<all_urls>`.
- `storage` — local profile, settings, ledger.
- `sidePanel` — the main UI.
- `host_permissions` — limited to the three **local** Ollama origins (`http://127.0.0.1:11434/*`, `http://localhost:11434/*`, `http://[::1]:11434/*`). This is the one documented technical necessity: it lets the worker call your local model. It grants no access to any website.

## Password generation (new-password fields)

formfillm never fills a *stored* secret and never stores one. For **new-password**
(registration) fields it offers a distinct, opt-in flow:

- On your explicit click, it reads the field's own constraints (`minlength`/
  `maxlength`/`pattern`) and the visible policy text, and the **local** model
  structures that into rules (failing closed to the input's constraints).
- It generates a compliant password using the Web Crypto CSPRNG
  (`crypto.getRandomValues`, unbiased selection — never `Math.random`),
  guaranteeing required character classes and avoiding your name/email.
- It fills the password (and a detected confirm field) — this is the **only**
  case where a password field is filled, gated by an explicit `allowSecret`
  flag on the fill instruction; the content script refuses password fills
  without it.
- The generated password is held in memory only, shown to you with a **Copy**
  button, and **never stored** by formfillm (not in the profile, not in the
  ledger). You save it via your password manager's save-on-submit, or by
  copying it. The ledger records the decision as `generated` with no value.

Login (`current-password`) fields are not generated for and are never filled.

## Known MVP limitations

- Profile data is **not encrypted at rest**. (The storage layer is isolated so encryption can be added without touching the UI or classifier.)
- Custom/ARIA dropdown filling is best-effort.
- No import/export, no per-site rules, no multiple profiles yet.
- Classification quality depends on the local model.

## Future work

- Encryption at rest for the profile vault (passphrase-derived key).
- Profile import/export (encrypted).
- Profile separation / multiple personas.
- Per-site rules and remembered decisions.
- A stronger, documented threat model and extension-store hardening review.
