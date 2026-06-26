# Contributing to formfillm

Thanks for your interest in formfillm. It is a privacy-first, **local-only**
form-filling assistant, and that posture is the whole point — please read the
[non-negotiable invariants](#privacy-invariants-do-not-regress) before opening a
pull request.

## Development setup

Requires **Node.js ≥ 18**.

```bash
npm install
npm run build      # outputs the unpacked extension to dist/
```

Load `dist/` via `chrome://extensions` → **Developer mode** → **Load unpacked**.
See the [README](./README.md) for first-run details (Ollama setup, the
`activeTab` grant, the `403`/`OLLAMA_ORIGINS` fix).

### Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Rebuild `dist/` on change (esbuild watch). |
| `npm run build` | Production build to `dist/`. |
| `npm run typecheck` | `tsc --noEmit` (strict). |
| `npm run lint` | ESLint over `src/`, `scripts/`, `tests/`. |
| `npm run test` | Vitest unit + jsdom tests. |

## The green gate

Every change must pass all four before it is merged — CI runs exactly these:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

TypeScript is strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
`noUnusedLocals`). Prefer fixing the cause over disabling a rule.

## Privacy invariants (do not regress)

These are the reason formfillm exists. A PR that weakens any of them will not be
accepted. The privacy-critical logic lives in the dependency-free `src/shared/`
core specifically so it can be unit-tested without Chrome APIs — add or update
tests when you touch it.

1. **Local only.** The only network destination is a local Ollama at
   `127.0.0.1`/`localhost`/`[::1]` on port `11434`. No cloud LLMs, hosted APIs,
   telemetry, analytics, remote logging, CDN scripts, or remote fonts. Remote
   URLs and cloud-style model names are rejected (`src/shared/ollama-policy.ts`),
   and the manifest CSP `connect-src` pins egress as defense in depth.
2. **Metadata-only classification.** The model sees field labels/structure
   only — **never** the user's stored profile values. The metadata and value
   streams are kept separate by design (see `docs/ARCHITECTURE.md`).
3. **Never store secrets.** Passwords, SIN/SSN, 2FA, and banking details are
   never written to the profile or ledger, and secret fields are never filled.
   Generated passwords live in memory only and are never persisted.
4. **Value-free ledger.** Disclosure-ledger entries record categories and
   decisions only; `valueStored` is always `false`.
5. **Fail closed.** When classification is uncertain or parsing fails, default
   to manual review / never-fill — never to "fill anyway".
6. **No submitting.** formfillm fills and highlights fields; the user reviews
   and submits.

If you are unsure whether a change touches one of these, assume it does and call
it out explicitly in the PR description. See [SECURITY.md](./SECURITY.md) for the
threat model.

## Style & scope

- Match the surrounding code: small, focused modules; plain DOM in the side
  panel (no UI framework); clear names over cleverness.
- Keep PRs surgical — don't refactor adjacent code or add unrequested features.
- Accessibility matters: keyboard navigation and ARIA for any UI you add.

## Commits & PRs

- Write clear, imperative commit messages explaining the *why*.
- Ensure the green gate passes locally before pushing.
- Describe user-facing behavior changes and any privacy-relevant considerations.
