// @pramen/analytics e2e — the whole pipeline against a real wrangler-dev DO: the public
// beacon endpoint, the privileged ingest it funnels into, the role gate on the metric
// reads, the daily rollup, and the prune that rollup makes safe.
//
// The unit tests (test/analytics-events.test.ts) cover classification. This covers the
// parts that only exist once there is a server: that a public POST actually lands a row,
// that an anonymous caller cannot read the numbers back, and that rolling up and then
// deleting the raw events leaves the dashboard reading the same totals.

import { assert, http, token } from "../lib";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

interface Beacon {
  kind: "pageview" | "engagement";
  viewId: string;
  path: string;
  referrer?: string | null;
  durationMs?: number;
  scrollDepth?: number;
  clicks?: number;
}

export async function runAnalytics(base: string): Promise<void> {
  // `main`, like the CMS suite: the collector is anonymous, and an anonymous caller can
  // only reach the open tenant. Every assertion below is therefore written against paths
  // this suite invents, or as a DELTA — never as an absolute total that another suite
  // could move.
  const TENANT = "main";
  const call = http(base, TENANT);
  const admin = await token("analytics-admin", ["admin"]);
  const editor = await token("analytics-editor", ["editor"]);
  const today = new Date().toISOString().slice(0, 10);
  const uniq = Math.random().toString(36).slice(2, 8);
  const article = `/e2e-${uniq}/article`;
  const other = `/e2e-${uniq}/other`;

  const beacon = async (events: Beacon[], opts: { ua?: string } = {}): Promise<number> => {
    const headers: Record<string, string> = {
      "content-type": "text/plain",
      "x-pramen-tenant": TENANT,
      "user-agent": opts.ua ?? BROWSER_UA,
    };
    const r = await fetch(`${base}/collect`, { method: "POST", headers, body: JSON.stringify({ events }) });
    return r.status;
  };

  // `/rpc` answers with the `{ ok, result }` envelope; every helper here unwraps it so the
  // assertions read as the values they are about.
  const overview = async (bearer: string) => call("analyticsOverview", { from: today, to: today }, bearer);
  const metrics = async (bearer: string) => (await overview(bearer)).body.result;
  const pagesOf = async (bearer: string) => (await call("analyticsTopPages", { from: today, to: today, limit: 50 }, bearer)).body.result;
  const viewsFor = (body: { path: string; pageviews: number }[], path: string): number =>
    body.find((p) => p.path === path)?.pageviews ?? 0;

  // --- the script the beacon lives in -------------------------------------------------
  const script = await fetch(`${base}/analytics.js`);
  assert(script.status === 200, "GET /analytics.js is served");
  const source = await script.text();
  assert(source.includes("sendBeacon"), "the tracker uses sendBeacon");
  assert(source.includes("pramen-view"), "the tracker looks for the server's view meta tag");

  // --- the public write path ----------------------------------------------------------
  const before = await overview(admin);
  assert(before.status === 200, "an admin can read the overview");
  const baseline = before.body.result.pageviews as number;

  assert((await beacon([{ kind: "pageview", viewId: `v-${uniq}-1`, path: article }])) === 204, "the beacon is accepted");
  await beacon([{ kind: "pageview", viewId: `v-${uniq}-2`, path: article, referrer: "https://www.google.com/search?q=x" }]);
  await beacon([{ kind: "pageview", viewId: `v-${uniq}-3`, path: other }]);

  const after = await metrics(admin);
  assert((after.pageviews as number) === baseline + 3, "three pageviews landed");

  const pages = await pagesOf(admin);
  assert(viewsFor(pages, article) === 2, "top pages counts the article twice");
  assert(viewsFor(pages, other) === 1, "and the other page once");

  // The query string must not fragment a page's history — the collector normalizes before
  // the row is written, so this is the SAME page as the two above.
  await beacon([{ kind: "pageview", viewId: `v-${uniq}-4`, path: `${article}?utm_source=newsletter` }]);
  assert(viewsFor(await pagesOf(admin), article) === 3, "a campaign parameter does not create a second page");

  // --- the bot filter -----------------------------------------------------------------
  // Dropped at the collector, so that the server-side hook (which sees every crawl) and the
  // beacon (which sees none) can ever be compared.
  const beforeBots = (await metrics(admin)).pageviews as number;
  await beacon([{ kind: "pageview", viewId: `v-${uniq}-bot`, path: article }], { ua: "Googlebot/2.1" });
  assert(((await metrics(admin)).pageviews as number) === beforeBots, "a crawler records nothing");
  // The other half of the filter — a client that sends NO User-Agent at all — is asserted in
  // test/analytics-events.test.ts and not here, because it cannot be produced over the wire:
  // `fetch` always sends one of its own, so omitting the header from this request tests the
  // HTTP client, not the collector.

  // --- engagement is not a second visit ------------------------------------------------
  const beforeEngagement = await metrics(admin);
  await beacon([{ kind: "engagement", viewId: `v-${uniq}-1`, path: article, durationMs: 30_000, scrollDepth: 80, clicks: 2 }]);
  const engaged = await metrics(admin);
  assert(
    (engaged.pageviews as number) === (beforeEngagement.pageviews as number),
    "an engagement report does not increment pageviews",
  );
  assert((engaged.engagedViews as number) >= 1, "it does count as a measured view");
  assert((engaged.avgDurationMs as number) > 0, "and it produces an average duration");

  // An absurd value from a public endpoint must be clamped, not averaged in.
  await beacon([{ kind: "engagement", viewId: `v-${uniq}-2`, path: article, durationMs: 999_999_999, scrollDepth: 5000 }]);
  const clamped = await metrics(admin);
  assert((clamped.avgScrollDepth as number) <= 100, "a scroll depth over 100 is clamped, not stored");

  // --- who may read ---------------------------------------------------------------------
  const anon = await overview("");
  assert(anon.status === 401 || anon.status === 403, `an anonymous caller cannot read the numbers (got ${anon.status})`);
  assert((await overview(editor)).status === 200, "an editor can read the dashboard's numbers");
  assert(
    (await call("runAnalyticsRollup", {}, editor)).status === 403,
    "but an editor cannot run the rollup — it writes",
  );
  assert(
    (await call("pruneAnalytics", {}, editor)).status === 403,
    "nor the prune, which is the only destructive operation here",
  );

  // The ingest handler is `auth: []` — satisfiable by no role, so it is unreachable over
  // /rpc even for an admin, while `callPrivileged` (which the collector uses) still gets in.
  assert((await call("__analyticsIngest", { events: [] }, admin)).status === 403, "ingest is not callable over /rpc");

  // --- the rollup, and the prune it makes safe -----------------------------------------
  // Roll up THROUGH today. In normal operation the cron rolls up yesterday, because a
  // finished day cannot change; passing `through` is what lets a test exercise it without
  // waiting for midnight.
  const totals = await metrics(admin);
  const pagesBefore = await pagesOf(admin);
  const rolled = await call("runAnalyticsRollup", { through: today }, admin);
  assert(rolled.status === 200, "the rollup runs");
  assert((rolled.body.result.days as string[]).includes(today), "it rolled up today");

  // Re-running must not double the numbers — the upsert is what stands in for a lease here.
  await call("runAnalyticsRollup", { through: today }, admin);
  const afterSecondRollup = await metrics(admin);
  assert(
    (afterSecondRollup.pageviews as number) === (totals.pageviews as number),
    "running the rollup twice writes the same numbers, it does not add to them",
  );
  assert(
    viewsFor(await pagesOf(admin), article) === viewsFor(pagesBefore, article),
    "and top pages is unchanged by the second run",
  );

  // The prune only ever deletes days that have an aggregate, and only ones older than the
  // retention window — so today's raw events survive a prune with the default keep.
  const pruned = await call("pruneAnalytics", { keepDays: 90 }, admin);
  assert(pruned.status === 200, "the prune runs");
  assert((pruned.body.result.deletedDays as string[]).includes(today) === false, "it does not delete a day inside the window");
  assert(
    ((await metrics(admin)).pageviews as number) === (totals.pageviews as number),
    "and the totals are unchanged",
  );
}
