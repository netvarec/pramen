// Link-href safety. A LEAF module on purpose: `@pramen/cms/react` needs these at runtime,
// and importing them from `./index` pulled the whole server SDK into every browser bundle
// that renders rich text (`index.ts` evaluates `Entity(...)` calls at module scope for
// `cmsSchema`, which no bundler can tree-shake — measured 785 B -> 56 kB).

/** Strip the characters the WHATWG URL parser ignores before parsing (ASCII tab/CR/LF),
 * then trim. Store and render THIS form, so what was validated is what a browser resolves. */
export function normalizeHref(raw: string): string {
  return raw.replace(/[\t\n\r]/g, "").trim();
}

/** Allow-list for a link href: http(s), mailto, tel, or a relative/anchor path.
 *
 * Whitespace is stripped FIRST, because the URL parser does the same — `/\r\n/evil.example/x`
 * otherwise passes a prefix test and still resolves to `https://evil.example/x`. Then a
 * single leading slash only, whose next character may be neither `/` nor `\` (the parser
 * folds `\` to `/` at path-start for special schemes). The scheme allow-list inherently
 * rejects `javascript:`, `data:` and `vbscript:`.
 *
 * This is the security boundary — the write-path normalizer and BOTH renderers call it —
 * not the UI hint that @podoba/react's `safeLinkUrl` is. */
export function isSafeHref(raw: unknown): boolean {
  return typeof raw === "string" && /^(https?:\/\/|mailto:|tel:|\/(?![/\\])|#)/i.test(normalizeHref(raw));
}
