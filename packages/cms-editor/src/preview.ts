// Where a minted preview token is redeemed.
//
// A LEAF module, like `chrome.ts`: the page editor and the collection editor both mint
// links, and the rule for turning a mint into an href has to be one rule.
//
// The CMS is headless. `signPagePreview` returns a token plus a relative url that the CMS
// Worker redeems itself — and that endpoint answers with JSON, because the server has the
// draft and no idea what it should look like. That is the right default for a machine and
// the wrong one for the person preview exists for: a stakeholder without an account, sent a
// link, who opens a wall of braces.
//
// So a host may declare where ITS OWN site renders a preview. Same seam as `menuHref` and
// the sitemap's `pageUrl` — the CMS cannot know how a deployment routes, so the deployment
// says. Unset, nothing changes: the link still points at the backend.

/** What the host may set under `window.PRAMEN_CMS_EDITOR.previewUrl`. */
interface PreviewHost {
  PRAMEN_CMS_EDITOR?: { previewUrl?: unknown };
}

/** The site's own preview route, if the shell declared a usable one.
 *
 * Anything that is not a non-empty string is ignored rather than coerced — a `previewUrl`
 * of `true` or `0` would otherwise build a link to `"true?token=…"`, which fails as a
 * broken page rather than as a configuration error anyone can see. */
export function sitePreviewUrl(host: PreviewHost = globalThis as PreviewHost): string | undefined {
  const raw = host.PRAMEN_CMS_EDITOR?.previewUrl;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Build the href for a minted PAGE preview.
 *
 * `resolve` is the fallback: the backend-relative url the mint returned, made absolute
 * against the CMS origin — exactly what this did before a site route could be declared. */
export function pagePreviewHref(
  minted: { url: string; token: string },
  opts: { siteUrl?: string; resolve: (path: string) => string },
): string {
  const site = opts.siteUrl;
  if (!site) return opts.resolve(minted.url);
  // The declared route may already carry query params (a locale, a layout switch), so the
  // separator is decided rather than assumed — `?` twice is a link that silently drops the
  // token into a parameter name.
  const sep = site.includes("?") ? "&" : "?";
  return `${site}${sep}token=${encodeURIComponent(minted.token)}`;
}
