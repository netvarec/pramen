// The browser beacon, as a string served by `trackerRoute`.
//
// Shipped as source rather than built because it is small enough to read in one sitting,
// and a build step for one file would put the thing that runs on every visitor's page
// behind a toolchain nobody looks at.
//
// WHAT IT IS AND IS NOT FOR. It is the second of two collectors. The Worker records a
// pageview whenever it serves the page; this records one only when no Worker did, and
// otherwise reports the things a server cannot see. Which case it is in is decided by the
// HTML the visitor actually received — see `VIEW_META`.

/** The meta tag a server-rendered page carries: `<meta name="pramen-view" content="…">`.
 *
 * This one tag is the entire hybrid. If it is present, a Worker already recorded this
 * pageview and the beacon sends only engagement against that id; if it is absent, nothing
 * did, and the beacon mints an id and records the pageview itself.
 *
 * Deciding it from the DOM rather than from configuration is what makes it correct without
 * anyone maintaining it: a site with some prerendered and some on-demand routes gets the
 * right answer per page, and a route that later switches from static to on-demand starts
 * being counted by the server with no analytics change at all. A config flag would be a
 * second copy of that fact, and copies drift. */
export const VIEW_META = "pramen-view";

/** Ceilings the collector also enforces (`clampMetric`). Duplicated here only to keep an
 * absurd value off the wire; the server never trusts these. */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

export interface TrackerOptions {
  /** Where the beacon POSTs. Same-origin by default. */
  collectPath?: string;
}

/** Build the tracker source for a deployment. */
export function trackerScript(opts: TrackerOptions = {}): string {
  const collect = JSON.stringify(opts.collectPath ?? "/collect");
  return `(function () {
  "use strict";
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
  // Respect an explicit opt-out. Cheap to honour, and this endpoint sets no identifier
  // that a visitor could clear themselves.
  if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;

  var URL_ = ${collect};
  var meta = document.querySelector('meta[name="${VIEW_META}"]');
  var serverViewId = meta && meta.getAttribute("content");
  // A server-recorded view keeps the server's id; otherwise this page load IS the pageview.
  var viewId = serverViewId || (function () {
    try { return crypto.randomUUID(); } catch (e) { return String(Date.now()) + Math.random().toString(36).slice(2); }
  })();

  var start = Date.now();
  var maxScroll = 0;
  var clicks = 0;
  var sent = false;

  function scrollDepth() {
    var h = document.documentElement;
    var total = Math.max(h.scrollHeight - h.clientHeight, 0);
    if (total <= 0) return 100; // a page with nothing to scroll was seen in full
    return Math.min(100, Math.round(((window.scrollY || 0) / total) * 100));
  }

  function onScroll() { var d = scrollDepth(); if (d > maxScroll) maxScroll = d; }
  function onClick() { clicks++; }

  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("click", onClick, { passive: true, capture: true });

  function payload(kind) {
    return {
      kind: kind,
      viewId: viewId,
      path: location.pathname,
      referrer: document.referrer || null,
      durationMs: Math.min(Date.now() - start, ${MAX_DURATION_MS}),
      scrollDepth: Math.max(maxScroll, scrollDepth()),
      clicks: clicks
    };
  }

  function send(kind) {
    // Plain text, not application/json: a JSON content type makes this a non-simple
    // cross-origin request and earns a preflight that sendBeacon cannot survive on
    // pagehide. The collector parses the body itself.
    try { navigator.sendBeacon(URL_, JSON.stringify({ events: [payload(kind)] })); } catch (e) {}
  }

  // The pageview goes immediately when nothing else recorded it — waiting for pagehide
  // would lose every visitor whose browser discards the beacon on a crash or a force-quit,
  // and a pageview that arrives late is worth less than one that arrives.
  if (!serverViewId) send("pageview");

  function finish() {
    if (sent) return;
    sent = true;
    send("engagement");
  }

  // Both, because neither fires reliably alone: pagehide misses a backgrounded mobile tab
  // that is later killed, and visibilitychange fires on a tab switch the visitor returns
  // from. \`sent\` makes the duplicate harmless.
  addEventListener("pagehide", finish);
  addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") finish(); });
})();
`;
}
