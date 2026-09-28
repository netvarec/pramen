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
  return {
    ...countOf(rows.length, nouns),
    detail: copy.t("home.stat.status", { published: i18n.number(published), draft: i18n.number(draft) }),
  };
}

/** A number and the words after it, agreeing with it. */
function countOf(value: number, nouns?: ContentType["labels"]): Omit<DashboardStat, "detail"> {
  const count = nouns?.count;
  return { value, label: count ? getI18n().plural(value, count) : copy.tp("home.stat.entries", value) };
}

/** A content type's pages, by its slug. Needs a server that lists by type (`cms.pagesByType`). */
export async function loadContentTypeStat(api: DashboardApi, slug: string, labels?: ContentType["labels"]): Promise<DashboardStat> {
  const rows = await allPages((offset, limit) => api.call<StatusRow[]>("listPages", { contentType: slug, limit, offset, select: ["status"] }), PAGE_BATCH);
  return statusStat(rows, labels);
}

/** What {@link loadCollectionStat} needs to know about a collection: the `CollectionMeta` the
 * editor already holds (a home slot gets them as `props.collections`). */
export type CollectionStatSource = Pick<CollectionMeta, "slug" | "idField" | "fields"> & Partial<Pick<CollectionMeta, "labels" | "supports">>;

/** A collection's rows.
 *
 * Only some collections have a published / draft split: those with `supports: ["drafts"]`
 * (a CMS-managed `status`), and those whose OWN `status` field holds the same two values.
 * The rest are plain tables, and splitting them read "Published 0 · drafts 0" under a count of
 * rows that are all current, so they get the count and a line saying there is no publish step.
 * Nothing here claims those rows are on the website: that is the app's ACL, not the CMS's.
 *
 * Pass the collection's meta. A bare slug is looked up with `listCollections` (one more call),
 * so a hand-wired tile gets the same answer as the theme's own rather than a wrong default. */
export async function loadCollectionStat(api: DashboardApi, collection: string | CollectionStatSource): Promise<DashboardStat> {
  const meta = typeof collection === "string" ? await findCollection(api, collection) : collection;
  // Only the columns the answer needs, never whole rows: a count over wide json cells is the
  // D1-over-RPC failure mode (GitHub #22). `status` is selected only where it is a real column
  // (a managed one, or a declared field), since `find` refuses a column it cannot read. A meta
  // without `supports` (an older server) cannot say which, so it reads whole rows and decides
  // from the data.
  const managed = meta.supports?.includes("drafts") ?? false;
  const ownStatus = meta.fields.some((f) => f.name === "status");
  const select = meta.supports === undefined ? undefined : managed || ownStatus ? ["status"] : [meta.idField];
  const rows = await allPages(
    (offset, limit) => api.call<StatusRow[]>("collectionList", { collection: meta.slug, limit, offset, ...(select ? { select } : {}) }),
    COLLECTION_BATCH,
  );
  const labels = meta.labels ?? undefined;
  if (managed || rows.some((row) => row.status === "published" || row.status === "draft")) return statusStat(rows, labels);
  return { ...countOf(rows.length, labels), detail: copy.t("home.stat.noDrafts") };
}

async function findCollection(api: DashboardApi, slug: string): Promise<CollectionStatSource> {
  const metas = await api.call<CollectionStatSource[]>("listCollections");
  const meta = metas.find((m) => m.slug === slug);
  if (!meta) throw new Error(`loadCollectionStat: no collection '${slug}' is visible to this session`);
  return meta;
}

/** The media library. */
export async function loadMediaStat(api: DashboardApi): Promise<DashboardStat> {
  const rows = await allPages((offset, limit) => api.call<unknown[]>("listMedia", { limit, offset }), MEDIA_BATCH);
  return { value: rows.length, label: copy.tp("home.stat.files", rows.length), detail: copy.t("home.stat.filesDetail") };
}
