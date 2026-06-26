# formfillm

**Privacy-first local LLM form filling with informed consent.**

formfillm is a Manifest V3 Chrome extension that helps you fill web forms — but it is **not** a one-click autofill tool. It is a *local disclosure assistant*. It scans a form only when you ask, uses a **locally running [Ollama](https://ollama.com) model** to classify and explain what each field is asking for, and fills **only the fields you explicitly approve**. Your personal data never leaves your machine, and is never sent to the model.

- 🔒 **Local only.** No cloud LLMs, no hosted APIs, no telemetry, no analytics, no remote logging, no CDN scripts, no external fonts.
- 🧠 **Metadata-only classification.** The model sees form field *labels and structure*, never your stored profile values.
- ✅ **Consent per field.** Approve, edit, skip, or mark-wrong each field. Secrets (passwords, SIN/SSN, 2FA, banking) are never filled.
- 📒 **Disclosure ledger.** Records *categories and decisions* — never actual values.
- 🔑 **Local password generation.** For sign-up forms it can generate a strong password (Web Crypto CSPRNG) that meets the site's stated rules, fill it, and hand off to your password manager — the password is shown, copyable, and **never stored** by formfillm.
- 🚫 **Never submits.** formfillm fills fields and highlights them; you review and submit yourself.

> ⚠️ **MVP status.** Profile data is stored unencrypted in `chrome.storage.local`. Do not store secrets in your profile. See [SECURITY.md](./SECURITY.md).

---

## Quick start

### 1. Install and run Ollama (local)

Install Ollama from <https://ollama.com>, then pull the recommended model.

The recommended model is pinned for reproducibility and chosen to **fully fit an NVIDIA RTX 4060 (8 GB VRAM)** development machine:

```bash
ollama pull qwen3.5:4b
```

Optional alternatives:

```bash
ollama pull qwen3.5:2b      # smaller / fastest, low-end fallback
ollama pull qwen2.5:7b      # legacy fallback
ollama pull qwen3.5:9b      # higher quality, but ~8.8 GB — partially CPU-offloaded
                            # on an 8 GB GPU (slower); prefer a card with more VRAM
```

Confirm your local models and API:

```bash
ollama list
curl http://127.0.0.1:11434/api/tags
```

**If the extension gets a `403` from Ollama**, allow the extension origin to call it and restart Ollama:

```bash
# macOS/Linux (current shell)
export OLLAMA_ORIGINS='chrome-extension://*'
# Windows (PowerShell, persistent)
setx OLLAMA_ORIGINS "chrome-extension://*"
```

formfillm only ever talks to `http://127.0.0.1:11434`, `http://localhost:11434`, or `http://[::1]:11434`. Remote Ollama hosts are rejected.

### 2. Build the extension

```bash
npm install
npm run build      # outputs dist/
```

### 3. Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin **formfillm** to the toolbar.

### 4. Use it

1. Open a form page — e.g. `dev/sample-form.html` (open it as a local file in Chrome).
2. Click the **formfillm** toolbar icon to open the side panel (this grants `activeTab` access to that page).
3. Click **Scan this page**.
4. formfillm walks you through the form **one field at a time** ("Field 2 of 6"). For each field it shows a plain-language explanation, the sensitivity, and — when you have a matching saved value — exactly what it would fill.
5. For each field choose: **Yes, fill it** (fills that field immediately and moves on), **Edit** / **Type it in** (enter or override the value, then fill), **Skip**, or **This looks wrong**. Secret fields (SIN/SSN, etc.) are shown but never filled. **New-password fields** offer **Generate strong password** — formfillm reads the site's rules, generates a compliant password locally, fills it (and any confirm field), and shows it with a **Copy** button so you can save it in your password manager. Make sure your manager saves it on submit; formfillm never stores it.
6. Use **Back / Next** to move around; at the end you get a **summary** of what was filled, skipped, and flagged.
7. Review the filled values on the page and submit the form yourself — formfillm never submits.

Open **Review profile** first to enter your data (or **Create demo profile** for fake values to test with). A value-free record of your decisions is kept in **Disclosure ledger**.

---

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Rebuilds `dist/` on change (esbuild watch). |
| `npm run build` | Production build to `dist/`. |
| `npm run typecheck` | `tsc --noEmit` strict type check. |
| `npm run lint` | ESLint over `src/`, `scripts/`, `tests/`. |
| `npm run test` | Vitest unit + jsdom tests. |

To regenerate the icons: `node scripts/make-icons.mjs`.

**Debugging:** console logging is off by default and gated per channel in
`src/shared/debug-consts.ts`. Flip an individual flag to `true` and rebuild to
enable just that category — e.g. `ollamaNetwork` (Ollama requests/responses/
timing in the service worker console), `messaging` (gesture/injection/routing),
`fill` (page console), or `panel` (side panel console). These flags control
logging only; none changes behavior or enables any network access.

---

## How it works (privacy flow)

```
side panel ──scan──▶ background ──executeScript──▶ content script
                                                       │ scan DOM (metadata only)
content script ──field metadata──▶ background ──prompt (NO profile)──▶ local Ollama
local Ollama ──classification──▶ background ──validate + reconcile──▶ side panel
                                                       │ user approves fields
side panel ──approved {fieldId, value}──▶ background ──▶ content script ──▶ fills fields
                                                       │ writes value-free ledger entry
```

Two data streams are deliberately kept separate:

- **Metadata stream** (field labels/types/options) → goes to the model.
- **Value stream** (your profile data) → read locally in the side panel, sent only to the page to fill approved fields. **It never reaches the model.**

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full design and [SECURITY.md](./SECURITY.md) for the privacy model and threat notes.

---

## Settings

Open **Settings** in the side panel:

- **Ollama base URL** — default `http://127.0.0.1:11434`. Only localhost addresses on port 11434 are accepted.
- **Model** — default `qwen3.5:4b` (fits an 8 GB GPU). The UI warns when a model is likely too large for an 8 GB GPU (e.g. `qwen3.5:27b`, `qwen3.5:35b`, `qwen3.5:122b`) and **rejects** cloud model names (e.g. `qwen3.5:cloud`).
- **Temperature** — default `0` for consistent classification.
- **Local-only enforcement** — locked on for this MVP.
- **JSON-schema output** — on by default; falls back to robust JSON extraction + retry if the model doesn't honor it.
- **Test Ollama connection** — lists locally installed models; click a model to select it.

---

## Limitations (MVP)

- Profile data is **not encrypted at rest** (code is structured so encryption can be added later).
- Custom ARIA dropdown filling is best-effort and may not work on every site.
- Scanning requires you to open the side panel via the toolbar icon on the target page (`activeTab`).
- One local Ollama endpoint; no remote hosts by design.

See [SECURITY.md](./SECURITY.md) for the full list and planned future work.

---

## Reference / attribution

The DOM-scanning, label-resolution, event-dispatch, and ARIA-listbox techniques were **studied** from the open-source [SmartFill AI](https://github.com/) project (MIT, © Phạm Văn Huynh). formfillm is a clean, independent TypeScript implementation with a different architecture, privacy model, naming, UI, and prompts — **no source code was copied**. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#reference-use) for details.

## License

MIT — see [LICENSE](./LICENSE).
