// The deployment's wordmark, resolved once from the host's /config.js.
//
// Deliberately free of React, podoba and DOM-lib imports: it is read at module load (before
// any component renders) and it is the one piece of chrome a host is expected to change, so
// it stays a pure function of config that can be exercised without a browser.

/** What the host may set under `window.PRAMEN_CMS_EDITOR.brand`. */
export interface BrandConfig {
  /** The wordmark. Blank/absent keeps the default. */
  name?: string;
  /** The muted half after the middot. Absent keeps the default; `null` drops it. */
  suffix?: string | null;
}

/** A resolved wordmark. */
export interface Brand {
  name: string;
  suffix: string | null;
  /** Name and suffix joined for `document.title` — where the middot reads correctly. */
  title: string;
  /** The same words with no punctuation, for an accessible name. A screen reader announces
   * "·" as "middle dot" at higher verbosity, so the decorative separator that belongs in a
   * tab title does not belong in an aria-label. */
  spoken: string;
}

export const DEFAULT_BRAND_NAME = "pramen";
export const DEFAULT_BRAND_SUFFIX = "cms";

/** Coerce one config value to a trimmed string, or undefined for anything else.
 *
 * /config.js is hand-edited, untyped, and often templated from an env var, so a value here
 * can be any JSON type. `?.trim()` guards null and undefined ONLY — `suffix: false` (a
 * plausible slip next to `hidePages: true`) or `name: 123` would THROW, and since `BRAND` is
 * resolved at module load in the entry bundle's import graph, that throw aborts evaluation
 * before `createRoot` and renders a blank page with nothing but a console error. Every other
 * field in this config object already fails safe; this one must too. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Resolve the configured wordmark, falling back to what used to be hardcoded.
 *
 * The distinction that matters is ABSENT vs. `null` on `suffix`: a host that only renames
 * the product keeps the "· cms" half, while `suffix: null` is the explicit "just our name".
 *
 * A `brand` that is present but yields no usable name is WARNED about rather than silently
 * accepted: `brand: "Acme"` (the shorthand instead of `{ name: "Acme" }`), a misspelled key,
 * or a template that resolved to an empty string all end up shipping the framework's name to
 * the client — the exact outcome this config exists to prevent — and a green deploy is the
 * worst place to discover it. */
export function resolveBrand(cfg?: BrandConfig): Brand {
  const configured = str(cfg?.name);
  if (cfg !== undefined && cfg !== null && configured === undefined) {
    console.warn(
      `pramen/cms-editor: \`brand\` is set but has no usable \`name\`, so the wordmark stays "${DEFAULT_BRAND_NAME}". Expected \`brand: { name: "Your name" }\`.`,
    );
  }
  const name = configured ?? DEFAULT_BRAND_NAME;
  // `undefined` (not configured) keeps the default; `null` — and any non-string — drops it.
  const suffix = cfg?.suffix === undefined ? DEFAULT_BRAND_SUFFIX : (str(cfg.suffix) ?? null);
  return { name, suffix, title: suffix ? `${name} · ${suffix}` : name, spoken: suffix ? `${name} ${suffix}` : name };
}

/** The global the host's /config.js writes. Declared structurally rather than reaching for
 * `Window`, so this module needs no DOM lib — and so a test can hand it a plain object. */
export interface BrandHost {
  PRAMEN_CMS_EDITOR?: { brand?: BrandConfig };
}

/** Pull the brand config off a host global, tolerating its absence (SSR, tests, a /config.js
 * that 404'd). Exported so the READ is testable, not just the resolution. */
export function readBrandConfig(host: BrandHost | undefined): BrandConfig | undefined {
  return host?.PRAMEN_CMS_EDITOR?.brand;
}

/** The wordmark for THIS page load. Read at module load, like `SIGN_IN_URL` — /config.js is
 * a plain script tag ahead of the bundle, so it is already set. */
export const BRAND: Brand = resolveBrand(readBrandConfig(globalThis as BrandHost));

/** The two chrome strings built from the wordmark, in one place so the words that are NOT
 * the client's name can be seen together — and so neither call site re-invents them.
 *
 * Both keep saying "editor" on the DEFAULT wordmark, because that is what the Setup screen
 * and the browser tab have always said; a configured brand replaces the lot rather than
 * having an English noun appended to it. */
export const SETUP_TITLE: string = BRAND.suffix ? `· ${BRAND.suffix}${isDefault(BRAND) ? " editor" : ""}` : "";
export const DOCUMENT_TITLE: string = isDefault(BRAND) ? `${BRAND.title} editor` : BRAND.title;

/** Whether nothing was configured — the unbranded default, which must render exactly as it
 * did before this module existed. */
function isDefault(b: Brand): boolean {
  return b.name === DEFAULT_BRAND_NAME && b.suffix === DEFAULT_BRAND_SUFFIX;
}
