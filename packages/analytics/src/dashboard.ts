// The dashboard: one Block Kit admin page at `/apps/analytics` in the CMS editor.
//
// Block Kit rather than a panel, on the rule stated in `@pramen/cms`'s own header: a panel
// is for a screen that IS the interaction, and this one is a period picker over numbers.
// It also means no project JavaScript, no bundle to keep in step with the editor, and no
// React version to align — for a screen that is read far more often than it is touched.
//
// `@pramen/cms` is an OPTIONAL peer, and the import below is type-only (erased at runtime),
// so a deployment with no CMS can still use the collector, the rollup and the queries; it
// simply has nowhere to render this. The returned value is a plain `AdminPageDef` literal
// rather than a call to `adminPage()` for exactly that reason — `adminPage` is a runtime
// import, and this module must not have one.

import type { AdminBlock, AdminPageDef, AdminPageResponse } from "@pramen/cms";
import type { HandlerContext, SchemaDef } from "@pramen/server";
import { metricsForRange, topPages, type RangeMetrics } from "./queries";
import type { AnalyticsDb } from "./ingest";
import { analyticsSchema } from "./schema";

/** The offered periods, in days. `1` is today. */
const PERIODS: { value: string; label: string; days: number }[] = [
  { value: "1", label: "Today", days: 1 },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
];

const DEFAULT_PERIOD = "7";

function rangeFor(period: string, now = new Date()) {
  const days = PERIODS.find((p) => p.value === period)?.days ?? 7;
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const fmtPct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** Turn a `{ key: count }` breakdown into a table, biggest first. */
function breakdownTable(label: string, counts: Record<string, number>, limit = 8): AdminBlock[] {
  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => ({ key, views: String(n) }));
  return [
    { type: "header", text: label, level: 3 },
    {
      type: "table",
      columns: [
        { key: "key", label },
        { key: "views", label: "Views" },
      ],
      rows,
      empty: "No data for this period.",
    },
  ];
}

/** The traffic series, until Block Kit grows a chart block.
 *
 * A table and not a picture, deliberately: the alternatives were to render a chart as an
 * `image` (a server-side SVG, which the editor would have to be allowed to inline) or to
 * make this the project's first `adminPanel`. Both are larger decisions than the first
 * slice should be making on its own, and a numeric series is honest about what it is —
 * where an ASCII bar chart in a monospace column only looks like one. */
function seriesTable(days: { day: string; pageviews: number }[]): AdminBlock[] {
  const rows = [...days].reverse().map((d) => ({ day: d.day, views: String(d.pageviews) }));
  return [
    { type: "header", text: "By day", level: 3 },
    {
      type: "table",
      columns: [
        { key: "day", label: "Day" },
        { key: "views", label: "Pageviews" },
      ],
      rows,
      empty: "No traffic recorded in this period.",
    },
  ];
}

function statsBlock(m: RangeMetrics): AdminBlock {
  return {
    type: "stats",
    stats: [
      { label: "Pageviews", value: String(m.pageviews) },
      { label: "Sessions", value: String(m.sessions), hint: "Distinct visits. Requires ANALYTICS_SALT (or AUTH_SECRET) to be set." },
      { label: "Bounce rate", value: fmtPct(m.bounceRate), hint: "Sessions that viewed exactly one page. Lower is better." },
      { label: "Avg. time", value: fmtDuration(m.avgDurationMs), hint: "Averaged over views the beacon reported on, not over all pageviews." },
      { label: "Avg. scroll", value: m.avgScrollDepth === null ? "—" : `${m.avgScrollDepth}%` },
      { label: "Measured views", value: String(m.engagedViews), hint: "Pageviews the browser beacon reported engagement for." },
    ],
  };
}

/** Page id -> display title, as `resolveTitles` answers. Named so the empty case and the
 * resolved case share one contract instead of an inline dictionary at each site. */
export type PageTitles = Record<string, string>;

export interface AnalyticsDashboardOpts {
  /** Registry key and URL: the page is served at `/apps/<slug>`. */
  slug?: string;
  label?: string;
  icon?: string;
  navOrder?: number;
  /** Who may open it. Defaults to the deployment's `editorRoles`. */
  roles?: readonly string[];
  /** Resolve CMS page titles for Top Pages. Optional: without it the table shows paths,
   * which is what a deployment with no CMS has anyway. */
  resolveTitles?: (ctx: HandlerContext<SchemaDef>, pageIds: string[]) => Promise<PageTitles>;
}

/** Build the dashboard page. Spread into `createAdminPageHandlers([...])`. */
export function analyticsDashboard(opts: AnalyticsDashboardOpts = {}): AdminPageDef<typeof analyticsSchema> {
  return {
    slug: opts.slug ?? "analytics",
    label: opts.label ?? "Analytics",
    icon: opts.icon ?? "📈",
    navOrder: opts.navOrder,
    roles: opts.roles,
    async render(ctx, interaction): Promise<AdminPageResponse> {
      // The period rides in the interaction's values; a page_load has none, so it falls
      // back to the default. There is no server-side state to keep — the whole page is
      // rebuilt on every interaction, which is the Block Kit contract.
      const raw = interaction.values?.period;
      // `interaction.type` is "page_load" on first render and has no values at all — hence
      // the fallback rather than an error.
      const period = typeof raw === "string" && PERIODS.some((p) => p.value === raw) ? raw : DEFAULT_PERIOD;
      const { from, to } = rangeFor(period);

      const db = ctx.db as AnalyticsDb;
      const metrics = await metricsForRange(db, from, to);
      const pages = await topPages(db, from, to, 10);

      // `render`'s ctx is typed to the analytics schema; a title resolver reads the app's
      // OWN tables, so it takes the generic context. The widening is the seam between the
      // two, and it is safe in the direction that matters: a resolver may only use what the
      // base contract guarantees.
      const withPageIds = pages.map((p) => p.pageId).filter((id): id is string => id !== null);
      const titles: PageTitles = opts.resolveTitles ? await opts.resolveTitles(ctx, withPageIds) : {};

      const blocks: AdminBlock[] = [
        { type: "header", text: "Analytics", level: 1 },
        {
          type: "actions",
          block_id: "period",
          elements: [
            {
              type: "select",
              action_id: "period",
              label: "Period",
              options: PERIODS.map((p) => ({ value: p.value, label: p.label })),
              initial_value: period,
            },
            // The button is not decoration. In the editor an input only writes to the page's
            // value bag; a BUTTON is the only element that fires an interaction, and it
            // carries the whole bag with it. A select on its own would change nothing and
            // read as broken.
            { type: "button", action_id: "apply", label: "Apply", style: "primary" },
          ],
        },
        { type: "context", text: `${from} → ${to}` },
        statsBlock(metrics),
        { type: "divider" },
        { type: "header", text: "Top pages", level: 3 },
        {
          type: "table",
          columns: [
            { key: "page", label: "Page" },
            { key: "views", label: "Views" },
          ],
          rows: pages.map((p) => ({
            page: (p.pageId && titles[p.pageId]) || p.path,
            views: String(p.pageviews),
          })),
          empty: "No pageviews recorded in this period.",
        },
        { type: "divider" },
        ...seriesTable(metrics.days),
        { type: "divider" },
        { type: "columns", columns: [breakdownTable("Source", metrics.bySource), breakdownTable("Device", metrics.byDevice)] },
        ...breakdownTable("Country", metrics.byCountry),
      ];

      return { blocks };
    },
  };
}
