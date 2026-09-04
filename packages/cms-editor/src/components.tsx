// Presentational + interactive pieces of the editor, shared across route files. The
// route modules under `routes/` are thin adapters: they pull `api`/`me`/`setError` from
// the app context and wire URL params + navigation into these components.

import { Button, Dialog, type DialogSize, DropdownMenu, DropdownMenuItem, DropdownMenuTrigger, Input, SearchField, Textarea } from "@podoba/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, ApiError } from "./api";
import { CONTROL, FieldForm, formatWhen, fromLocalInput, slugify, toLocalInput } from "./fields";
import { BELOW_APP_BAR, BELOW_PAGE_TOOLBAR, PAGE_TOOLBAR_H, ROW, WRAP } from "./chrome";
import { useCrumb } from "./breadcrumb";
import { PageHeader } from "./page-header";
import { pagePreviewHref, sitePreviewUrl } from "./preview";
import type { Config } from "./api";
import { useApp, type Me } from "./app-context";
import { isRichTextDoc, richTextToPlainText } from "./rich-text";
import { flattenTerms } from "./furniture";
import type { AssembledPage, AuditEntry, BlockType, CmsCapabilities, CollectionMeta, ContentType, FieldDefinition, FieldValue, FieldValues, Media, MediaKind, MediaSort, Page, RegionDefinition, RenderedBlock, Taxonomy, Term } from "./types";
import { MEDIA_KIND_LABELS, MEDIA_KINDS, MEDIA_SORT_LABELS, MEDIA_SORTS } from "./types";

export type InspectorTab = "settings" | "seo" | "i18n" | "terms" | "audit";
// `workflow` is deliberately NOT here any more. Publishing is what someone opened the editor
// to do, and it was a lowercase ghost button among five that looked like filter chips — you
// had to know the word "workflow" meant "publish". The transitions now live in the toolbar,
// where the state they act on is already shown.
export const INSPECTOR_TABS: InspectorTab[] = ["settings", "seo", "i18n", "terms", "audit"];

/** What each tab is called on screen. A table rather than a CSS `capitalize`, which renders
 * "seo" as "Seo" and "i18n" as "I18n" — both wrong, and wrong in the one place a reader is
 * scanning for the word they want. */
export const INSPECTOR_TAB_LABELS = {
  settings: "Settings",
  seo: "SEO",
  i18n: "Translations",
  terms: "Terms",
  audit: "History",
} satisfies Record<InspectorTab, string>;

/** One workflow transition the page can make from where it is. */
export interface PageAction {
  label: string;
  /** The RPC handler name — `publishPage`, `approve`, … */
  action: string;
}

/**
 * The transitions valid FROM `status`, most-expected first.
 *
 * The head of the list is the toolbar's primary button and the tail goes in its menu, so the
 * ORDER is the contract: a draft's obvious next move is Publish, a page in review is waiting
 * for Approve, and a published page's only move is to take it down. Showing transitions the
 * server would reject (an "Approve" on a draft) is how a UI teaches someone that its buttons
 * lie; the server still enforces the role gate on every one of these.
 */
export function pageWorkflowActions(status: string): PageAction[] {
  switch (status) {
    case "review":
      return [
        { label: "Approve & publish", action: "approve" },
        { label: "Reject", action: "reject" },
        // The solo operator's escape from the two-actor pipeline — same endpoint the draft
        // path offers, kept reachable so a reviewer is not forced through their own review.
        { label: "Publish directly", action: "publishPage" },
      ];
    case "published":
      return [{ label: "Unpublish", action: "unpublishPage" }];
    default: // draft | rejected | archived
      return [
        { label: "Publish", action: "publishPage" },
        { label: "Submit for review", action: "submitForReview" },
      ];
  }
}

/** The tabs a deployment actually shows. ONE definition, used by the tab bar, the panel
 * switch and the route's deep-link fallback — three places that previously each re-derived
 * "is i18n visible?" and could disagree.
 *
 * `terms` follows `siteFurniture` for the same reason `i18n` follows `multilingual`: on a
 * server without the taxonomy handlers the panel could only ever render an error. With them
 * and no vocabularies defined it renders its own empty state, which is the honest answer
 * and points at the screen that fixes it. */
export function visibleTabs(multilingual: boolean, siteFurniture = false): InspectorTab[] {
  return INSPECTOR_TABS.filter((t) => (t === "i18n" ? multilingual : t === "terms" ? siteFurniture : true));
}

/** Collections-only deployments hide the block/page builder entirely. Read in one place so
 * the nav, the landing redirect and the per-type route cannot disagree about it — a deep
 * link to `/types/:slug` used to render the very builder this flag exists to hide. */
export function pagesHidden(): boolean {
  return typeof window !== "undefined" && window.PRAMEN_CMS_EDITOR?.hidePages === true;
}

/**
 * Does this deployment get one tab and one list PER CONTENT TYPE?
 *
 * ONE definition, used by the tab bar, the landing redirect and the page editor's back
 * target — the same reason `visibleTabs` exists. Three places re-deriving the whole nav
 * shape is three places that can disagree about which screen `/` is.
 *
 * - `null` content types mean NOT ANSWERED YET, and answer `false` without committing: the
 *   pooled list is what a single-type deployment keeps, so painting it before the count
 *   arrives is a flash of the exact screen the split exists to retire.
 * - `pagesByType` is the SERVER's declaration that `listPages` understands `contentType`
 *   (see `CmsCapabilities`). Without it the split fails open: N tabs, each showing every
 *   type's pages under a heading naming one.
 */
export function splitsByType(contentTypes: ContentType[] | null, cms: CmsCapabilities, hidePages = pagesHidden()): boolean {
  return !hidePages && cms.pagesByType && contentTypes !== null && contentTypes.length > 1;
}

// --- presentational primitives (podoba tokens; replaces styles.ts classes) ---


/** The library screens' header. See `page-header.tsx`; `Hero` stays as the local name the
 * five call sites below already use. */
const Hero = PageHeader;

// `Cta` used to live here: a 360px-wide mint pill carrying a sentence ("Let's upload
// something") wrapped around the actual button. It is gone, and the header's action is now
// just the button.
//
// The header grew a cover (see `Hero`), and a saturated pill on top of it was a panel inside
// a panel — a second filled surface competing with the artwork for the same corner. The
// sentence went with it because by then it was the third telling of one fact: the title above
// says "Media / None yet", the empty state below says "No media yet. Upload images to…", and
// the button itself says "+ Upload".
//
// It also carried a real bug, visible only on the dark theme. The wrapper was `bg-brand-green`
// (#75e7b8) and podoba maps `brand-primary` — what a default `Button` fills with — onto
// #75e7b8 in dark. Mint on mint: the button had no edge at all, and read as a run of text.
// Sitting directly on `surface-card` it has proper contrast in both themes, which is the
// contrast podoba designed for it.

function Section({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-[18px] text-sm text-fg-subtle first:mt-0">{children}</div>;
}

function Pill({ status, children }: { status?: string; children: ReactNode }) {
  // Token-only colors (no hardcoded hex) so status pills flip correctly under the
  // podoba dark theme. `fg-on-brand` is the AA-safe ink on the fixed brand surfaces.
  const tone =
    status === "published" || status === "active"
      ? "bg-brand-green text-fg-on-brand border-transparent"
      : status === "in_review" || status === "review"
        ? "bg-accent-yellow text-fg-on-brand border-transparent"
        : status === "rejected" || status === "archived" || status === "inactive"
          ? "border-danger text-danger bg-surface-card"
          : "border-border text-fg-muted bg-surface-card";
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-caption font-medium ${tone}`}>{children}</span>;
}

/**
 * A modal, on podoba's `Dialog`.
 *
 * It used to hand-compose `ModalOverlay` + `ModalSurface` + `ModalDialog` with its own
 * max-widths — the raw primitives podoba documents for "edge-to-edge / split modal
 * compositions", which a form dialog is not. What that cost was everything `Dialog` puts
 * around the content: the ✕ (this app's modals could only be left by finding the word
 * "cancel", or by guessing that Esc works), the labelling `<Heading slot="title">`, the
 * `description` block, and the size presets — including `full`, the near-fullscreen canvas.
 *
 * `size` is passed straight through, so picking a modal's weight is one prop rather than a
 * `wide` boolean that meant 680px and nothing else.
 */
function Modal({
  onClose,
  size,
  title,
  description,
  children,
}: {
  onClose: () => void;
  size?: DialogSize;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog isOpen isDismissable size={size} title={title} description={description} onOpenChange={(open) => !open && onClose()}>
      {children}
    </Dialog>
  );
}

function KV({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2 text-[13px] text-fg-muted [&>span:nth-child(odd)]:text-fg-subtle ${className ?? ""}`}>{children}</div>;
}

function Card({ children }: { children: ReactNode }) {
  // rounded-lg is the unified podoba card radius (the 1.1rem soft-panel radius was retired).
  return <div className="overflow-auto rounded-lg border border-border bg-surface-card p-6">{children}</div>;
}

function Banner({ ok, children }: { ok?: boolean; children: ReactNode }) {
  // Token-only colors so the banner reads correctly in dark mode too.
  return (
    <div className={`my-2 rounded-lg border px-3.5 py-2.5 text-small ${ok ? "border-brand-green bg-brand-green/20 text-fg" : "border-danger bg-surface-card text-danger"}`}>{children}</div>
  );
}

const Dim = ({ children }: { children: ReactNode }) => <span className="text-fg-subtle">{children}</span>;

/** A one-line neutral panel with an optional way out — the loading / not-found / unknown-slug
 * state every route needs before (or instead of) its real screen. Four routes had it written
 * out verbatim; the copies had already drifted on which of them offered a way back. */
export function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[1200px] items-center gap-2 px-7 pt-8">
      <p className="text-fg-subtle">{children}</p>
      {action}
    </div>
  );
}

// --- pages list --------------------------------------------------------------

/** Page size for the page list. `listPages` caps server-side, so a request without an
 * explicit limit silently truncates — and the header then reports the truncated count as if
 * it were the total, which reads as "that is all there is". Same reason, same answer, as
 * `COLLECTION_PAGE_SIZE` below. */
const PAGE_LIST_SIZE = 50;

/** The page list, loading its own rows. `type` scopes it to one content type: the fetch asks
 * the SERVER for that type (narrowing a capped list here would drop the tail of every type),
 * the heading is the type's name, and the create modal opens on that type instead of asking
 * again. Omitted ⇒ the pooled list over every type, which is what a single-type deployment
 * should keep seeing — byte for byte, including the wording.
 *
 * It owns the fetching (like `CollectionList`) rather than taking rows as a prop, because
 * the two things that go wrong when a route owns them both go wrong invisibly: rows left
 * standing from the previous type while the heading has already flipped to the new one, and
 * a count that is really the server's cap. */
export function PageList({ api, type, onOpen, onError }: { api: Api; type?: ContentType; onOpen: (p: Page) => void; onError: (s: string) => void }) {
  // From the SERVER (listCmsCapabilities), not a local flag — see `CmsCapabilities`.
  const { cms: { multilingual } } = useApp();
  const [pages, setPages] = useState<Page[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
  const [creating, setCreating] = useState(false);
  const contentType = type?.slug;

  const load = useCallback(
    (off: number) => {
      setLoading(true);
      return api
        .listPages({ contentType, limit: PAGE_LIST_SIZE, offset: off })
        .then((r) => {
          setPages((prev) => (off === 0 ? r : [...prev, ...r]));
          // A full page means there is probably more; a short one is definitely the end.
          setHasMore(r.length === PAGE_LIST_SIZE);
          setOffset(off + r.length);
        })
        .catch((e) => onError(errMsg(e)))
        .finally(() => setLoading(false));
    },
    [api, contentType, onError],
  );

  // Clearing first is the point: buzola renders the same component instance across a
  // params-only change (`/types/a` → `/types/b`), so without this the previous type's rows
  // sit under the new type's heading until the fetch lands — and permanently if it fails.
  useEffect(() => {
    setPages([]);
    setOffset(0);
    setHasMore(false);
    void load(0);
  }, [load]);

  // Only for the empty state's hint, and it is a GLOBAL list — keyed on `api` alone so
  // switching type tabs doesn't refetch it.
  useEffect(() => {
    api.listBlockTypes().then(setBlockTypes).catch((e) => onError(errMsg(e)));
  }, [api, onError]);

  // "pages", not "entries": these are pages of a content type, and a single-type deployment
  // must read exactly as it did before types had tabs. `type.name` is a label a host writes
  // (often plural, it labels the tab), so it heads the screen and is never bent into a noun
  // phrase — "+ New Articles" is what guessing at grammar produces.
  const count = pages.length === 0 ? "None yet" : pages.length === 1 ? "1 page total" : `${pages.length}${hasMore ? "+" : ""} pages total`;
  return (
    <>
      <Hero lead={type?.name ?? "Pages"} em={loading && pages.length === 0 ? "Loading…" : count}>
        <Button className="shrink-0" onPress={() => setCreating(true)}>+ New page</Button>
      </Hero>
      <div className={WRAP}>
        <div className="flex flex-col gap-2">
          {pages.map((p) => (
            <div className={`${ROW} cursor-pointer hover:bg-surface-muted`} key={p.id} onClick={() => onOpen(p)}>
              <span className="flex-1 truncate font-medium">{p.title}</span>
              <span className="text-fg-subtle">/{p.slug}</span>
              {multilingual ? <span className="text-fg-subtle">{p.locale}</span> : null}
              <Pill status={p.status}>{p.status}</Pill>
            </div>
          ))}
          {!loading && pages.length === 0 ? <p className="text-fg-subtle">No pages yet. {blockTypes.length === 0 ? "Define block types + a content type first (via the API/admin)." : "Create one."}</p> : null}
        </div>
        {hasMore ? (
          <div className="mt-4 flex justify-center">
            <Button variant="ghost" onPress={() => void load(offset)} isDisabled={loading}>{loading ? "Loading…" : "Load more"}</Button>
          </div>
        ) : null}
      </div>
      {creating ? <CreatePage api={api} type={type} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(0); }} onError={onError} /> : null}
    </>
  );
}

function CreatePage({ api, type, onClose, onCreated, onError }: { api: Api; type?: ContentType; onClose: () => void; onCreated: () => void; onError: (s: string) => void }) {
  // The app context already holds this list — a second fetch per modal open is a second
  // cache of one list in one tree, with its own error policy.
  const { contentTypes } = useApp();
  const cts = contentTypes ?? [];
  const [typeId, setTypeId] = useState(type?.id ?? "");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  // Re-sync, not seed-once. On a type-scoped list the type is decided by the screen you are
  // on — and that screen can change UNDER an open modal: history navigation isn't blocked by
  // the overlay the way a topbar click is, and buzola keeps this component instance across
  // it. Seeded once, the modal kept filing the new screen's page under the old screen's type,
  // with the picker hidden so nothing on screen said so and `createPage` trusting the id.
  useEffect(() => {
    if (type) { setTypeId(type.id); return; }
    const list = contentTypes ?? [];
    setTypeId((cur) => (cur && list.some((c) => c.id === cur) ? cur : list[0]?.id ?? ""));
  }, [type, contentTypes]);
  const create = async () => {
    try {
      await api.call("createPage", { typeId, title, slug: slug || slugify(title) });
      onCreated();
    } catch (e) {
      onError(errMsg(e));
    }
  };
  return (
    // `full`: creating a page is the one thing this screen exists to start, and the header's
    // action should open a room rather than a panel. The form is centred and capped inside it
    // — a canvas is what the takeover is for, not a reason to stretch two inputs across it.
    //
    // Name the type when the picker is hidden. Otherwise the whole modal says "page" and
    // nothing on it says WHICH type the page is being filed under — on a per-type list that is
    // the one fact the screen is supposed to be carrying.
    <Modal
      onClose={onClose}
      size="full"
      title={
        <>
          Create a <Dim>new page</Dim>
          {type ? <> in <Dim>{type.name}</Dim></> : null} and define the essentials<Dim>.</Dim>
        </>
      }
    >
      {/* `m-auto`, not `mx-auto`: `size="full"` makes the dialog body a flex column, so auto
          margins on both axes centre the form IN the canvas. Pinned to the top it read as a
          small form that had lost its modal. */}
      <div className="m-auto flex w-full max-w-[560px] flex-col gap-4">
        <div className={`w-full flex-col gap-2 ${type ? "hidden" : "flex"}`}>
          <span className="text-sm font-medium text-fg">Content type</span>
          {/* Visible cards, not a dropdown: the type is an easy-to-miss choice, and picking the
              wrong one puts the entry under a different route. Cards make the selection deliberate. */}
          <div className="flex flex-wrap gap-2">
            {cts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setTypeId(c.id)}
                className={`rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                  typeId === c.id
                    ? "border-brand-green bg-surface-muted text-fg"
                    : "border-border bg-surface-card text-fg-muted hover:border-fg-subtle hover:text-fg"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
        <Input label="Title" value={title} onChange={setTitle} />
        <Input label="Slug" value={slug} onChange={setSlug} placeholder={slugify(title)} />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onPress={onClose}>cancel</Button>
          <Button onPress={create} isDisabled={!typeId || !title}>Create</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- collections -------------------------------------------------------------
//
// Generic list + edit views over a host-app entity registered as a collection. Both are
// driven entirely by the CollectionMeta fetched from `listCollections` — one editor, N
// collections, zero per-collection code. Rows are addressed by `def.idField` (the entity's
// PK column, defaults "id"); the server resolves the real PK from the value.

/** Render a list-cell value as a short string (objects/arrays are summarized, not dumped).
 * A `richtext` column is a document tree, so flatten it to words rather than showing "—". */
function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length === 1 ? "1 item" : `${v.length} items`;
  if (isRichTextDoc(v)) {
    const text = richTextToPlainText(v).replace(/\s+/g, " ").trim();
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  }
  if (typeof v === "object") return "—";
  return String(v);
}

/** Page size for collection lists. collectionList defaults to 100 server-side, so a
 * request without an explicit limit silently truncates — and the header then reports the
 * truncated count as if it were the total, which reads as "that is all there is". */
const COLLECTION_PAGE_SIZE = 50;

export function CollectionList({ api, def, onOpen, onNew, onError }: { api: Api; def: CollectionMeta; onOpen: (id: string) => void; onNew: () => void; onError: (s: string) => void }) {
  const [rows, setRows] = useState<FieldValues[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (off: number) => {
      setLoading(true);
      return api
        .call<FieldValues[]>("collectionList", { collection: def.slug, limit: COLLECTION_PAGE_SIZE, offset: off })
        .then((r) => {
          setRows((prev) => (off === 0 ? r : [...prev, ...r]));
          // A full page means there is probably more; a short one is definitely the end.
          setHasMore(r.length === COLLECTION_PAGE_SIZE);
          setOffset(off + r.length);
        })
        .catch((e) => onError(errMsg(e)))
        .finally(() => setLoading(false));
    },
    [api, def.slug, onError],
  );

  useEffect(() => {
    setRows([]);
    setOffset(0);
    setHasMore(false);
    void load(0);
  }, [load]);

  const labelOf = (col: string) => def.fields.find((f) => f.name === col)?.label ?? col;
  return (
    <>
      <Hero lead={def.pluralLabel} em={rows.length === 0 ? "None yet" : rows.length === 1 ? `1 ${def.label.toLowerCase()}` : `${rows.length}${hasMore ? "+" : ""} ${def.pluralLabel.toLowerCase()}`}>
        <Button className="shrink-0" onPress={onNew}>+ New {def.label.toLowerCase()}</Button>
      </Hero>
      <div className={WRAP}>
        <div className="flex flex-col gap-2">
          {rows.map((row) => {
            const id = String(row[def.idField] ?? "");
            const [first, ...rest] = def.list;
            return (
              <div className={`${ROW} cursor-pointer hover:bg-surface-muted`} key={id} onClick={() => onOpen(id)}>
                <span className="flex-1 truncate font-medium">{cellText(row[first ?? def.titleField]) || <Dim>untitled</Dim>}</span>
                {rest.map((col) => (
                  <span className="truncate text-fg-subtle" key={col} title={labelOf(col)}>{cellText(row[col])}</span>
                ))}
              </div>
            );
          })}
          {!loading && rows.length === 0 ? <p className="text-fg-subtle">No {def.pluralLabel.toLowerCase()} yet. Create one.</p> : null}
          {loading ? <p className="text-fg-subtle">Loading…</p> : null}
        </div>
        {hasMore && !loading ? (
          <div className="mt-3.5 text-center">
            <Button variant="secondary" size="sm" onPress={() => void load(offset)}>Load more</Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The workflow surface for a collection row — the UI half of the server's `supports`.
 *
 * Without this the feature is unreachable from the editor: `collectionCreate` always seeds
 * `status: "draft"` and `collectionUpdate` strips `status` from the values bag (it is a
 * MANAGED column, deliberately not in the write whitelist), so a row authored here could
 * never be made public. Publishing has to be its own gated call, and this is where it is
 * made. Every control is driven by `def.supports`, so a plain CRUD collection renders
 * nothing at all.
 *
 * The row's managed columns come back on `collectionGet`/the write echoes, so the panel
 * reads its state from the same `values` bag the form holds. */
function CollectionWorkflow({
  api,
  def,
  id,
  values,
  onChanged,
  onError,
}: {
  api: Api;
  def: CollectionMeta;
  id: string;
  values: FieldValues;
  onChanged: (row: FieldValues) => void;
  onError: (s: string) => void;
}) {
  const supports = def.supports ?? [];
  const [busy, setBusy] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [publishAt, setPublishAt] = useState("");
  const [takedownAt, setTakedownAt] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Array<{ id: string; revision: number; note: string | null; actor: string | null; createdAt: string }> | null>(null);

  const status = typeof values.status === "string" ? values.status : "draft";
  const published = status === "published";
  const str = (k: string) => (typeof values[k] === "string" && values[k] !== "" ? (values[k] as string) : null);
  const scheduledAt = str("scheduledAt");
  const unpublishAt = str("unpublishAt");
  const publishedAt = str("publishedAt");

  if (supports.length === 0) return null;

  const act = async (name: string, input: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const row = await api.call<FieldValues>(name, { collection: def.slug, id, ...input });
      // The publish/unpublish handlers echo the persisted row; `collectionSchedule` returns
      // `{ ok, scheduledAt, … }`, so re-read rather than merging a non-row shape in.
      if (row && typeof row === "object" && def.idField in row) onChanged(row);
      else {
        const fresh = await api.call<FieldValues | null>("collectionGet", { collection: def.slug, id });
        if (fresh) onChanged(fresh);
      }
      return true;
    } catch (e) {
      onError(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    const at = publishAt ? fromLocalInput(publishAt) : null;
    if (!at) return onError("Pick a publication date and time first.");
    const down = takedownAt ? fromLocalInput(takedownAt) : null;
    if (takedownAt && !down) return onError("That takedown date is not a valid date and time.");
    // `unpublishAt` is PATCH semantics server-side: omitted leaves an existing takedown
    // standing, `null` cancels it. Send it explicitly whenever the scheduler is open, so
    // what the editor sees in the two inputs is exactly what is stored.
    const ok = await act("collectionSchedule", { publishAt: Date.parse(at), unpublishAt: down ? Date.parse(down) : null });
    if (ok) setScheduling(false);
  };

  const openScheduler = () => {
    setPublishAt(toLocalInput(scheduledAt ?? publishedAt ?? new Date().toISOString()));
    setTakedownAt(unpublishAt ? toLocalInput(unpublishAt) : "");
    setScheduling((v) => !v);
  };

  const mintPreview = async () => {
    setBusy(true);
    try {
      const r = await api.call<{ url: string }>("signCollectionPreview", { collection: def.slug, id });
      const url = api.resolve(r.url);
      setPreview(url);
      // Best-effort: the clipboard needs a secure context and a permission, and the link is
      // rendered either way.
      await navigator.clipboard?.writeText(url).catch(() => {});
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const loadRevisions = async () => {
    if (revisions) return setRevisions(null); // toggle closed
    try {
      setRevisions(await api.call<NonNullable<typeof revisions>>("collectionListRevisions", { collection: def.slug, id }));
    } catch (e) {
      onError(errMsg(e));
    }
  };

  const restore = async (revisionId: string) => {
    if (!confirm("Restore this version? The current content is snapshotted first, so this is itself undoable.")) return;
    if (await act("collectionRestoreRevision", { revisionId })) setRevisions(null);
  };

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface-card px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-subtle">Status</span>
        <Pill status={status}>{status}</Pill>
        {publishedAt && published ? <span className="text-fg-subtle">since {formatWhen(publishedAt)}</span> : null}
        {scheduledAt ? <span className="text-accent-strong">publishes {formatWhen(scheduledAt)}</span> : null}
        {unpublishAt ? <span className="text-danger">comes down {formatWhen(unpublishAt)}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {supports.includes("drafts") && !published ? (
          <Button size="sm" isDisabled={busy} onPress={() => void act("collectionPublish")}>Publish now</Button>
        ) : null}
        {supports.includes("drafts") && published ? (
          <Button variant="secondary" size="sm" isDisabled={busy} onPress={() => void act("collectionUnpublish")}>Unpublish</Button>
        ) : null}
        {supports.includes("scheduling") ? (
          <Button variant="secondary" size="sm" isDisabled={busy} onPress={openScheduler}>{scheduledAt ? "Change schedule" : "Schedule…"}</Button>
        ) : null}
        {supports.includes("preview") ? (
          <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void mintPreview()}>Preview link</Button>
        ) : null}
        {supports.includes("revisions") ? (
          <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void loadRevisions()}>{revisions ? "Hide history" : "History"}</Button>
        ) : null}
      </div>
      {scheduling ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-fg">Publish at</span>
            <input className={CONTROL} type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-fg">Take down at (optional)</span>
            <input className={CONTROL} type="datetime-local" value={takedownAt} onChange={(e) => setTakedownAt(e.target.value)} />
          </label>
          <p className="text-fg-subtle">
            Scheduling does not take a live row down — it publishes at the first instant. A takedown must be after the publication time. Leave it empty to
            cancel one.
          </p>
          <div className="flex gap-2">
            <Button size="sm" isDisabled={busy} onPress={() => void saveSchedule()}>Save schedule</Button>
            <Button variant="ghost" size="sm" onPress={() => setScheduling(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {preview ? (
        <div className="border-t border-border pt-3 text-sm">
          <span className="text-fg-subtle">Preview link (copied): </span>
          <a className="break-all underline" href={preview} target="_blank" rel="noreferrer">{preview}</a>
        </div>
      ) : null}
      {revisions ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {revisions.map((r) => (
            <div className={`${ROW} text-xs`} key={r.id}>
              <span className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg-muted">#{r.revision}</span>
              <span className="flex-1 truncate text-fg-subtle">{r.note ?? "edit"} · {r.actor ?? "system"} · {formatWhen(r.createdAt)}</span>
              <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => void restore(r.id)}>Restore</Button>
            </div>
          ))}
          {revisions.length === 0 ? <p className="text-fg-subtle">No history yet.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function CollectionEditor({ api, def, id, onSaved, onDeleted, onBack, onError }: { api: Api; def: CollectionMeta; id: string | null; onSaved: () => void; onDeleted: () => void; onBack: () => void; onError: (s: string) => void }) {
  const isNew = id === null;
  const [values, setValues] = useState<FieldValues>({});
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  // The app bar's trailing crumb. A new row is named before it exists, from the collection's
  // own singular label; an existing one takes its title field, and `undefined` while that is
  // still loading leaves the bar showing the section rather than a "Loading…" that then
  // changes under the reader's eye.
  // Through `cellText`, the same function the LIST renders this very column with — so the
  // crumb and the row a reader clicked to get here say the same thing, rather than two
  // renderings of one `FieldValue` that can disagree about a rich-text or array cell.
  const title = cellText(values[def.titleField]);
  useCrumb(isNew ? `New ${def.label.toLowerCase()}` : title || undefined);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (isNew) { setValues({}); return; }
    let live = true;
    setLoading(true);
    setMissing(false);
    api.call<FieldValues | null>("collectionGet", { collection: def.slug, id })
      .then((row) => { if (!live) return; if (row) setValues(row); else setMissing(true); })
      .catch((e) => onError(errMsg(e)))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, def.slug, id, isNew, onError]);

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        // Creating: a new record has no route yet — return to the list so the caller lands
        // somewhere stable (the new row is now in it).
        await api.call("collectionCreate", { collection: def.slug, values });
        onSaved();
      } else {
        // Editing: stay on the form. Reflect the persisted row the update echoes back (server
        // defaults / normalization applied) and flash a confirmation instead of navigating.
        const updated = await api.call<FieldValues>("collectionUpdate", { collection: def.slug, id, values });
        if (updated) setValues(updated);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (isNew || !confirm(`Delete this ${def.label.toLowerCase()}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.call("collectionDelete", { collection: def.slug, id });
      onDeleted();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={WRAP}>
      <div className="mb-4 mt-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={onBack}>← {def.pluralLabel}</Button>
        <h1 className="text-[22px] font-normal text-fg">{isNew ? `New ${def.label.toLowerCase()}` : `Edit ${def.label.toLowerCase()}`}</h1>
      </div>
      {missing ? (
        <p className="text-fg-subtle">Not found.</p>
      ) : loading ? (
        <p className="text-fg-subtle">Loading…</p>
      ) : (
        <div className="flex max-w-[720px] flex-col gap-4">
          {ok ? <Banner ok>saved</Banner> : null}
          {/* Publishing is a separate, separately-gated call — `status` is a managed column
              the ordinary save cannot touch — so the workflow controls live outside the
              form. Only on an existing row: there is nothing to publish until it exists. */}
          {!isNew && id ? (
            <CollectionWorkflow api={api} def={def} id={id} values={values} onChanged={setValues} onError={onError} />
          ) : null}
          <FieldForm schema={def.fields} value={values} onChange={setValues} api={api} />
          <div className="mt-2 flex items-center gap-2">
            <Button onPress={save} isDisabled={busy}>{busy ? "Saving…" : isNew ? "Create" : "Save"}</Button>
            {!isNew ? <Button variant="ghost" className="text-danger" onPress={del} isDisabled={busy}>Delete</Button> : null}
          </div>
        </div>
      )}
    </div>
  );
}

// --- page editor -------------------------------------------------------------

/**
 * The page editor's toolbar: where you are, what state the page is in, and the three things
 * you came to do.
 *
 * It exists because none of that was anywhere. The editor opened onto three columns of panels
 * with no header; the status appeared twice (a rail card and an inspector row) and the actions
 * that change it were behind a tab labelled "workflow", rendered as a lowercase ghost button
 * among five that read as filter chips. Publishing — the point of the screen — required
 * knowing that word.
 *
 * Sticky, because a long page scrolls away from it and the save state has to stay visible.
 */
function PageToolbar({ page, dirtyCount, onBack, backLabel, onAct, busy }: {
  page: Page;
  dirtyCount: number;
  onBack: () => void;
  /** The list this page belongs to — "Pages", or the content type's own name on a
   * per-type deployment, where back goes to that type's list and not the pooled one. */
  backLabel: string;
  onAct: (action: string) => void;
  busy: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const { api } = useApp();
  const actions = pageWorkflowActions(String(page.status));
  const [primary, ...rest] = actions;

  const mintPreview = async () => {
    setMinting(true);
    try {
      const minted = await api.signPagePreview(page.id);
      const href = pagePreviewHref(minted, { siteUrl: sitePreviewUrl(), resolve: (path) => api.resolve(path) });
      setPreview(href);
      // Best-effort: the clipboard needs a secure context and a permission, and the link is
      // rendered either way.
      await navigator.clipboard?.writeText(href).catch(() => {});
    } catch {
      setPreview(null);
    } finally {
      setMinting(false);
    }
  };

  return (
    <>
    <div className={`sticky ${BELOW_APP_BAR} z-20 -mx-7 flex ${PAGE_TOOLBAR_H} items-center gap-3 border-b border-border bg-surface px-7`}>
      <Button variant="ghost" size="sm" className="shrink-0" onPress={onBack}>← {backLabel}</Button>
      <span className="min-w-0 truncate font-medium text-fg">{page.title}</span>
      {/* Beside the title, because it is a fact ABOUT the page — among the buttons it read as
          another control. */}
      <Pill status={page.status}>{page.status}</Pill>
      <span className="flex-1" />
      {/* ONE line of truth about saving. Page fields and blocks autosave; this says so, and
          says when they have not finished — replacing two identically-labelled "Save" buttons
          that saved different halves of the screen and a third surface that saved silently. */}
      <span className="shrink-0 text-caption text-fg-subtle">
        {dirtyCount > 0 ? <span className="text-accent-strong">● saving {dirtyCount} change{dirtyCount === 1 ? "" : "s"}…</span> : "all changes saved"}
      </span>
      <Button variant="secondary" size="sm" className="shrink-0" isDisabled={minting} onPress={() => void mintPreview()}>
        {minting ? "Minting…" : "Preview"}
      </Button>
      {primary ? <Button size="sm" className="shrink-0" isDisabled={busy} onPress={() => onAct(primary.action)}>{primary.label}</Button> : null}
      {rest.length > 0 ? (
        <DropdownMenuTrigger>
          <Button variant="ghost" size="sm" className="shrink-0 px-2" aria-label="More actions">⋯</Button>
          <DropdownMenu aria-label="More page actions" onAction={(k) => onAct(String(k))}>
            {rest.map((a) => <DropdownMenuItem key={a.action} id={a.action}>{a.label}</DropdownMenuItem>)}
          </DropdownMenu>
        </DropdownMenuTrigger>
      ) : null}
    </div>
    {/* The minted link is REVEALED rather than opened: the point of a preview link is to
        SEND it, and a popup blocker eating the click that produced it would leave nothing to
        copy. In flow rather than floating under the sticky bar, where it covered the first
        thing on the canvas with no way to move it — and dismissible, because it is a
        transient answer, not a permanent row. */}
    {preview ? (
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-caption">
        <span className="shrink-0 text-fg-subtle">Preview link (copied):</span>
        <a className="min-w-0 flex-1 truncate underline" href={preview} target="_blank" rel="noreferrer">{preview}</a>
        <Button variant="ghost" size="sm" className="shrink-0 px-2" aria-label="Hide the preview link" onPress={() => setPreview(null)}>✕</Button>
      </div>
    ) : null}
    </>
  );
}

export function PageEditor({ api, page, blockTypes, tab, onTab, onBack, backLabel, onChange, registerGuard }: { api: Api; page: Page; blockTypes: BlockType[]; tab: InspectorTab; onTab: (t: InspectorTab) => void; onBack: () => void; backLabel: string; onChange: (p: Page) => void; registerGuard: (fn: (() => boolean) | null) => void }) {
  const { cms: { multilingual, siteFurniture, canEdit } } = useApp();
  // NO detail crumb, deliberately. The toolbar below names the page and carries its status,
  // so publishing one put the title in the app bar 40px above where the toolbar already says
  // it — the "title in three places" this redesign removed. The section crumb stays; it names
  // the list you came from, which the toolbar's back button only points at.
  const [ct, setCt] = useState<ContentType | null>(null);
  const [assembled, setAssembled] = useState<AssembledPage | null>(null);
  const [err, setErr] = useState("");

  // Unsaved-changes guard. Every editable surface on the canvas — each BlockCard, plus the
  // page's own PageFields form (keyed "page") — reports its dirty state up; while anything
  // is dirty, warn before leaving. PageFields must participate: for a content type with no
  // regions it is the ENTIRE editor, sitting right under the back button. Reorder/add/remove
  // keep local state — React reuses instances by key — so those don't lose edits and need no
  // guard; only unmounting the editor or a page unload discards them.
  //
  // Three exits, three mechanisms, one predicate (`confirmLeave`): the ← all pages buttons
  // ask directly, `beforeunload` covers refresh/close/off-site, and `registerGuard` publishes
  // it to the root layout so the topbar (wordmark, tabs, sign out) asks too — an in-app
  // navigation fires no `beforeunload`, so without that it would discard edits silently.
  const dirtyRef = useRef<Set<string>>(new Set());
  const [dirtyCount, setDirtyCount] = useState(0);
  const reportDirty = useCallback((id: string, isDirty: boolean) => {
    const s = dirtyRef.current;
    if (isDirty ? s.has(id) : !s.has(id)) return;
    if (isDirty) s.add(id);
    else s.delete(id);
    setDirtyCount(s.size);
  }, []);
  // Stable (reads `dirtyRef`, never state), so the layout can hold it for the editor's
  // whole lifetime. Synchronous by design — a caller decides whether to navigate on the
  // return value, which a modal dialog could not answer in time.
  const confirmLeave = useCallback(
    () => dirtyRef.current.size === 0 || window.confirm(`You have ${dirtyRef.current.size} unsaved change${dirtyRef.current.size === 1 ? "" : "s"}. Leave without saving?`),
    [],
  );
  useEffect(() => {
    registerGuard(confirmLeave);
    return () => registerGuard(null);
  }, [registerGuard, confirmLeave]);

  const btBySlug = useMemo(() => new Map(blockTypes.map((b) => [b.slug, b])), [blockTypes]);

  const reload = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.getContentType(page.typeId), api.getPagePreview(page.slug, page.locale)]);
      setCt(c ?? null);
      setAssembled(a);
    } catch (e) {
      setErr(errMsg(e));
    }
  }, [api, page.typeId, page.slug, page.locale]);
  useEffect(() => { reload(); }, [reload]);

  // Native prompt on refresh/close/off-site nav while there are unsaved edits.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const regions: RegionDefinition[] = ct?.regions ?? [];
  /** The content type's PAGE-level fields — rendered on the canvas, not in the inspector. */
  const pageSchema: FieldDefinition[] = ct?.fieldsSchema ?? [];

  const patchRegion = (region: string, fn: (list: RenderedBlock[]) => RenderedBlock[]) =>
    setAssembled((prev) => (prev ? { ...prev, regions: { ...prev.regions, [region]: fn(prev.regions[region] ?? []) } } : prev));

  // Add a block, optionally AT an index (`at`) rather than appended — the Notion-style
  // insert-between. addBlock always appends server-side, so when `at` lands mid-list we
  // follow up with a reorderRegion to move the new placement into place.
  const addBlock = async (region: string, slug: string, at?: number) => {
    // Optimistic: show a placeholder immediately (no wait for the round trip), then
    // reconcile with the persisted row addBlock echoes — or roll it back on failure.
    const tempId = `tmp:${crypto.randomUUID()}`;
    const existingIds = (assembled?.regions[region] ?? []).map((b) => b.id);
    const index = at != null && at >= 0 && at < existingIds.length ? at : existingIds.length;
    patchRegion(region, (list) => {
      const next = [...list];
      next.splice(index, 0, { id: tempId, block_id: tempId, block_type: slug, title: null, fields: {}, is_shared: false, pending: true });
      return next;
    });
    try {
      const { block, placement } = await api.call<{
        block: { id: string; title?: string | null; fields?: FieldValues | null };
        placement: { id: string; isShared?: boolean | number };
      }>("addBlock", { pageId: page.id, blockTypeSlug: slug, region, fields: {} });
      const rb: RenderedBlock = {
        id: String(placement.id),
        block_id: String(block.id),
        block_type: slug,
        title: block.title ?? null,
        fields: block.fields ?? {},
        is_shared: Boolean(placement.isShared),
      };
      patchRegion(region, (list) => list.map((b) => (b.id === tempId ? rb : b)));
      // Inserted mid-list: the server appended, so persist the intended order (this
      // reloads, like a drag-reorder does).
      if (index < existingIds.length) {
        const order = [...existingIds];
        order.splice(index, 0, rb.id);
        await reorder(region, order);
      }
    } catch (e) {
      patchRegion(region, (list) => list.filter((b) => b.id !== tempId));
      setErr(errMsg(e));
    }
  };
  const removeBlock = async (b: RenderedBlock) => {
    try {
      await api.call("removeBlock", { pageBlockId: b.id });
      await reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const reorder = async (region: string, order: string[]) => {
    try {
      await api.call("reorderRegion", { pageId: page.id, region, order });
      await reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  // Patch a block's raw fields into local state after an inline save — keeps the collapsed
  // preview fresh without a full reload (which would remount every editor + lose caret/focus).
  const patchBlockFields = useCallback((placementId: string, fields: FieldValues) => {
    setAssembled((prev) => {
      if (!prev) return prev;
      const next: Record<string, RenderedBlock[]> = {};
      for (const [name, list] of Object.entries(prev.regions)) next[name] = list.map((b) => (b.id === placementId ? { ...b, fields } : b));
      return { ...prev, regions: next };
    });
  }, []);

  // Drag-to-reorder within a region. `from`/`over` are indices in the region's block list;
  // hovering updates `over` live (for the drop-target highlight), and the drop commits the
  // new order via reorderRegion. Dragging is confined to the region it started in.
  const [drag, setDrag] = useState<{ region: string; from: number; over: number } | null>(null);
  const beginDrag = (region: string, i: number) => setDrag({ region, from: i, over: i });
  const hoverDrag = (region: string, i: number) => setDrag((d) => (d && d.region === region && d.over !== i ? { ...d, over: i } : d));
  const cancelDrag = () => setDrag(null);
  const dropDrag = (region: string) => {
    setDrag(null);
    if (!drag || drag.region !== region || drag.from === drag.over) return;
    const ids = (assembled?.regions[region] ?? []).map((b) => b.id);
    const [moved] = ids.splice(drag.from, 1);
    ids.splice(drag.over, 0, moved);
    reorder(region, ids);
  };

  const [acting, setActing] = useState(false);
  /** Run a workflow transition from the toolbar. */
  const act = async (name: string) => {
    setActing(true);
    try {
      const r = await api.call<{ page?: Page }>(name, { pageId: page.id });
      if (r?.page) onChange(r.page);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setActing(false);
    }
  };


  return (
    <div className="px-7 pb-16">
      <PageToolbar page={page} dirtyCount={dirtyCount} busy={acting} onAct={act} backLabel={backLabel} onBack={() => { if (confirmLeave()) onBack(); }} />
      {err ? <Banner>{err}</Banner> : null}

      {/* Two columns, always. There was a third — an outline listing each region and its block
          count — and it was a table of contents for a document that is almost never longer
          than the screen: the canvas already prints the same region names, in the same order,
          a column away, and the count it added is what "is this region empty" looks like when
          you look at it. Its one real service, jumping to a far region, is scrolling on a page
          you are already scrolling. The region headings below are sticky instead, which is the
          orientation an outline was standing in for. */}
      <div className="mt-4 grid items-start gap-6 grid-cols-[minmax(0,1fr)_340px] max-[980px]:grid-cols-1">

      {/* The canvas: one inline document. `pl-8` reserves the left gutter that each
          block's drag handle occupies on hover. Regions are titled sections. */}
      <div className="min-w-0 py-1.5 pl-8 pr-2">
        {/* The page's own fields are CONTENT, so they belong on the canvas at full width —
            not in the inspector. For a content type with no regions (a fixed layout, all
            of it page fields) this is the entire editor; the canvas is never empty. */}
        {pageSchema.length ? (
          <PageFields api={api} page={page} schema={pageSchema} initialFields={(assembled?.page.fields as FieldValues) ?? {}} onDirtyChange={reportDirty} onError={setErr} />
        ) : null}
        {regions.map((r) => {
          const blocks = assembled?.regions[r.name] ?? [];
          const allowed = r.allowedTypes && r.allowedTypes.length ? r.allowedTypes : blockTypes.map((b) => b.slug);
          return (
            <div className="mb-10" key={r.name}>
              {/* Sticky, under the app bar + toolbar: on a long page the heading is the only
                  thing that says which slot of the layout you are editing, and scrolling used
                  to take it away. `bg-surface` because it now passes over content. */}
              <div className={`sticky ${BELOW_PAGE_TOOLBAR} z-10 -mx-2 mb-1 bg-surface px-2 py-1 text-caption font-medium uppercase tracking-wide text-fg-subtle`}>{r.label ?? r.name}</div>
              {blocks.map((b, i) => (
                <div key={b.id}>
                  {/* Between-blocks insert point — a hover "+" that adds AT index i. */}
                  <Inserter compact allowed={allowed} btBySlug={btBySlug} onAdd={(slug) => addBlock(r.name, slug, i)} />
                  <BlockCard
                    api={api}
                    block={b}
                    blockType={btBySlug.get(b.block_type)}
                    isFirst={i === 0}
                    isLast={i === blocks.length - 1}
                    onMove={(d) => reorderMove(blocks, r.name, i, d, reorder)}
                    onRemove={() => removeBlock(b)}
                    onPatch={patchBlockFields}
                    onDirtyChange={reportDirty}
                    onError={setErr}
                    dragging={drag?.region === r.name && drag.from === i}
                    isOver={!!drag && drag.region === r.name && drag.over === i && drag.from !== i}
                    onDragStartBlock={() => beginDrag(r.name, i)}
                    onDragOverBlock={() => hoverDrag(r.name, i)}
                    onDropBlock={() => dropDrag(r.name)}
                    onDragEndBlock={cancelDrag}
                  />
                </div>
              ))}
              {/* End inserter — appends. */}
              <div className="mt-1">
                <Inserter allowed={allowed} btBySlug={btBySlug} onAdd={(slug) => addBlock(r.name, slug)} />
              </div>
            </div>
          );
        })}
        {regions.length === 0 && pageSchema.length === 0
          ? <p className="text-fg-subtle">This page's content type defines no fields or regions.</p>
          : null}
      </div>

      <aside className={`sticky ${BELOW_PAGE_TOOLBAR} max-h-[calc(100vh-8rem)] overflow-auto rounded-panel border border-border bg-surface-card p-5`}>
        {/* A real tab strip, not five ghost buttons that read as filter chips: the selected
            one is underlined and Capitalised, so which panel you are in is visible without
            comparing background tints. */}
        <div className="-mt-1 mb-4 flex gap-1 border-b border-border">
          {visibleTabs(multilingual, siteFurniture).map((t) => (
            <button
              key={t}
              type="button"
              className={`-mb-px border-b-2 px-2 pb-2 pt-1 text-sm ${tab === t ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
              onClick={() => onTab(t)}
            >
              {INSPECTOR_TAB_LABELS[t]}
            </button>
          ))}
        </div>
        {tab === "settings" ? <PageMeta api={api} page={page} onSaved={onChange} onError={setErr} /> : null}
        {tab === "seo" ? <SeoPanel api={api} page={page} onError={setErr} /> : null}
        {tab === "i18n" && multilingual ? <I18n api={api} page={page} onError={setErr} /> : null}
        {tab === "terms" ? <PageTerms api={api} pageId={page.id} canEdit={canEdit} onError={setErr} /> : null}
        {tab === "audit" ? <AuditLog api={api} pageId={page.id} onError={setErr} /> : null}
      </aside>
      </div>
    </div>
  );
}


// A single block, edited inline: the block IS its editor. Fields render in place (rich text
// as the WYSIWYG, media as a thumbnail picker). Edits are held locally and committed only on
// an explicit Save — the header + footer show an "unsaved" state until you do, and nothing is
// written until you click Save. Collapse folds it to a one-line plain-text preview.
function BlockCard({ api, block, blockType, isFirst, isLast, onMove, onRemove, onPatch, onDirtyChange, onError, dragging, isOver, onDragStartBlock, onDragOverBlock, onDropBlock, onDragEndBlock }: {
  api: Api;
  block: RenderedBlock;
  blockType: BlockType | undefined;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: number) => void;
  onRemove: () => void;
  onPatch: (placementId: string, fields: FieldValues) => void;
  onDirtyChange: (placementId: string, dirty: boolean) => void;
  onError: (s: string) => void;
  dragging: boolean;
  isOver: boolean;
  onDragStartBlock: () => void;
  onDragOverBlock: () => void;
  onDropBlock: () => void;
  onDragEndBlock: () => void;
}) {
  const [fields, setFields] = useState<FieldValues | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const saved = useRef<string>(""); // JSON of the last-persisted fields — the dirty baseline
  const cardRef = useRef<HTMLDivElement>(null);
  const blockId = block.block_id;
  const placementId = block.id;

  // Load RAW fields (media as ids, richtext as a document tree) so the value round-trips on save.
  // A pending optimistic block has no persisted row yet — start empty and skip the fetch
  // (its temp id would 404); when it reconciles to real ids the card remounts and fetches.
  useEffect(() => {
    if (block.pending) { setFields({}); saved.current = "{}"; return; }
    let alive = true;
    api.call<{ fields?: FieldValues }>("getBlock", { blockId }).then((b) => {
      if (!alive) return;
      const f = b?.fields ?? {};
      setFields(f);
      saved.current = JSON.stringify(f);
    }).catch((e) => onError(errMsg(e)));
    return () => { alive = false; };
  }, [api, blockId, onError, block.pending]);

  const dirty = fields != null && JSON.stringify(fields) !== saved.current;

  // Writes the block. Fired by the debounced autosave below AND by the manual "Save
  // now" button (which also serves as the retry path if an autosave fails). Idempotent:
  // no-ops when nothing changed since the last persist.
  const save = useCallback(async () => {
    if (block.pending || fields == null) return;
    const snapshot = JSON.stringify(fields);
    if (snapshot === saved.current) return;
    setSaveState("saving");
    try {
      await api.call("updateBlock", { blockId, fields });
      saved.current = snapshot;
      onPatch(placementId, fields);
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch (e) {
      onError(errMsg(e));
      setSaveState("idle");
    }
  }, [api, blockId, placementId, fields, onPatch, onError, block.pending]);

  // Debounced autosave — persist ~800ms after the last edit (Notion-style). Keyed on
  // `fields`, so it fires only on an actual edit: a failed save leaves `fields`
  // unchanged and does NOT auto-retry (no hot loop) — the next edit, or the manual
  // Save button, retries. The editor's unsaved guard still covers the debounce window
  // if you navigate away mid-edit.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (fields == null || block.pending) return;
    if (JSON.stringify(fields) === saved.current) return; // not dirty
    const t = setTimeout(() => void saveRef.current(), 800);
    return () => clearTimeout(t);
  }, [fields, block.pending]);

  const change = (next: FieldValues) => setFields(next);

  // Report dirty state up (for the editor's leave/unload guard); clear it on unmount so a
  // removed block never leaves a stale "unsaved" flag behind.
  useEffect(() => { onDirtyChange(placementId, dirty); }, [dirty, placementId, onDirtyChange]);
  useEffect(() => () => { onDirtyChange(placementId, false); }, [placementId, onDirtyChange]);

  const schema: FieldDefinition[] = blockType?.fieldsSchema ?? [];
  const name = blockType?.name ?? block.block_type;

  return (
    // One inline document row (no card chrome). The row is the drop target; the ⠿
    // handle in the hover gutter is the only draggable element, so dragging never
    // fights the inline text selection. Its drag image is the whole row.
    <div
      ref={cardRef}
      className={`group relative rounded-lg px-2 py-1 transition-colors ${isOver ? "ring-2 ring-brand-green" : ""} ${dragging ? "opacity-40" : ""} ${block.pending ? "pointer-events-none opacity-60" : ""}`}
      onDragOver={(e) => { e.preventDefault(); onDragOverBlock(); }}
      onDrop={(e) => { e.preventDefault(); onDropBlock(); }}
    >
      {/* Left gutter — drag handle, revealed on hover, sitting in the canvas's pl-8. */}
      <span
        draggable
        onDragStart={(e) => {
          if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 12, 12);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", "");
          onDragStartBlock();
        }}
        onDragEnd={onDragEndBlock}
        className="absolute -left-6 top-1.5 cursor-grab select-none px-1 text-fg-subtle opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 active:cursor-grabbing"
        title="Drag to reorder"
      >⠿</span>

      {/* Header — subtle type label + state + actions, mostly revealed on hover. */}
      <div className="flex items-center gap-2 opacity-60 transition-opacity group-hover:opacity-100">
        <button type="button" className="w-4 shrink-0 text-fg-subtle hover:text-fg" title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>{collapsed ? "▸" : "▾"}</button>
        <span className="text-caption font-medium uppercase tracking-wide text-fg-subtle">{name}</span>
        {block.is_shared ? <span className="text-caption text-accent-strong">shared</span> : null}
        <span className={`text-caption ${dirty && saveState !== "saving" ? "text-accent-strong" : "text-fg-subtle"}`}>{saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : dirty ? "● unsaved" : ""}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" isDisabled={isFirst} onPress={() => onMove(-1)}>↑</Button>
        <Button variant="ghost" size="sm" isDisabled={isLast} onPress={() => onMove(1)}>↓</Button>
        <Button variant="ghost" size="sm" className="text-danger" onPress={onRemove}>✕</Button>
      </div>

      {collapsed ? (
        <div className="cursor-pointer truncate pb-1 pl-6 text-small text-fg-subtle" onClick={() => setCollapsed(false)}>
          {fields == null ? "…" : blockPreview(fields) || <span className="italic">empty</span>}
        </div>
      ) : (
        <div className="pb-1 pl-6">
          {fields == null ? (
            <p className="text-small text-fg-subtle">loading…</p>
          ) : schema.length === 0 ? (
            <p className="text-small text-fg-subtle">This block has no editable fields.</p>
          ) : (
            <>
              <FieldForm schema={schema} value={fields} onChange={change} api={api} />
              {dirty || saveState === "saving" ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="secondary" size="sm" onPress={() => void save()} isDisabled={!dirty || saveState === "saving" || block.pending}>
                    {saveState === "saving" ? "Saving…" : "Save now"}
                  </Button>
                  <span className="text-caption text-fg-subtle">{saveState === "saving" ? "" : "Autosaving…"}</span>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Notion-style block inserter — the page-canvas analogue of the BlockEditor's `/`
// palette. A slim "＋ Add block" affordance expands into a searchable list of the
// region's allowed block types (type to filter; ↑/↓ + Enter to pick, Esc/blur to
// close). Insertion appends to the region; reorder via drag to position.
function Inserter({ allowed, btBySlug, onAdd, compact }: { allowed: string[]; btBySlug: Map<string, BlockType>; onAdd: (slug: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const list = allowed.map((slug) => ({ slug, name: btBySlug.get(slug)?.name ?? slug }));
    const s = q.trim().toLowerCase();
    return s ? list.filter((x) => x.name.toLowerCase().includes(s) || x.slug.toLowerCase().includes(s)) : list;
  }, [allowed, btBySlug, q]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setIdx(0); }, [q]);

  const close = () => { setOpen(false); setQ(""); };
  const pick = (slug?: string) => { if (slug) onAdd(slug); close(); };

  if (!open) {
    // Compact: a thin between-blocks divider that reveals a centered "+" on hover.
    if (compact) {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Insert block here"
          className="group/ins flex h-3 w-full items-center justify-center opacity-0 transition-opacity hover:opacity-100"
        >
          <span className="flex h-full w-full items-center">
            <span className="h-px flex-1 bg-brand-green/40" />
            <span className="mx-1 rounded bg-brand-green/15 px-1 text-caption leading-none text-brand-green">＋</span>
            <span className="h-px flex-1 bg-brand-green/40" />
          </span>
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-small text-fg-subtle opacity-70 transition-colors hover:bg-surface-muted hover:text-fg-muted hover:opacity-100"
      >
        <span className="text-base leading-none">＋</span>
        <span>Add block</span>
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-surface-card p-1 shadow-md">
      <input
        ref={inputRef}
        value={q}
        placeholder="Filter blocks…"
        spellCheck={false}
        className="mb-1 w-full rounded-md bg-surface px-2.5 py-1.5 text-small text-fg outline-none placeholder:text-fg-subtle"
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(close, 120)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((n) => (n + 1) % Math.max(items.length, 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((n) => (n - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1)); }
          else if (e.key === "Enter") { e.preventDefault(); pick(items[idx]?.slug); }
        }}
      />
      <div className="max-h-64 overflow-auto">
        {items.length === 0 ? (
          <div className="px-2.5 py-2 text-small text-fg-subtle">No matching block types</div>
        ) : (
          items.map((x, n) => (
            <button
              key={x.slug}
              type="button"
              onMouseEnter={() => setIdx(n)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(x.slug)}
              className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-small ${n === idx ? "bg-surface-muted text-fg" : "text-fg-muted hover:bg-surface-muted"}`}
            >
              {x.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Page META — title / slug / locale. Settings, not content, so it lives in the inspector.
 *
 * Split from the page's FIELDS (below) because the two are different things: the fields
 * are what the page SAYS, and burying them in a 400px inspector made a page whose content
 * type has no regions look empty — a wide, blank canvas next to a cramped form.
 */
function PageMeta({ api, page, onSaved, onError }: { api: Api; page: Page; onSaved: (p: Page) => void; onError: (s: string) => void }) {
  const { cms: { multilingual, locales } } = useApp();
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [locale, setLocale] = useState(page.locale);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setTitle(page.title); setSlug(page.slug); setLocale(page.locale); }, [page.id, page.title, page.slug, page.locale]);

  // Disabled until something actually differs, so the button says whether there is anything
  // to save rather than inviting a no-op write on every visit to the tab.
  const changed = title !== page.title || slug.trim() !== page.slug || (multilingual && locale !== page.locale);

  const save = async () => {
    setBusy(true);
    try {
      // Meta only — `fields` is deliberately omitted so saving here can never clobber
      // content edited in the canvas (updatePage patches only what it is given).
      // `locale` is sent ONLY where it is editable. On a single-locale deployment there is
      // no control for it, so including it would blind-overwrite whatever the row holds
      // with mount-time state — reverting an import or another editor's change through a
      // field this user cannot see. `updatePage` treats an absent key as no-change.
      const patch = multilingual ? { title, slug: slug.trim(), locale } : { title, slug: slug.trim() };
      const r = await api.call<{ page?: Page }>("updatePage", { pageId: page.id, ...patch });
      if (r?.page) onSaved(r.page);
      setOk(true);
      setTimeout(() => setOk(false), 1500);
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {ok ? <Banner ok>saved</Banner> : null}
      <Input label="Title" value={title} onChange={setTitle} />
      <Input label="Slug" value={slug} onChange={setSlug} />
      {/* A SELECT over the declared locales, not free text: a typo'd or blank locale saves
          fine, previews fine (the editor round-trips the same string) and then 404s on the
          live site, which is the hardest kind of wrong to see. */}
      {multilingual ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-fg">Locale</span>
          <select className={CONTROL} value={locale} onChange={(e) => setLocale(e.target.value)}>
            {locales.includes(locale) ? null : <option value={locale}>{locale || "(unset)"} — not a declared locale</option>}
            {locales.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      ) : null}
      {/* Explicit, unlike the canvas — a slug is the page's URL, and autosaving one keystroke
          at a time would publish `/ab`, `/abo`, `/abou` as real addresses and race the
          uniqueness check on every one. Named for what it saves, since it is no longer the
          only Save on screen by accident. */}
      <Button onPress={save} isDisabled={busy || !changed || !title.trim() || !slug.trim()}>
        {busy ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}

/** The page's own FIELDS — its content. Rendered in the canvas, at full width. */
function PageFields({ api, page, schema, initialFields, onDirtyChange, onError }: { api: Api; page: Page; schema: FieldDefinition[]; initialFields: FieldValues; onDirtyChange: (id: string, dirty: boolean) => void; onError: (s: string) => void }) {
  const [fields, setFields] = useState<FieldValues>(initialFields);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  // Dirty is DERIVED from a snapshot of what's persisted, the way BlockCard does it — not a
  // one-way flag set on every keystroke. Typing a character and deleting it again leaves the
  // form matching the store, and the guard this feeds now fronts the whole topbar: a sticky
  // flag would mean confirming your way past a prompt with nothing to save.
  const saved = useRef(JSON.stringify(initialFields));
  const dirty = JSON.stringify(fields) !== saved.current;

  // Re-seed the form ONLY when the editor switches to a different page — never on a mere
  // `initialFields` identity change. Every reload() (add/remove/reorder a block, save the
  // slug) replaces `assembled` wholesale, and when `page.fields` is SQL NULL the caller's
  // `?? {}` fallback mints a fresh object on EVERY render — keying off the object would
  // silently drop in-progress edits and clear the "● unsaved" badge with no warning.
  const seededFor = useRef(page.id);
  useEffect(() => {
    if (seededFor.current === page.id) return;
    seededFor.current = page.id;
    setFields(initialFields);
    saved.current = JSON.stringify(initialFields);
  }, [page.id, initialFields]);

  // Join the editor's unsaved-changes guard (mirrors BlockCard).
  useEffect(() => { onDirtyChange("page", dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange("page", false); }, [onDirtyChange]);

  // AUTOSAVED, on the same 800ms debounce a block uses — because this is the same thing a
  // block is: content on the canvas. It used to carry its own "Save" button, which sat a
  // column away from the inspector's identically-labelled one and saved the other half of the
  // screen, while the blocks between them saved silently. Three save models on one screen.
  const save = useCallback(async () => {
    // Snapshot BEFORE the round trip: an edit made while it's in flight must stay dirty.
    const snapshot = JSON.stringify(fields);
    if (snapshot === saved.current) return;
    setSaveState("saving");
    try {
      await api.call("updatePage", { pageId: page.id, fields });
      saved.current = snapshot;
      setSaveState("saved");
      setTimeout(() => setSaveState((st) => (st === "saved" ? "idle" : st)), 1500);
    } catch (e) {
      onError(errMsg(e));
      setSaveState("idle");
    }
  }, [api, page.id, fields, onError]);

  // Keyed on `fields`, so it fires only on an actual edit: a failed save leaves them
  // unchanged and does NOT auto-retry (no hot loop) — the next edit does. The leave guard
  // above still covers the debounce window.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void saveRef.current(), 800);
    return () => clearTimeout(t);
  }, [fields, dirty]);

  return (
    <div className="mb-10">
      <div className="mb-1 flex items-center gap-2">
        {/* NOT "Content". A region is very often named `content`, and the two headings then
            sat one above the other on the same canvas, both reading CONTENT and meaning
            different things. These are the page's OWN fields. */}
        <span className="text-caption font-medium uppercase tracking-wide text-fg-subtle">Page fields</span>
        <span className={`text-caption ${dirty && saveState !== "saving" ? "text-accent-strong" : "text-fg-subtle"}`}>
          {saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : dirty ? "● unsaved" : ""}
        </span>
      </div>
      <FieldForm schema={schema} value={fields} onChange={setFields} api={api} />
    </div>
  );
}

function SeoPanel({ api, page, onError }: { api: Api; page: Page; onError: (s: string) => void }) {
  const [f, setF] = useState({ metaTitle: page.metaTitle ?? "", metaDescription: page.metaDescription ?? "", canonicalUrl: page.canonicalUrl ?? "", robots: page.robots ?? "", ogTitle: page.ogTitle ?? "", ogDescription: page.ogDescription ?? "" });
  const [ok, setOk] = useState(false);
  const save = async () => {
    try {
      await api.call("updatePageSeo", { pageId: page.id, ...f });
      setOk(true);
      setTimeout(() => setOk(false), 1500);
    } catch (e) {
      onError(errMsg(e));
    }
  };
  const F = (k: keyof typeof f, label: string, area = false) =>
    area ? (
      <Textarea label={label} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} />
    ) : (
      <Input label={label} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} />
    );
  return (
    <div className="flex flex-col gap-4">
      <Section>SEO</Section>
      {ok ? <Banner ok>saved</Banner> : null}
      {F("metaTitle", "Meta title")}
      {F("metaDescription", "Meta description", true)}
      {F("canonicalUrl", "Canonical URL")}
      {F("robots", "Robots (e.g. noindex)")}
      {F("ogTitle", "OG title")}
      {F("ogDescription", "OG description", true)}
      <Button className="w-full" onPress={save}>Save SEO</Button>
    </div>
  );
}

function I18n({ api, page, onError }: { api: Api; page: Page; onError: (s: string) => void }) {
  const [translations, setTranslations] = useState<{ id: string; locale: string; slug: string; status: string }[]>([]);
  const [locale, setLocale] = useState("");
  const refresh = useCallback(() => api.call<typeof translations>("listTranslations", { pageId: page.id }).then(setTranslations).catch((e) => onError(errMsg(e))), [api, page.id, onError]);
  useEffect(() => { refresh(); }, [refresh]);
  const create = async () => {
    try {
      await api.call("createTranslation", { pageId: page.id, locale });
      setLocale("");
      refresh();
    } catch (e) {
      onError(errMsg(e));
    }
  };
  return (
    <div>
      <Section>Translations</Section>
      <div className="flex flex-col gap-2">
        {translations.map((t) => (
          <div className={ROW} key={t.id}>
            <span className="flex-1 truncate font-medium">{t.locale}</span>
            <span className="text-fg-subtle">/{t.slug}</span>
            <Pill status={t.status}>{t.status}</Pill>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-end gap-1.5">
        <Input label="" value={locale} onChange={setLocale} placeholder="locale (e.g. cs)" />
        <Button variant="secondary" onPress={create} isDisabled={!locale}>add</Button>
      </div>
    </div>
  );
}

/** The page's taxonomy terms.
 *
 * Assignment has to live in the page editor: `cms_page_terms` links a term to a PAGE, so
 * the vocabulary screen can define terms but has no way to attach one — a taxonomy with no
 * assignment surface is a list of words.
 *
 * `setPageTerms` replaces the whole selection rather than adding and removing one at a
 * time, so the panel holds the selection and saves it as a unit. Two calls each patching
 * one end of it race into a state neither asked for.
 */
function PageTerms({ api, pageId, canEdit, onError }: { api: Api; pageId: string; canEdit: boolean; onError: (s: string) => void }) {
  const [taxa, setTaxa] = useState<Taxonomy[] | null>(null);
  const [terms, setTerms] = useState<Record<string, Term[]>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Only the vocabularies that classify PAGES. The narrowing is the server's, so this
        // panel and `setPageTerms`' own guard cannot disagree about what applies here.
        const list = await api.listTaxonomies("page");
        if (!live) return;
        setTaxa(list);
        // In parallel, and alongside the page's own assignments. Awaiting one vocabulary at
        // a time made the panel's open cost N+1 serial round trips for data that has no
        // ordering dependency between the calls.
        const [trees, assigned] = await Promise.all([
          Promise.all(list.map(async (t) => [t.slug, flattenTerms(await api.getTermTree(t.slug)).map((f) => f.term)] as const)),
          api.listPageTerms(pageId),
        ]);
        if (!live) return;
        setTerms(Object.fromEntries(trees));
        setSelected(new Set(assigned.map((t) => t.id)));
      } catch (e) {
        if (live) onError(errMsg(e));
      }
    })();
    return () => { live = false; };
  }, [api, pageId, onError]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setPageTerms(pageId, [...selected]);
      setOk(true);
      setTimeout(() => setOk(false), 1200);
    } catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };

  if (taxa === null) return <p className="text-fg-subtle">Loading…</p>;
  // Not "none defined": the list is narrowed to the vocabularies that apply to PAGES, so a
  // site whose only vocabulary is media-only would read as having none — and send an editor
  // off to create a duplicate of the one it already has.
  if (taxa.length === 0) return <p className="text-fg-subtle">No vocabularies apply to pages yet — set one up under Taxonomies.</p>;

  return (
    <div className="flex flex-col gap-4">
      {ok ? <Banner ok>saved</Banner> : null}
      {taxa.map((t) => (
        <div key={t.id}>
          <Section>{t.label}</Section>
          <div className="flex flex-col gap-1">
            {(terms[t.slug] ?? []).length === 0 ? <span className="text-caption text-fg-subtle">No terms yet.</span> : null}
            {(terms[t.slug] ?? []).map((term) => (
              <label key={term.id} className="flex items-center gap-2">
                {/* `setPageTerms` is editor-gated, so a reviewer got live checkboxes and a
                    Save button that 403s — the one new write surface that did not take
                    `canEdit`. */}
                <input type="checkbox" disabled={!canEdit} checked={selected.has(term.id)} onChange={() => toggle(term.id)} />
                <span className="text-sm text-fg">{term.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {canEdit ? <Button size="sm" className="self-start" onPress={save} isDisabled={busy}>{busy ? "Saving…" : "Save terms"}</Button> : null}
    </div>
  );
}

function AuditLog({ api, pageId, onError }: { api: Api; pageId: string; onError: (s: string) => void }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  useEffect(() => {
    api.listPageAudit(pageId).then(setRows).catch((e) => onError(errMsg(e)));
  }, [api, pageId, onError]);
  return (
    <div>
      <Section>Audit trail</Section>
      <div className="flex flex-col gap-2">
        {rows.map((a) => (
          <div className={`${ROW} text-xs`} key={a.id}>
            <span className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg-muted">{a.action}</span>
            <span className="flex-1 truncate text-fg-subtle">{a.fromStatus} → {a.toStatus}</span>
            <span className="text-fg-subtle">{a.actor ?? "system"}</span>
          </div>
        ))}
        {rows.length === 0 ? <p className="text-fg-subtle">No history yet.</p> : null}
      </div>
    </div>
  );
}

/** One filter bucket. A toggle rather than a link: pressing the active one clears the filter,
 * which is the gesture a chip bar teaches — and `aria-pressed` says so, since the tint alone
 * is invisible to a screen reader and marginal to anyone who cannot see it. */
function FilterChip({ active, onPress, children }: { active: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-compact ${active ? "bg-surface-muted font-medium text-fg" : "text-fg-muted hover:text-fg"}`}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}

// --- media library (a top-level view: browse, upload, edit alt, delete) ---
const PAGE_SIZE = 60;
/** How long typing has to pause before the library is re-queried. Long enough that a typed
 * word is one request rather than five, short enough that it still reads as live. */
const SEARCH_DEBOUNCE_MS = 250;
/** The tag menu's "no filter" row. A menu item needs an id and `null` is not one, so the
 * clear option carries a sentinel — safe against a real term id, which is a uuid. */
const ALL_TAGS = "__all";

export function MediaLibrary({ api, onError }: { api: Api; onError: (s: string) => void }) {
  const { cms: { mediaTerms, canEdit } } = useApp();
  const [media, setMedia] = useState<Media[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Media | null>(null);
  const [busy, setBusy] = useState(false);
  // The file input the header's Upload button drives. It stays in the DOM (hidden) rather
  // than being created per click, so the picker's `change` handler is the ordinary React one.
  const fileInput = useRef<HTMLInputElement>(null);
  // Trashed files. Deleting no longer removes the R2 object, so without this the bytes stay
  // publicly fetchable with no way to reach purgeMedia — the case a takedown request needs.
  const [trash, setTrash] = useState<Media[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  // Order and type filter. Both are SERVER-side: the library is paged, and sorting or
  // filtering the page that arrived would sort or filter 60 of however many there are, which
  // is not sorting and not filtering.
  const [sort, setSort] = useState<MediaSort>("newest");
  const [kind, setKind] = useState<MediaKind | null>(null);
  // Two states for one search box. `query` is what the field shows and must update on every
  // keystroke; `search` is what the server is asked for, and lags it by `SEARCH_DEBOUNCE_MS`
  // — without the split, either the field stutters or every letter is a round trip.
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  // Tags. The vocabularies are loaded ONCE here rather than in the detail modal: the filter
  // above the grid and the checkboxes inside a file both need the same list, and fetching it
  // per opened file would be a round trip on every click for data that changes on the terms
  // screen. `term` filters server-side like `kind` — it is a relation traversal, not a
  // client-side pass over the page that happened to arrive.
  const [term, setTerm] = useState<string | null>(null);
  const [taxa, setTaxa] = useState<Taxonomy[]>([]);
  const [terms, setTerms] = useState<Record<string, Term[]>>({});
  useEffect(() => {
    if (!mediaTerms) return;
    let live = true;
    (async () => {
      try {
        const list = await api.listTaxonomies("media");
        const trees = await Promise.all(list.map(async (t) => [t.slug, flattenTerms(await api.getTermTree(t.slug)).map((f) => f.term)] as const));
        if (!live) return;
        setTaxa(list);
        setTerms(Object.fromEntries(trees));
      } catch {
        // Non-fatal, deliberately: tagging is one control on this screen, and a vocabulary
        // fetch that fails should cost the tag filter, not the media library.
        if (live) { setTaxa([]); setTerms({}); }
      }
    })();
    return () => { live = false; };
  }, [api, mediaTerms]);
  // Flattened for the filter menu, which is one list rather than a tree: a menu has no room
  // for indentation to read as hierarchy, so the vocabulary is spelled out per row instead.
  const taggable = taxa.flatMap((t) => (terms[t.slug] ?? []).map((x) => ({ id: x.id, label: x.label, group: t.label })));

  const load = useCallback(
    (off: number) => {
      api
        .listMedia({ limit: PAGE_SIZE, offset: off, sort, kind: kind ?? undefined, q: search || undefined, term: term ?? undefined })
        .then((rows) => {
          setMedia((prev) => (off === 0 ? rows : [...prev, ...rows]));
          setHasMore(rows.length === PAGE_SIZE);
          setOffset(off + rows.length);
        })
        .catch((e) => onError(errMsg(e)));
    },
    // Changing any of them resets to page 0 through the effect below — appending a
    // differently ordered or narrowed page onto the one already on screen would interleave
    // two orderings, or show files the current filter excludes.
    [api, onError, sort, kind, search, term],
  );
  const loadTrash = useCallback(() => {
    api.listTrash().then((r) => setTrash(r.media ?? [])).catch((e) => onError(errMsg(e)));
  }, [api, onError]);
  useEffect(() => { load(0); }, [load]);
  useEffect(() => { loadTrash(); }, [loadTrash]);

  const restore = async (id: string) => {
    try {
      await api.restoreMedia(id);
      loadTrash();
      load(0);
    } catch (e) {
      onError(errMsg(e));
    }
  };
  const purge = async (id: string) => {
    if (!confirm("Delete this file permanently? The file itself is removed and cannot be recovered.")) return;
    try {
      await api.purgeMedia(id);
      loadTrash();
    } catch (e) {
      onError(errMsg(e));
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    onError("");
    try {
      for (const f of Array.from(files)) await api.uploadMedia(f);
      load(0); // refresh from the top
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Hero lead="Media" em={media.length === 0 ? "None yet" : media.length === 1 ? "1 file" : `${media.length}${hasMore ? "+" : ""} files`}>
        {/* A real `Button` driving a hidden input, not a `<label>` painted to look like one.
            The lookalike had to restate podoba's primary fill by hand, and once the mint
            wrapper was gone the two "primary" actions in this app were visibly different
            colours on the dark theme — `surface-inverted` (cream) here, `brand-primary`
            (mint) everywhere else. */}
        <input ref={fileInput} type="file" multiple hidden disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <Button className="shrink-0" isDisabled={busy} onPress={() => fileInput.current?.click()}>
          {busy ? "Uploading…" : "+ Upload"}
        </Button>
      </Hero>
      <div className={WRAP}>
        {/* Order and type, above the grid rather than in the header: the header is the
            SCREEN's identity and its one primary action, and a row of controls in it would be
            the mint-pill mistake again — a second cluster competing with the artwork. They sit
            with the thing they act on. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {/* Matches the filename AND the alt text — the only human description a media row
              carries, so searching for "logo" finds the file somebody described as one even
              when the upload was called `IMG_2831.png`. */}
          <SearchField
            aria-label="Search media"
            placeholder="Search files…"
            value={query}
            onChange={setQuery}
            className="w-[220px] shrink-0"
          />
          {/* A menu, not podoba's `Select`: that is a form FIELD — a stacked visible label
              over a trigger, sized and spaced for a form — and in a toolbar it would stand a
              head taller than the chips beside it. A trigger showing the current order is the
              toolbar shape, and it is the same RAC menu pattern underneath. */}
          <DropdownMenuTrigger>
            <Button variant="secondary" size="sm" className="shrink-0 px-3 py-1 text-compact">
              {MEDIA_SORT_LABELS[sort]}
            </Button>
            <DropdownMenu aria-label="Sort media" onAction={(k) => setSort(k as MediaSort)}>
              {MEDIA_SORTS.map((v) => (
                <DropdownMenuItem key={v} id={v}>{MEDIA_SORT_LABELS[v]}</DropdownMenuItem>
              ))}
            </DropdownMenu>
          </DropdownMenuTrigger>
          {/* A menu rather than chips, unlike `kind`: the buckets are a closed set of five that
              fits on the row, where terms are however many an editor has authored. It sits
              BESIDE the sort menu rather than after the chips, so the row groups by control
              type — two triggers, then the chip bar — instead of trailing a seventh pill that
              reads as another type bucket. Drawn only once a vocabulary HAS a term: a filter
              offering nothing to filter by can only disappoint. */}
          {mediaTerms && taggable.length > 0 ? (
            <DropdownMenuTrigger>
              <Button variant="secondary" size="sm" className="shrink-0 px-3 py-1 text-compact">
                {term ? (taggable.find((t) => t.id === term)?.label ?? "Tag") : "All tags"}
              </Button>
              <DropdownMenu aria-label="Filter media by tag" onAction={(k) => setTerm(k === ALL_TAGS ? null : String(k))}>
                <DropdownMenuItem id={ALL_TAGS}>All tags</DropdownMenuItem>
                {/* Qualified by vocabulary here, where a flat menu gives hierarchy nowhere to
                    show; the trigger stays the bare term, which is what the row is filtered by. */}
                {taggable.map((t) => (
                  <DropdownMenuItem key={t.id} id={t.id}>{t.group} · {t.label}</DropdownMenuItem>
                ))}
              </DropdownMenu>
            </DropdownMenuTrigger>
          ) : null}
          {/* Buttons, not a second dropdown: five buckets is few enough to show, and a filter
              you can see the state of without opening it is the point of a filter bar. "All"
              is `null` rather than a sixth kind — the server's absent-means-everything, said
              once, on the side that has the state. */}
          <div className="flex flex-wrap items-center gap-1">
            <FilterChip active={kind === null} onPress={() => setKind(null)}>All</FilterChip>
            {MEDIA_KINDS.map((k) => (
              <FilterChip key={k} active={kind === k} onPress={() => setKind(kind === k ? null : k)}>
                {MEDIA_KIND_LABELS[k]}
              </FilterChip>
            ))}
          </div>
        </div>
        {media.length === 0 ? (
          <p className="text-fg-subtle">No media yet. Upload images to use them in blocks and SEO.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
            {media.map((m) => (
              <div key={m.id} className={`cursor-pointer overflow-hidden rounded-lg border bg-surface-card ${selected?.id === m.id ? "border-fg" : "border-border"}`} onClick={() => setSelected(m)}>
                {isImage(m) ? <img className="block h-[130px] w-full object-cover" src={api.resolve(`/media/${m.file.key}`)} alt={m.alt ?? ""} /> : <div className="flex h-[130px] items-center justify-center bg-surface-muted font-mono text-xs text-fg-subtle">{ext(m)}</div>}
                <div className="truncate px-2 py-1.5 text-[11px] text-fg-muted">{m.file.filename ?? m.id}</div>
              </div>
            ))}
          </div>
        )}
        {hasMore ? (
          <div className="mt-3.5 text-center">
            <Button variant="secondary" size="sm" onPress={() => load(offset)}>Load more</Button>
          </div>
        ) : null}
        {trash.length > 0 ? (
          <div className="mt-6 border-t border-border pt-4">
            <button type="button" className="text-small text-fg-muted underline" onClick={() => setShowTrash((v) => !v)}>
              {showTrash ? "Hide" : "Show"} trash ({trash.length})
            </button>
            {showTrash ? (
              <>
                <p className="mt-2 text-small text-fg-subtle">
                  Trashed files are hidden from the library but the file itself still exists — a page published
                  while it was in use keeps showing it. Delete permanently to remove the file.
                </p>
                <div className="mt-2.5 flex flex-col gap-1.5">
                  {trash.map((m) => (
                    <div key={m.id} className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-muted px-3 py-2">
                      <span className="flex-1 truncate text-small text-fg-muted">{m.file?.filename ?? m.id}</span>
                      <Button variant="secondary" size="sm" onPress={() => restore(m.id)}>Restore</Button>
                      <Button variant="secondary" size="sm" onPress={() => purge(m.id)}>Delete permanently</Button>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {selected ? (
          <MediaDetail
            api={api}
            media={selected}
            taxa={mediaTerms ? taxa : []}
            terms={terms}
            canEdit={canEdit}
            onClose={() => setSelected(null)}
            onSaved={(m) => { setSelected(m); setMedia((prev) => prev.map((x) => (x.id === m.id ? m : x))); }}
            onDeleted={(id) => { setSelected(null); setMedia((prev) => prev.filter((x) => x.id !== id)); loadTrash(); }}
            // Only while a tag filter is on, and only then: retagging the open file can move
            // it out of (or into) the current narrowing, so leaving the grid alone would show
            // a file the filter excludes. Unfiltered, nothing on screen changed.
            onTermsSaved={() => { if (term) load(0); }}
            onError={onError}
          />
        ) : null}
      </div>
    </>
  );
}

function MediaDetail({ api, media, taxa, terms, canEdit, onClose, onSaved, onDeleted, onTermsSaved, onError }: { api: Api; media: Media; taxa: Taxonomy[]; terms: Record<string, Term[]>; canEdit: boolean; onClose: () => void; onSaved: (m: Media) => void; onDeleted: (id: string) => void; onTermsSaved: () => void; onError: (s: string) => void }) {
  const [alt, setAlt] = useState(media.alt ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setAlt(media.alt ?? ""), [media]);
  const url = api.resolve(`/media/${media.file.key}`);

  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.updateMedia(media.id, alt || null));
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!confirm("Move this file to the trash? It disappears from the library, but a page published while it was in use keeps showing it — delete it permanently from the trash to remove the file itself.")) return;
    setBusy(true);
    try {
      await api.deleteMedia(media.id);
      onDeleted(media.id);
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} size="lg" title={<><Dim>Media</Dim> {media.file.filename ?? ""}</>}>
      {isImage(media) ? (
        <img className="mx-auto mb-3.5 block max-h-[340px] max-w-full rounded-lg bg-surface-muted object-contain" src={url} alt={media.alt ?? ""} />
      ) : (
        <div className="mb-3.5 flex h-[200px] items-center justify-center rounded-lg bg-surface-muted font-mono text-fg-subtle">{ext(media)}</div>
      )}
      <div className="mb-4">
        <Input label="Alt text (for accessibility & SEO)" value={alt} onChange={setAlt} placeholder="Describe the image…" />
      </div>
      <KV>
        <span>Type</span>
        <span>{media.file.contentType ?? "—"}</span>
        <span>Size</span>
        <span>{fmtBytes(media.file.size)}</span>
        <span>Uploaded</span>
        <span>{media.file.uploadedAt ? new Date(media.file.uploadedAt).toLocaleString() : (media.createdAt ?? "—")}</span>
        <span>URL</span>
        <span className="break-all">
          <a className="underline underline-offset-2" href={url} target="_blank" rel="noreferrer">/media/{media.file.key}</a>
        </span>
      </KV>
      {taxa.length > 0 ? <MediaTerms api={api} mediaId={media.id} taxa={taxa} terms={terms} canEdit={canEdit} onSaved={onTermsSaved} onError={onError} /> : null}
      <div className="mt-3.5 flex items-center gap-2">
        <Button onPress={save} isDisabled={busy || alt === (media.alt ?? "")}>Save</Button>
        <Button variant="secondary" size="sm" onPress={() => navigator.clipboard?.writeText(url)}>Copy URL</Button>
        <span className="flex-1" />
        <Button variant="ghost" className="text-danger" onPress={del} isDisabled={busy}>Delete</Button>
        <Button variant="ghost" onPress={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

/** A file's taxonomy terms, inside the detail modal.
 *
 * The vocabularies arrive as props — the library loaded them once for its filter, and this
 * panel opens and closes per file. Only the ASSIGNMENTS are fetched here, because they are
 * the part that is per-file.
 *
 * Saved as a set, like `setPageTerms`: the panel holds the whole selection, and two calls
 * each patching one end of it race into a state neither asked for.
 */
function MediaTerms({ api, mediaId, taxa, terms, canEdit, onSaved, onError }: { api: Api; mediaId: string; taxa: Taxonomy[]; terms: Record<string, Term[]>; canEdit: boolean; onSaved: () => void; onError: (s: string) => void }) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let live = true;
    setSelected(null);
    api
      .listMediaTerms(mediaId)
      .then((rows) => { if (live) setSelected(new Set(rows.map((t) => t.id))); })
      .catch((e) => { if (live) { setSelected(new Set()); onError(errMsg(e)); } });
    return () => { live = false; };
  }, [api, mediaId, onError]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setMediaTerms(mediaId, [...(selected ?? [])]);
      setOk(true);
      setTimeout(() => setOk(false), 1200);
      onSaved();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(false); }
  };

  // Until the assignments arrive the checkboxes would all read unchecked, and a save from
  // that state would silently clear every tag the file has.
  if (selected === null) return <div className="mt-4 border-t border-border pt-3.5 text-small text-fg-subtle">Loading tags…</div>;

  return (
    <div className="mt-4 border-t border-border pt-3.5">
      <Section>Tags</Section>
      {ok ? <Banner ok>saved</Banner> : null}
      <div className="flex flex-col gap-2.5">
        {taxa.map((t) => {
          const list = terms[t.slug] ?? [];
          return (
            <div key={t.id}>
              <div className="mb-1 text-caption text-fg-subtle">{t.label}</div>
              {list.length === 0 ? (
                <span className="text-caption text-fg-subtle">No terms yet.</span>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {list.map((term) => (
                    <label key={term.id} className="flex items-center gap-2">
                      {/* `setMediaTerms` is editor-gated, so without this a reviewer gets live
                          checkboxes and a Save that 403s — the same gap `PageTerms` closed. */}
                      <input type="checkbox" disabled={!canEdit} checked={selected.has(term.id)} onChange={() => toggle(term.id)} />
                      <span className="text-sm text-fg">{term.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {canEdit ? <Button size="sm" variant="secondary" className="mt-2.5 self-start" onPress={save} isDisabled={busy}>{busy ? "Saving…" : "Save tags"}</Button> : null}
    </div>
  );
}

// --- users management (admin) ------------------------------------------------

interface UserRow {
  username: string;
  email?: string | null;
  roles?: string[] | string;
  active?: boolean | number | null;
  createdAt?: number | null;
}

function rolesOf(u: UserRow): string[] {
  const r = u.roles;
  if (Array.isArray(r)) return r.filter((x): x is string => typeof x === "string");
  if (typeof r === "string") { try { const j = JSON.parse(r); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
}

export function UsersView({ api, me, onError }: { api: Api; me: Me | null; onError: (s: string) => void }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string>("");

  const refresh = useCallback(() => {
    api.call<UserRow[]>("listUsers", { limit: 200 }).then(setUsers).catch((e) => onError(errMsg(e)));
  }, [api, onError]);
  useEffect(() => { refresh(); }, [refresh]);

  const setRoles = async (u: UserRow, roles: string[]) => {
    setBusy(u.username);
    try { await api.call("setUserRoles", { username: u.username, roles }); refresh(); }
    catch (e) { onError(errMsg(e)); }
    finally { setBusy(""); }
  };
  const setActive = async (u: UserRow, active: boolean) => {
    setBusy(u.username);
    try { await api.call("setUserActive", { username: u.username, active }); refresh(); }
    catch (e) { onError(errMsg(e)); }
    finally { setBusy(""); }
  };
  const del = async (u: UserRow) => {
    if (!confirm(`Delete user ${u.username}? This cannot be undone.`)) return;
    setBusy(u.username);
    try { await api.call("deleteUser", { username: u.username }); refresh(); }
    catch (e) { onError(errMsg(e)); }
    finally { setBusy(""); }
  };

  return (
    <>
      <Hero lead="Users" em={users.length === 0 ? "None yet" : users.length === 1 ? "1 account" : `${users.length} accounts`}>
        <Button className="shrink-0" onPress={() => setInviting(true)}>+ Invite</Button>
      </Hero>
      <div className={WRAP}>
        <div className="flex flex-col gap-2">
          {users.map((u) => {
            const roles = rolesOf(u);
            const isMe = me?.userId === u.username;
            const active = u.active === undefined || u.active === null ? true : Boolean(Number(u.active));
            return (
              <div className={`${ROW} flex-wrap items-start`} key={u.username}>
                <div className="flex min-w-[200px] flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{u.username}{isMe ? <span className="ml-1.5 font-normal text-fg-subtle">(you)</span> : null}</span>
                  {u.email && u.email !== u.username ? <span className="text-xs text-fg-subtle">{u.email}</span> : null}
                  {u.createdAt ? <span className="text-[11px] text-fg-subtle">joined {new Date(Number(u.createdAt)).toLocaleDateString()}</span> : null}
                </div>
                <RolesInput value={roles} disabled={busy === u.username} onSave={(next) => setRoles(u, next)} />
                <Pill status={active ? "active" : "inactive"}>{active ? "active" : "inactive"}</Pill>
                <Button variant="ghost" size="sm" isDisabled={busy === u.username || isMe} onPress={() => setActive(u, !active)}>{active ? "Deactivate" : "Activate"}</Button>
                <Button variant="ghost" size="sm" className="text-danger" isDisabled={busy === u.username || isMe} onPress={() => del(u)}>Delete</Button>
              </div>
            );
          })}
          {users.length === 0 ? <p className="text-fg-subtle">No users yet. Invite someone to get started.</p> : null}
        </div>
      </div>
      {inviting ? <InviteUser api={api} onClose={() => setInviting(false)} onInvited={() => { setInviting(false); refresh(); }} onError={onError} /> : null}
    </>
  );
}

function RolesInput({ value, disabled, onSave }: { value: string[]; disabled: boolean; onSave: (roles: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  const [editing, setEditing] = useState(false);
  useEffect(() => { setText(value.join(", ")); }, [value]);
  const commit = () => {
    setEditing(false);
    const next = text.split(",").map((s) => s.trim()).filter(Boolean);
    if (next.length === 0) { setText(value.join(", ")); return; }
    if (next.length === value.length && next.every((r, i) => r === value[i])) return;
    onSave(next);
  };
  if (editing) {
    return (
      <input
        autoFocus
        className="h-10 w-[220px] rounded-lg border border-border bg-surface-card px-4 text-sm text-fg outline-none focus:border-brand-green"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setText(value.join(", ")); setEditing(false); } }}
      />
    );
  }
  return (
    <span className="flex cursor-pointer flex-wrap gap-1" onClick={() => setEditing(true)} title="Click to edit">
      {value.length === 0 ? <Pill>no roles</Pill> : value.map((r) => <Pill key={r} status={r === "admin" ? "published" : undefined}>{r}</Pill>)}
    </span>
  );
}

function InviteUser({ api, onClose, onInvited, onError }: { api: Api; onClose: () => void; onInvited: () => void; onError: (s: string) => void }) {
  const [email, setEmail] = useState("");
  const [roles, setRoles] = useState("editor");
  const [busy, setBusy] = useState(false);
  const invite = async () => {
    setBusy(true);
    try {
      const rs = roles.split(",").map((s) => s.trim()).filter(Boolean);
      await api.call("inviteUser", { email, roles: rs });
      onInvited();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      onClose={onClose}
      title={<>Invite an <Dim>editor</Dim> or teammate</>}
      description="They'll get a one-time magic link that logs them in and creates their account."
    >
      <div className="flex flex-col gap-4">
        <Input label="Email" type="email" autoFocus value={email} onChange={setEmail} placeholder="them@example.com" />
        <Input label="Roles (comma-separated — e.g. editor, reviewer, admin)" value={roles} onChange={setRoles} placeholder="editor" />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button onPress={invite} isDisabled={busy || !email}>{busy ? "Sending…" : "Send invite"}</Button>
        </div>
      </div>
    </Modal>
  );
}

// --- settings ----------------------------------------------------------------

export function SettingsView({ api, cfg, me, onSignOut, onError }: { api: Api; cfg: Config; me: Me | null; onSignOut: () => void; onError: (s: string) => void }) {
  return (
    <>
      <Hero lead="Settings" em={me?.userId ?? "your account"} />
      <div className={`${WRAP} grid grid-cols-2 gap-5 max-[820px]:grid-cols-1`}>
        <MyAccountCard api={api} me={me} onError={onError} onSignOut={onSignOut} />
        <AboutCard cfg={cfg} me={me} />
      </div>
    </>
  );
}

function MyAccountCard({ api, me, onError, onSignOut }: { api: Api; me: Me | null; onError: (s: string) => void; onSignOut: () => void }) {
  const [email, setEmail] = useState("");
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 1800); };

  const saveEmail = async () => {
    setBusy(true);
    try { await api.call("changeEmail", { email }); setEmail(""); flash("Contact email updated"); }
    catch (e) { onError(errMsg(e)); }
    finally { setBusy(false); }
  };
  const savePassword = async () => {
    setBusy(true);
    try { await api.call("changePassword", { currentPassword: pwCurrent, newPassword: pwNew }); setPwCurrent(""); setPwNew(""); flash("Password updated"); }
    catch (e) { onError(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <Section>My account</Section>
      {msg ? <Banner ok>{msg}</Banner> : null}
      <KV className="mb-4">
        <span>Username</span><span>{me?.userId ?? "—"}</span>
        <span>Roles</span><span>{(me?.roles ?? []).join(", ") || "—"}</span>
      </KV>
      <div className="flex flex-col gap-4">
        <Input label="Change contact email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
        <Button className="w-full" onPress={saveEmail} isDisabled={busy || !email}>Save email</Button>
        <Input label="Current password" type="password" value={pwCurrent} onChange={setPwCurrent} autoComplete="current-password" />
        <Input label="New password (at least 8 characters)" type="password" value={pwNew} onChange={setPwNew} autoComplete="new-password" />
        <Button className="w-full" onPress={savePassword} isDisabled={busy || pwNew.length < 8 || pwCurrent.length === 0}>Change password</Button>
        <Button variant="ghost" className="mt-2 w-full text-danger" onPress={onSignOut}>Sign out</Button>
      </div>
    </Card>
  );
}

function AboutCard({ cfg, me }: { cfg: Config; me: Me | null }) {
  return (
    <Card>
      <Section>About</Section>
      <KV>
        <span>Tenant</span><span>{cfg.tenant || "main"}</span>
        <span>API</span><span className="break-all">{cfg.baseUrl}</span>
        <span>Signed in as</span><span>{me?.userId ?? "—"}</span>
        <span>Editor</span><span>pramen · cms-editor</span>
      </KV>
    </Card>
  );
}

// --- helpers ---
function isImage(m: Media): boolean {
  return (m.file.contentType ?? "").startsWith("image/");
}
function ext(m: Media): string {
  const fromType = (m.file.contentType ?? "").split("/")[1];
  const fromName = m.file.filename?.split(".").pop();
  return (fromName ?? fromType ?? "file").slice(0, 5).toUpperCase();
}
function fmtBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
/** Strip HTML tags + decode the few entities the WYSIWYG emits, for a clean text preview —
 * so a collapsed rich_text block reads "Test Toakdopwad" instead of "<b>Test</b>&nbsp;…". */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
/** Readable text for one field value, whatever shape it is. A `richtext` field is a
 * document tree, so the first non-empty STRING is no longer enough — a block whose only
 * field is prose would read "empty". Legacy HTML strings still pass through `plainText`. */
function fieldText(v: FieldValue): string {
  if (typeof v === "string") return plainText(v);
  if (isRichTextDoc(v)) return richTextToPlainText(v).replace(/\s+/g, " ").trim();
  return "";
}
/** One-line preview for a collapsed block: the first field with readable text in it. */
function blockPreview(fields: FieldValues): string {
  let text = "";
  for (const v of Object.values(fields)) {
    text = fieldText(v);
    if (text) break;
  }
  if (!text) return "";
  return text.length > 90 ? text.slice(0, 90) + "…" : text;
}
function reorderMove(blocks: RenderedBlock[], region: string, i: number, d: number, reorder: (region: string, order: string[]) => void) {
  const j = i + d;
  if (j < 0 || j >= blocks.length) return;
  const ids = blocks.map((b) => b.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  reorder(region, ids);
}
