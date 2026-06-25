/*
 * formfillm — in-page overlay (content script)
 *
 * A small, non-intrusive floating widget that shows formfillm is active and
 * the current scan status. Rendered inside a shadow DOM so the host page's CSS
 * cannot affect it and it cannot affect the page. The MVP keeps this minimal —
 * the real review/consent experience lives in the side panel.
 */

const HOST_ID = "formfillm-overlay-host";

let statusEl: HTMLElement | null = null;

function buildStyle(): string {
  return `
    :host { all: initial; }
    .ff-card {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0d6e71;
      color: #e0f2f1;
      border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.3);
      padding: 10px 12px;
      max-width: 260px;
      font-size: 13px;
      line-height: 1.35;
    }
    .ff-row { display: flex; align-items: center; gap: 8px; }
    .ff-title { font-weight: 700; flex: 1; }
    .ff-dot { width: 8px; height: 8px; border-radius: 50%; background: #7de2d1; }
    .ff-status { margin-top: 6px; color: #b2dfdb; }
    .ff-close {
      all: unset;
      cursor: pointer;
      color: #b2dfdb;
      font-size: 16px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 4px;
    }
    .ff-close:hover, .ff-close:focus-visible { background: rgba(255,255,255,0.15); color: #fff; outline: none; }
  `;
}

export function mountOverlay(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = buildStyle();

  const card = document.createElement("div");
  card.className = "ff-card";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  card.setAttribute("aria-label", "formfillm status");

  const row = document.createElement("div");
  row.className = "ff-row";

  const dot = document.createElement("span");
  dot.className = "ff-dot";

  const title = document.createElement("span");
  title.className = "ff-title";
  title.textContent = "formfillm active";

  const close = document.createElement("button");
  close.className = "ff-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close formfillm overlay");
  close.addEventListener("click", () => removeOverlay());

  row.append(dot, title, close);

  statusEl = document.createElement("div");
  statusEl.className = "ff-status";
  statusEl.textContent = "Ready.";

  card.append(row, statusEl);
  shadow.append(style, card);
  document.documentElement.appendChild(host);
}

export function setOverlayStatus(text: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
}

export function removeOverlay(): void {
  const host = document.getElementById(HOST_ID);
  if (host) host.remove();
  statusEl = null;
}
