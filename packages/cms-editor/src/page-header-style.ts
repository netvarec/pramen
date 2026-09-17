// How a deployment may dress the screen header — the declarative answer to #60.
//
// A host could already brand the CHROME (`brand`, `layout`) and add whole screens of its own
// (`panels`, `adminPage`). The one thing it could not touch was the header on the editor's
// OWN screens: the sticky cover panel with the h1 and the primary action. So a project that
// needed those headers to match the product the editor sits inside reached for the only hook
// left — a stylesheet selecting on the header's internal DOM:
//
//   div.sticky[class*="max-w-[1200px]"] > div.relative.isolate.overflow-hidden.rounded-panel
//     > div.relative.grid > :not(h1) { … }
//
// That is private structure, and the release that reworked the header would have voided it
// with no error anywhere. Worse, it cannot tell the screens apart or a container from a
// control, and both of those cost a real bug in the shipped version: an injected `content:
// "New"` turned Media's `+ Upload` into "New + Upload", and a rule meant for the panel landed
// on the button too — white on mint, 1.58:1.
//
// Neither is a mistake about CSS. They are what a structural hook makes unavoidable. So the
// seam here is TOKENS, in the shape `brand` and `layout` already have: the host supplies
// presentation, the editor keeps owning the text, the action and — this is the point of
// deriving rather than accepting — the CONTRAST. A host names ONE colour; the label colour on
// it and the hover shade are computed here, so the readable-text bug above is not reachable
// through this API at all.
//
// A LEAF module, free of React and of DOM-lib imports, like `brand.ts` and `chrome.ts`: it is
// resolved at module load before anything renders, and every part of it is a pure function a
// test can exercise with a plain object.

/** How the header panel is drawn. */
export type PageHeaderVariant = "cover" | "flat" | "bare";

/** Every value `variant` accepts — for the warning below, and so the docs stay in step. */
export const PAGE_HEADER_VARIANTS: readonly PageHeaderVariant[] = ["cover", "flat", "bare"];

/** What ships when nothing is configured: the generated Truchet cover every deployment
 * already has. */
export const DEFAULT_VARIANT: PageHeaderVariant = "cover";

/** What the host may set under `window.PRAMEN_CMS_EDITOR.pageHeader`. Every field is
 * `unknown` because this config is hand-edited and templated from env vars — the types are
 * what `resolvePageHeader` proves, not what it may assume. */
export interface PageHeaderConfig {
  /** `"cover"` (default) is the seeded artwork; `"flat"` keeps the panel without it;
   * `"bare"` drops the panel too, leaving the title and action on the page. */
  variant?: unknown;
  /** The colour the primary action wears, as a hex or `rgb()` literal. */
  accent?: unknown;
  /** The family for the `<h1>` — a CSS `font-family` list. */
  titleFont?: unknown;
}

/** A resolved header style: what `page-header.tsx` renders from. */
export interface PageHeaderStyle {
  variant: PageHeaderVariant;
  /** Custom properties to declare on the header's root element, re-pointing the podoba
   * tokens the primary action reads. Empty when no accent was configured. */
  vars: Record<string, string>;
  /** The `<h1>`'s family, or undefined for the design system's. */
  titleFont: string | undefined;
}

/** The unconfigured header — the shape every existing deployment already has. */
export const DEFAULT_PAGE_HEADER_STYLE: PageHeaderStyle = { variant: DEFAULT_VARIANT, vars: {}, titleFont: undefined };

// --- colour ------------------------------------------------------------------------------
//
// The editor parses the accent rather than passing it through, and that is the whole reason
// this API can promise a legible label. `var(--gs-admin-mint)` is therefore REFUSED, not
// honoured-and-hoped-about: an unresolvable value is one we cannot compute a foreground for,
// and shipping the accent with podoba's default `text-fg-inverted` on it is exactly the
// 1.58:1 the issue reported. A host that wants its own token here inlines the value; that is
// a one-line loss against a contrast bug nobody sees until a screenshot.

/** A colour in sRGB, 0-255 per channel. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_FN = /^rgba?\(([^)]*)\)$/i;

/** podoba's ink and its paper — the two candidates for a label on the accent. They are the
 * tokens the rest of the editor already sets type in, so a derived foreground still looks
 * like this design system rather than like a contrast calculator's output. */
export const ON_ACCENT_CANDIDATES: readonly string[] = ["#0d0d0d", "#ffffff"];

/** WCAG AA for the 13px text podoba's `Button` sets. Below this we still pick the better of
 * the two, and warn — the accent itself is the problem and only the host can change it. */
const AA_NORMAL = 4.5;

/**
 * Parse a CSS colour literal we can reason about: `#rgb`, `#rrggbb`, `rgb(r g b)`,
 * `rgb(r, g, b)`.
 *
 * A form carrying ALPHA (`#rgba`, `#rrggbbaa`, `rgba(…)` with a fourth value below 1) is
 * refused rather than flattened: contrast against a translucent fill depends on what is
 * behind it, and what is behind it here is a themed surface that changes. Full alpha is
 * accepted and dropped, since it changes nothing.
 *
 * Everything else — `var()`, `oklch()`, a named colour, a gradient — returns undefined and
 * the caller warns. Named colours are not special-cased on purpose: a 148-entry table to
 * accept `rebeccapurple` buys nothing a hex does not.
 */
export function parseColor(value: string): Rgb | undefined {
  const v = value.trim();
  if (HEX.test(v)) {
    const hex = v.slice(1);
    const short = hex.length <= 4;
    const part = (i: number): number => {
      const raw = short ? hex[i]! + hex[i]! : hex.slice(i * 2, i * 2 + 2);
      return Number.parseInt(raw, 16);
    };
    if ((short && hex.length === 4) || hex.length === 8) {
      if (part(3) !== 255) return undefined; // translucent — see above
    }
    return { r: part(0), g: part(1), b: part(2) };
  }
  const fn = RGB_FN.exec(v);
  if (!fn) return undefined;
  // `rgb(1 2 3 / 50%)`, `rgb(1,2,3)` and `rgb(1 2 3)` all split on the same two separators.
  const parts = fn[1]!.split(/[\s,/]+/).filter((p) => p !== "");
  if (parts.length === 4) {
    const alpha = parts[3]!.endsWith("%") ? Number.parseFloat(parts[3]!) / 100 : Number.parseFloat(parts[3]!);
    if (!(alpha >= 1)) return undefined;
  } else if (parts.length !== 3) return undefined;
  const channels = parts.slice(0, 3).map((p) => (p.endsWith("%") ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p)));
  if (channels.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return undefined;
  return { r: Math.round(channels[0]!), g: Math.round(channels[1]!), b: Math.round(channels[2]!) };
}

/** WCAG relative luminance. The gamma expansion is not optional decoration: on the raw
 * channel values a mid-mint and a mid-blue come out the same brightness, and the label goes
 * white on one of them. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Which of podoba's two inks reads on this accent. Ties go to the first candidate, which is
 * the ink — the same direction podoba's own light theme picks. */
export function onAccent(accent: Rgb): { color: string; ratio: number } {
  let best = { color: ON_ACCENT_CANDIDATES[0]!, ratio: 0 };
  for (const candidate of ON_ACCENT_CANDIDATES) {
    const ratio = contrastRatio(accent, parseColor(candidate)!);
    if (ratio > best.ratio) best = { color: candidate, ratio };
  }
  return best;
}

function hex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The hover shade for an accent.
 *
 * podoba's primary button hovers from `brand-primary` to `neutral-600` — a near-black
 * lightening to #333. The INTENT is "visibly shifted, same button", so an accent is shifted
 * the way that stays visible on it: a dark accent lightens, a light one darkens. A fixed
 * direction would take a mint button to a lighter mint nobody can see against the panel.
 *
 * The two amounts differ because perception does: the same mix reads as a bigger step going
 * down from a light colour than coming up from a dark one.
 */
export function hoverShade(accent: Rgb): string {
  const dark = relativeLuminance(accent) < 0.4;
  const mix = (channel: number, toward: number, amount: number): number => channel + (toward - channel) * amount;
  return hex({
    r: dark ? mix(accent.r, 255, 0.22) : mix(accent.r, 0, 0.14),
    g: dark ? mix(accent.g, 255, 0.22) : mix(accent.g, 0, 0.14),
    b: dark ? mix(accent.b, 255, 0.22) : mix(accent.b, 0, 0.14),
  });
}

/**
 * The custom properties one accent declares.
 *
 * TOKENS, not a class on the button. The accent has to reach whatever the host's screen puts
 * in that slot — today a podoba `Button`, tomorrow a second one beside it — and re-pointing
 * `--color-brand-primary` on the header's root is the only version of that which does not
 * require every future control in the header to remember a prop. The three names are podoba's
 * own, read by `bg-brand-primary text-fg-inverted hover:bg-neutral-600`; scoping them to the
 * header means nothing else in the app shifts.
 */
export function accentVars(accent: Rgb) {
  return {
    "--color-brand-primary": hex(accent),
    "--color-fg-inverted": onAccent(accent).color,
    "--color-neutral-600": hoverShade(accent),
  };
}

// --- resolution --------------------------------------------------------------------------

/** A config value as it should appear in a warning. `JSON.stringify` returns UNDEFINED for a
 * function or a symbol, which would print the word "undefined" for a value the host can see is
 * not — so those fall back to their own description. */
function show(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

/** Coerce one config value to a trimmed string, or undefined for anything else — `brand.ts`'s
 * rule, for `brand.ts`'s reason: this module is evaluated at module load in the entry
 * bundle's import graph, so a throw here is a blank page with a console error, not a header
 * that looks wrong. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A `font-family` value that cannot escape the declaration it lands in. React writes style
 * objects through the CSSOM, which already drops a value containing `;`, so this is about
 * FAILING LOUDLY rather than about injection: a family list with a semicolon or a brace in it
 * is a host that meant to write a whole rule, and silently rendering the design system's font
 * is how that goes unnoticed. */
const FONT_UNSAFE = /[;{}<>\\]/;

/**
 * Resolve the configured header style, falling back to the shipped default.
 *
 * Every rejection WARNS rather than being silently dropped — `resolveLayout`'s rule. This
 * config is hand-edited and often templated, and the failure it guards against is a
 * deployment that asked for its own colours, got the framework's, and only found out when
 * somebody who knew what to expect happened to look.
 */
export function resolvePageHeader(cfg: unknown): PageHeaderStyle {
  if (cfg === undefined || cfg === null) return DEFAULT_PAGE_HEADER_STYLE;
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    console.warn(`pramen/cms-editor: ignoring unusable \`pageHeader\` ${show(cfg)} — expected an object like \`{ variant: "flat", accent: "#73e2b2" }\`.`);
    return DEFAULT_PAGE_HEADER_STYLE;
  }
  const { variant, accent, titleFont } = cfg as PageHeaderConfig;
  return { variant: resolveVariant(variant), vars: resolveAccent(accent), titleFont: resolveTitleFont(titleFont) };
}

function resolveVariant(value: unknown): PageHeaderVariant {
  if (value === undefined || value === null) return DEFAULT_VARIANT;
  const named = str(value) ?? "";
  if ((PAGE_HEADER_VARIANTS as readonly string[]).includes(named)) return named as PageHeaderVariant;
  console.warn(
    `pramen/cms-editor: ignoring unusable \`pageHeader.variant\` ${show(value)} — using "${DEFAULT_VARIANT}". Expected one of ${PAGE_HEADER_VARIANTS.map((v) => JSON.stringify(v)).join(", ")}.`,
  );
  return DEFAULT_VARIANT;
}

function resolveAccent(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const named = str(value);
  const parsed = named === undefined ? undefined : parseColor(named);
  if (parsed === undefined) {
    console.warn(
      `pramen/cms-editor: ignoring unusable \`pageHeader.accent\` ${show(value)} — expected an opaque hex or rgb() literal like "#73e2b2". The editor derives the label colour on the accent, so a value it cannot read (var(), oklch(), a colour with alpha) would leave that contrast unchecked.`,
    );
    return {};
  }
  const { ratio } = onAccent(parsed);
  if (ratio < AA_NORMAL) {
    console.warn(
      `pramen/cms-editor: \`pageHeader.accent\` ${JSON.stringify(named)} carries no legible label — the best of ${ON_ACCENT_CANDIDATES.join(" / ")} on it is ${ratio.toFixed(2)}:1, under WCAG AA's ${AA_NORMAL}:1 for the button's 13px text. Using it anyway; pick a mid-toned accent to fix it.`,
    );
  }
  return accentVars(parsed);
}

function resolveTitleFont(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const named = str(value);
  if (named === undefined || FONT_UNSAFE.test(named)) {
    console.warn(`pramen/cms-editor: ignoring unusable \`pageHeader.titleFont\` ${show(value)} — expected a font-family list like "Inter, system-ui, sans-serif".`);
    return undefined;
  }
  return named;
}

/** The global the host's shell writes. Declared structurally rather than reaching for
 * `Window`, so this module needs no DOM lib — and so a test can hand it a plain object. */
export interface PageHeaderHost {
  PRAMEN_CMS_EDITOR?: { pageHeader?: unknown };
}

/** Pull the config off a host global, tolerating its absence (SSR, tests, a shell that
 * declared nothing). Exported so the READ is testable, not just the resolution. */
export function readPageHeaderConfig(host: PageHeaderHost | undefined): unknown {
  return host?.PRAMEN_CMS_EDITOR?.pageHeader;
}

/** The header style for THIS page load. Read at module load, like `BRAND` and
 * `CHROME_LAYOUT` — the shell's inline script runs ahead of the bundle, so it is already
 * set. */
let current: PageHeaderStyle = resolvePageHeader(readPageHeaderConfig(globalThis as PageHeaderHost));

/** What `page-header.tsx` renders from. A function rather than the const it reads like,
 * purely so `setPageHeaderStyle` below has something to change — the value is resolved ONCE,
 * at module load, and nothing in the running app ever writes it. */
export function pageHeaderStyle(): PageHeaderStyle {
  return current;
}

/** Override the resolved style, and `undefined` restores what the shell declared.
 *
 * Tests only — the same escape hatch, and the same reason, as `resetTheme` in `theme.ts`:
 * this is module state resolved before any component renders, so a test that wants to see
 * what `variant: "bare"` actually puts in the DOM has no other way in. The header is the one
 * place where the DOM is the contract (that is the whole of #60), so asserting on the markup
 * rather than on the resolved object is worth this. */
export function setPageHeaderStyle(style: PageHeaderStyle | undefined): void {
  current = style ?? resolvePageHeader(readPageHeaderConfig(globalThis as PageHeaderHost));
}
