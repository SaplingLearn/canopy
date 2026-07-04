// Shared presentational atoms for the componentized surfaces (Review /
// Maintenance) and the render layer. Pure functions over props — no data,
// no fetching, no state. Markup follows the app's template-string idiom:
// inline styles over the canopy.css custom properties, interactions via
// data-act / data-arg dispatched in main.ts.

/** Escape text content for safe insertion into innerHTML. */
export function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escape a value for use inside an HTML attribute (delegates to esc for full safety). */
export function attr(v: string): string {
  return esc(v);
}

/** The mono uppercase eyebrow/label style used across both surfaces. */
export const MONO_LABEL =
  "font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";

/** Bordered tinted status chip (STAGED / DRAFT / …); colorVar is a CSS var expression. */
export function statusBadge(text: string, colorVar: string): string {
  return `<span style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;color:${colorVar};border:1px solid color-mix(in srgb,${colorVar} 45%,transparent);background:color-mix(in srgb,${colorVar} 12%,transparent);border-radius:5px;padding:2px 6px;flex:none;white-space:nowrap">${esc(text)}</span>`;
}

/** Small circular initials avatar. */
export function avatarCircle(initials: string, size = 20): string {
  const font = size <= 20 ? 8.5 : 9.5;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:var(--hover);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:${font}px;font-weight:600;flex:none">${esc(initials)}</div>`;
}

/** Selectable filter/view chip. `small` is the compact variant (diff view toggle). */
export function selectChip(label: string, active: boolean, act: string, arg: string, small = false): string {
  const pad = small ? "4px 10px" : "5px 11px";
  const size = small ? "12px" : "12.5px";
  const style = `padding:${pad};border-radius:7px;font-size:${size};font-weight:500;transition:all .12s ease;border:1px solid ${active ? "var(--accent)" : "var(--border)"};color:${active ? "var(--accent)" : "var(--fg-55)"};background:${active ? "var(--accent-soft)" : "transparent"}`;
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="${style}">${esc(label)}</button>`;
}

/** Selectable list row (assign kinds, assign targets, person picker). */
export function pickRow(inner: string, active: boolean, act: string, arg: string, extraStyle = ""): string {
  const style = `display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:7px;font-size:13px;font-weight:500;text-align:left;width:100%;transition:all .12s ease;border:1px solid ${active ? "var(--accent)" : "var(--border)"};color:${active ? "var(--accent)" : "var(--fg-70)"};background:${active ? "var(--accent-soft)" : "transparent"};${extraStyle}`;
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="${style}">${inner}</button>`;
}

/** Accent primary button that renders inert (muted outline) until `enabled`. */
export function primaryBtn(label: string, enabled: boolean, act: string, arg: string, extraStyle = ""): string {
  const style = enabled
    ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent;cursor:pointer"
    : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default";
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" class="${enabled ? "cnpy-accentbtn" : ""}" style="${style};border-radius:8px;padding:7px 15px;font-size:12.5px;font-weight:600;transition:all .12s ease;${extraStyle}">${esc(label)}</button>`;
}

/** Dashed-border empty-state card (Review list + detail). */
export function dashedCard(title: string, sub: string, wide = false): string {
  const pad = wide ? "36px 44px" : "28px 20px";
  return `<div style="border:1px dashed var(--border-strong);border-radius:${wide ? "13px" : "11px"};padding:${pad};text-align:center;${wide ? "max-width:380px;" : "margin-top:4px;"}">
    <div style="font-size:${wide ? "15px" : "13.5px"};font-weight:${wide ? "600" : "500"};color:var(--fg-70)">${esc(title)}</div>
    <div style="font-size:12.5px;color:var(--fg-40);margin-top:${wide ? "6px" : "4px"}">${esc(sub)}</div>
  </div>`;
}
