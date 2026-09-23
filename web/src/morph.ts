// In-place DOM patching for the regions that must outlive a rerender: the
// sidebar, and any overlay marked `data-overlay` (the connection modal). rerender() swaps the rest of the app wholesale, which is fine for a
// screen but fatal for a transition — a width, a rotated chevron or an opening
// sub-page list can only animate on an element that SURVIVES the state change.
// So the <aside> is patched, never replaced.
//
// Deliberately small: nodes pair by index (the sidebar renders a STABLE
// structure — everything is always present and hidden with CSS, never
// conditionally emitted), same-name nodes are patched, anything else is replaced.

/** Make `live`'s attributes equal `next`'s. */
export function syncAttrs(live: Element, next: Element): void {
  for (const a of Array.from(live.attributes)) if (!next.hasAttribute(a.name)) live.removeAttribute(a.name);
  for (const a of Array.from(next.attributes)) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
}

/** Patch `live` (and its subtree) to match `next`. Both must be the same element type.
 *  A `data-keep` element is owned by script (the collapsed-rail tooltip) and left alone. */
export function morph(live: Element, next: Element): void {
  if (live.hasAttribute("data-keep")) return;
  syncAttrs(live, next);
  const a = Array.from(live.childNodes);
  const b = Array.from(next.childNodes);
  for (let i = 0; i < b.length; i++) {
    const from = a[i];
    const to = b[i];
    if (!from) { live.appendChild(to); continue; }
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { live.replaceChild(to, from); continue; }
    if (from instanceof Element) morph(from, to as Element);
    else if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
  }
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

/**
 * Paint `html` (a full render() string) into `mount`. When both the live DOM and
 * the new markup are the app shell, the <aside> is morphed and everything else
 * is swapped; otherwise (auth, landing, first paint) it is a plain innerHTML.
 */
export function paint(mount: HTMLElement, html: string): void {
  const liveRoot = mount.firstElementChild;
  const liveShell = liveRoot?.querySelector(":scope > .cnpy-shell");
  if (liveRoot && liveShell) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const nextRoot = tpl.content.firstElementChild;
    const nextShell = nextRoot?.querySelector(":scope > .cnpy-shell");
    const liveAside = liveShell.querySelector(":scope > .cnpy-aside");
    const nextAside = nextShell?.querySelector(":scope > .cnpy-aside");
    const liveMain = liveShell.querySelector(":scope > main");
    const nextMain = nextShell?.querySelector(":scope > main");
    if (nextRoot && nextShell && liveAside && nextAside && liveMain && nextMain) {
      syncAttrs(liveRoot, nextRoot);
      morph(liveAside, nextAside);
      liveMain.replaceWith(nextMain);
      // Overlays (toast, sync modal) sit beside the shell and are swapped — EXCEPT a
      // `data-overlay` one present on both sides, which is morphed in place like the
      // aside, so an open dialog does not replay its entrance on every state change.
      const keyOf = (n: Node): string | null => (n instanceof Element ? n.getAttribute("data-overlay") : null);
      const nextKeys = new Set(Array.from(nextRoot.childNodes).map(keyOf).filter((k): k is string => k !== null));
      const kept = new Map<string, Element>();
      for (const n of Array.from(liveRoot.childNodes)) {
        if (n === liveShell) continue;
        const k = keyOf(n);
        if (k !== null && nextKeys.has(k) && !kept.has(k)) kept.set(k, n as Element);
        else n.remove();
      }
      for (const n of Array.from(nextRoot.childNodes)) {
        if (n === nextShell) continue;
        const k = keyOf(n);
        const live = k !== null ? kept.get(k) : undefined;
        if (live) morph(live, n as Element);
        else liveRoot.appendChild(n);
      }
      return;
    }
  }
  mount.innerHTML = html;
}
