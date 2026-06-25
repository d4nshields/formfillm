/*
 * formfillm — tiny DOM helpers for the side panel
 *
 * Plain DOM construction only (no framework, no innerHTML with untrusted
 * data). Keeps the UI auditable: every node is created explicitly and text is
 * always set via textContent.
 */

type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  }
  if (props.on) {
    for (const [type, handler] of Object.entries(props.on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function button(
  label: string,
  onClick: () => void,
  opts: { class?: string; ariaLabel?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const b = el("button", {
    class: opts.class ?? "ff-btn",
    text: label,
    on: { click: () => onClick() },
  });
  b.type = "button";
  if (opts.ariaLabel) b.setAttribute("aria-label", opts.ariaLabel);
  if (opts.disabled) b.disabled = true;
  return b;
}
