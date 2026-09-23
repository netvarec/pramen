// The numbers on the dashboard's tiles, read over the same authenticated API the editor uses.
//
// No invented statistics: every tile counts rows the signed-in editor can already see on the
// screen the tile links to. A tile with nothing to count (a custom panel) shows its description
// instead of a zero, and a tile whose count has not arrived says so rather than claiming none.
//
// Exported (`@pramen/cms-theme-gs/dashboard-data`) so a project can give its OWN tiles a stat
// with the same paging and the same wording: praha counts its events panel with
// `loadContentTypeStat(api, "akce")`, and its venues with a loader of its own that returns a
// `DashboardStat`.

import { getI18n } from "@pramen/cms-editor/i18n";
import type { ContentType, CollectionMeta, EditorApi } from "@pramen/cms-editor/slots";
import { copy } from "./copy";

/** What a tile shows: a number, the words after it, and a line under them. */
export interface DashboardStat {
  value: number;
  /** The words after the number, already agreeing with it ("records in total"). */
  label: string;
  /** The line under the title ("Published 3 · drafts 1"). */
  detail: string;
}

/** The one call a loader needs. */
export type DashboardApi = Pick<EditorApi, "call">;

type StatusRow = { status?: unknown };

const PAGE_BATCH = 500;
const MEDIA_BATCH = 200;
const COLLECTION_BATCH = 500;

/**
 * Read every page of a paged RPC list.
 *
 * The CMS returns a short final page and caps `limit` per handler, so a full page means there
 * may be more rows: counting only the first answer silently undercounts a large library.
 */
export async function allPages<T>(fetchPage: (offset: number, limit: number) => Promise<T[]>, limit: number): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += limit) {
    const page = await fetchPage(offset, limit);
    rows.push(...page);
    if (page.length < limit) return rows;
  }
}

/** A row count with its published / draft split, in the editor's language. `nouns` are the
 * plural forms of the words after the number; the theme's "records in total" by default. */
export function statusStat(rows: readonly StatusRow[], nouns?: ContentType["labels"]): DashboardStat {
  let published = 0;
  let draft = 0;
  for (const row of rows) {
    if (row.status === "published") published++;
    else if (row.status === "draft") draft++;
  }
  const i18n = getI18n();
  const count = nouns?.count;
  return {
    value: rows.length,
    label: count ? i18n.plural(rows.length, count) : copy.tp("home.stat.entries", rows.length),
    detail: copy.t("home.stat.status", { published: i18n.number(published), draft: i18n.number(draft) }),
  };
}

/** A content type's pages, by its slug. Needs a server that lists by type (`cms.pagesByType`). */
export async function loadContentTypeStat(api: DashboardApi, slug: string, labels?: ContentType["labels"]): Promise<DashboardStat> {
  const rows = await allPages((offset, limit) => api.call<StatusRow[]>("listPages", { contentType: slug, limit, offset, select: ["status"] }), PAGE_BATCH);
  return statusStat(rows, labels);
}

/** A collection's rows, by its slug. */
export async function loadCollectionStat(api: DashboardApi, slug: string, labels?: CollectionMeta["labels"]): Promise<DashboardStat> {
  const rows = await allPages((offset, limit) => api.call<StatusRow[]>("collectionList", { collection: slug, limit, offset }), COLLECTION_BATCH);
  return statusStat(rows, labels);
}

/** The media library. */
export async function loadMediaStat(api: DashboardApi): Promise<DashboardStat> {
  const rows = await allPages((offset, limit) => api.call<unknown[]>("listMedia", { limit, offset }), MEDIA_BATCH);
  return { value: rows.length, label: copy.tp("home.stat.files", rows.length), detail: copy.t("home.stat.filesDetail") };
}
