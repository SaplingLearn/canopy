// Scroll preservation across the full-tree rerender. `rerender()` replaces the
// whole app with `mount.innerHTML = render(state)`, which discards the main
// scroll pane and creates a new one at scrollTop 0 — every button low on a long
// screen jumped the pane to the top. Capture before the swap, restore after,
// and only when the screen is unchanged (a screen change starts at the top).
// Duck-typed so it is unit-testable without a DOM.

export const MAIN_PANE = "#cnpy-main";

export interface ScrollSnapshot { key: string; top: number }
interface Pane { scrollTop: number }
interface PaneRoot { querySelector(selector: string): Pane | null }

export function captureScroll(root: PaneRoot, key: string): ScrollSnapshot | null {
  const pane = root.querySelector(MAIN_PANE);
  return pane ? { key, top: pane.scrollTop } : null;
}

export function restoreScroll(root: PaneRoot, snap: ScrollSnapshot | null, key: string): boolean {
  if (!snap || snap.key !== key) return false;
  const pane = root.querySelector(MAIN_PANE);
  if (!pane) return false;
  pane.scrollTop = snap.top;
  return true;
}
