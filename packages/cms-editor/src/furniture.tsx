// Site furniture: menus, redirects, taxonomies and widget areas.
//
// The WordPress-parity surface every client project reinvented by hand (GitHub #32). All
// four are SITE-level rather than page-level — they exist once per deployment and are read
// by the layout — so none of them lives under Pages, and each gets its own nav entry
// positioned by `NAV_ORDER`.
//
// The screens share a shape: a list with an inline "new" form, and a detail editor for the
// one thing that is actually a document (a menu tree, a term hierarchy, a widget list).
// Redirects are the exception and stay a single table, because a redirect IS a row.

import { Button, Heading, Input } from "@podoba/react";
import { useCallback, useEffect, useState } from "react";
import { useApp, useUnsavedGuard } from "./app-context";
import type { Api } from "./api";
import { CONTROL, RichText, slugify } from "./fields";
import { ROW, ROW_BUTTON, WRAP } from "./chrome";
import { DetailHeader } from "./detail-header";
import { getI18n, useI18n, type TextKey } from "./i18n";
import { rich } from "./i18n/rich";
import { LoadFailed, nullableSummary } from "./list-state";
import { useCrumb } from "./breadcrumb";
import { PageHeader } from "./page-header";
import type { CollectionMeta, Menu, MenuItem, MenuItemKind, Page, Redirect, RichTextDoc, Taxonomy, Term, Widget, WidgetArea } from "./types";
import { MAX_MENU_DEPTH, REDIRECT_STATUSES, TAXONOMY_TARGET_KEYS, TAXONOMY_TARGETS } from "./types";
import type { TaxonomyTarget } from "./types";


export function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/** Fetch a furniture list into `T[] | null` state, where `null` is "not answered yet".
 *
 * These four screens already told loading apart from empty that way, and then threw it away
 * on the error path: a failed fetch set `[]`, so a 500 read as "0 menus" and "No menus yet"
 * under the error banner, the same as a fresh deployment. Now a failure leaves the rows as
 * they were (null on first load, the last good list on a refresh) and raises `failed`, which
 * the header and the body turn into "Not loaded" and a retry. */
function useFurnitureList<T>(fetch: () => Promise<T[]>, onError: (s: string) => void) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    fetch()
      .then((r) => { setRows(r); setFailed(false); })
      .catch((e) => { setFailed(true); onError(errText(e)); });
  }, [fetch, onError]);
  useEffect(refresh, [refresh]);
  return { rows, failed: failed && rows === null, refresh };
}

/** A detail editor before its document is on screen: loading, or (if the fetch failed) a
 * retry. The three editors below used to show "Loading…" in both cases, so a failed fetch was
 * a spinner that never ended, with the actual error only in the banner above it. */
function DetailPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className={WRAP}>
      <div className="pt-8">{failed ? <LoadFailed onRetry={onRetry} /> : <p className="text-fg-subtle">{t("common.loading")}</p>}</div>
    </div>
  );
}

/** The site-furniture screens' header. `Head` stays as the local name the four call sites
 * below already use; it is the same component, at the same scale, as every other screen —
 * see the note in `page-header.tsx` about why the smaller variant went away. */
const Head = PageHeader;

function Saved() {
  const { t } = useI18n();
  return <div className="rounded-lg border border-brand-green bg-brand-green/20 px-3.5 py-2.5 text-small text-fg">{t("furniture.saved")}</div>;
}

/** A `name`/`slug` key field with the same rule the server enforces, following a label
 * while it is untouched. Used by all four screens' "new" forms. */
function KeyFields({ label, keyValue, onLabel, onKey, keyHint }: {
  label: string;
  keyValue: string;
  onLabel: (v: string) => void;
  onKey: (v: string) => void;
  keyHint: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
      <Input label={t("furniture.label")} value={label} onChange={onLabel} />
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-fg">{t("furniture.key")}</span>
        <input className={CONTROL} value={keyValue} onChange={(e) => onKey(e.target.value.trim())} />
        <span className="text-caption text-fg-subtle">{keyHint}</span>
      </label>
    </div>
  );
}

// --- menus ----------------------------------------------------------------------------

export function MenusView({ api, onOpen, onError, canEdit }: { api: Api; onOpen: (name: string) => void; onError: (s: string) => void; canEdit: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { rows: menus, failed, refresh } = useFurnitureList(useCallback(() => api.listMenus(), [api]), onError);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createMenu(name, label);
      setLabel(""); setName(""); setNameTouched(false);
      onOpen(created.name);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <Head lead={t("menus.lead")} em={nullableSummary(menus, failed, { empty: t("menus.none"), forms: i18n.forms("menus.count") })} />
      <div className={WRAP}>
        <div className="flex flex-col gap-2">
        {menus === null && !failed ? <p className="text-fg-subtle">{t("common.loading")}</p> : null}
        {failed ? <LoadFailed onRetry={refresh} /> : null}
        {menus?.length === 0 ? <p className="text-fg-subtle">{rich(t("menus.empty"), { code: (s) => <code>{s}</code> })}</p> : null}
        {(menus ?? []).map((m) => (
          <button type="button" key={m.id} className={`${ROW} ${ROW_BUTTON}`} onClick={() => onOpen(m.name)}>
            <span className="min-w-0 flex-1 truncate font-medium">{m.label}</span>
            <span className="shrink-0 truncate text-fg-subtle">{m.name}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{i18n.tp("menus.itemCount", countItems(m.items ?? []))}</span>
          </button>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[720px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">{t("menus.new")}</Heading>
          <KeyFields
            label={label}
            keyValue={name}
            onLabel={(v) => { setLabel(v); if (!nameTouched) setName(slugify(v)); }}
            onKey={(v) => { setNameTouched(true); setName(v); }}
            keyHint={t("furniture.keyHint.layout")}
          />
          <Button className="mt-3" onPress={create} isDisabled={busy || !label.trim() || !name.trim()}>{t("menus.create")}</Button>
        </div>
      ) : null}
      </div>
    </>
  );
}

function countItems(items: readonly MenuItem[]): number {
  return items.reduce((n, it) => n + 1 + countItems(it.children ?? []), 0);
}

/** A flattened view of a menu tree: every item with its depth and its path of indices.
 * Editing operates on the PATH, so a move is one splice at a known place rather than a
 * recursive rebuild that has to re-find the item it just moved. */
interface FlatItem { item: MenuItem; path: number[]; depth: number }

function flatten(items: readonly MenuItem[], prefix: number[] = []): FlatItem[] {
  const out: FlatItem[] = [];
  items.forEach((item, i) => {
    const path = [...prefix, i];
    out.push({ item, path, depth: prefix.length });
    out.push(...flatten(item.children ?? [], path));
  });
  return out;
}

/** The sibling list a path points into, and the index within it. */
function siblingsAt(items: MenuItem[], path: readonly number[]): { list: MenuItem[]; index: number } {
  let list = items;
  for (let i = 0; i < path.length - 1; i++) list = list[path[i]!]!.children ?? [];
  return { list, index: path[path.length - 1]! };
}

/** Structural edits, all as "clone the tree, then splice". Cloning is cheap (a menu is tens
 * of items) and it keeps every operation a pure function of the previous tree — which is
 * what makes undo-by-not-saving work, and what stops a move from mutating an item that a
 * later step in the same handler is still reading. */
function cloneTree(items: readonly MenuItem[]): MenuItem[] {
  return items.map((it) => ({ ...it, children: it.children ? cloneTree(it.children) : undefined }));
}

function removeAt(items: readonly MenuItem[], path: readonly number[]): { tree: MenuItem[]; removed: MenuItem } {
  const tree = cloneTree(items);
  const { list, index } = siblingsAt(tree, path);
  const [removed] = list.splice(index, 1);
  return { tree, removed: removed! };
}

export function MenuEditor({ api, name, collections, onBack, backHref, onDeleted, onError, canEdit }: {
  api: Api;
  name: string;
  collections: CollectionMeta[];
  onBack: () => void;
  /** Where `onBack` goes, as an href: the detail header's way back, for a theme that renders it as a link. */
  backHref: string;
  onDeleted: () => void;
  onError: (s: string) => void;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  // The app bar's trailing crumb — the menu's LABEL once it has loaded, not the `name` key in
  // the URL, which is what a layout gets to publish and is not what an editor calls it.
  useCrumb(menu?.label);
  const [label, setLabel] = useState("");
  // The whole tree is edited locally and written only by "Save menu", so leaving the screen
  // discards it. Nothing prompted before this — `PageEditor` was the only screen that ever
  // registered a guard.
  const [baseline, setBaseline] = useState("");
  useUnsavedGuard(menu !== null && JSON.stringify({ label, items }) !== baseline);
  // The version this screen loaded. Sent back on save, so a second editor's whole-tree
  // overwrite is a 409 the person can act on rather than a silent replacement.
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  // See `DetailPending`: a failed load is not "still loading", and says so with a retry.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  // Reference targets, fetched once: a menu item points at a page or a term by id, and a
  // raw uuid field would make this unusable.
  const [pages, setPages] = useState<Page[]>([]);
  const [terms, setTerms] = useState<Array<{ id: string; label: string; taxonomy: string }>>([]);

  useEffect(() => {
    let live = true;
    // `listMenus` (raw) rather than `getMenu` (resolved): the editor must show what is
    // STORED — a reference to a page that is currently unpublished is dropped from the
    // public read, and editing against that view would silently delete those items on save.
    api.listMenus()
      .then((all) => {
        if (!live) return;
        const m = all.find((x) => x.name === name);
        if (!m) { setMissing(true); return; }
        setMenu(m); setLabel(m.label); setItems(m.items ?? []);
        setVersion(m.version);
        setBaseline(JSON.stringify({ label: m.label, items: m.items ?? [] }));
      })
      .catch((e) => { if (live) setLoadFailed(true); onError(errText(e)); });
    api.listPages({ limit: 200 }).then((r) => live && setPages(r)).catch(() => setPages([]));
    api.listTaxonomies()
      .then(async (taxa) => {
        // One request per vocabulary, in PARALLEL — the picker cannot render until the last
        // of them lands either way, so serializing them only added latency.
        const trees = await Promise.all(taxa.map(async (t) => [t, await api.getTermTree(t.slug).catch(() => [] as Term[])] as const));
        const all: Array<{ id: string; label: string; taxonomy: string }> = [];
        for (const [t, tree] of trees) {
          const walk = (list: Term[], prefix: string) => {
            for (const term of list) {
              all.push({ id: term.id, label: `${prefix}${term.label}`, taxonomy: t.label });
              if (term.children) walk(term.children, `${prefix}${term.label} / `);
            }
          };
          walk(tree, "");
        }
        if (live) setTerms(all);
      })
      .catch(() => setTerms([]));
    return () => { live = false; };
  }, [api, name, onError, attempt]);

  const save = async () => {
    if (!menu) return;
    setBusy(true);
    try {
      const saved = await api.updateMenu(menu.id, { label, items, expectedVersion: version });
      setVersion(saved.version);
      setBaseline(JSON.stringify({ label, items }));
      setOk(true); setTimeout(() => setOk(false), 1200);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  const del = async () => {
    if (!menu || !confirm(t("menu.confirmDelete", { label: menu.label }))) return;
    setBusy(true);
    try { await api.deleteMenu(menu.id); onDeleted(); } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  const flat = flatten(items);

  const patch = (path: number[], p: Partial<MenuItem>) => {
    const tree = cloneTree(items);
    const { list, index } = siblingsAt(tree, path);
    list[index] = { ...list[index]!, ...p };
    setItems(tree);
  };
  const remove = (path: number[]) => setItems(removeAt(items, path).tree);
  const move = (path: number[], d: number) => {
    const tree = cloneTree(items);
    const { list, index } = siblingsAt(tree, path);
    const to = index + d;
    if (to < 0 || to >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(to, 0, moved!);
    setItems(tree);
  };
  /** Indent: become a child of the PREVIOUS SIBLING, which is the only unambiguous parent
   * an indent can mean. Refused at the top of a list (nothing to nest under) and at the
   * depth cap the server enforces. */
  const indent = (path: number[], depth: number) => {
    const { index } = siblingsAt(items, path);
    if (index === 0 || depth + 1 >= MAX_MENU_DEPTH) return;
    const { tree, removed } = removeAt(items, path);
    const { list } = siblingsAt(tree, path);
    const prev = list[index - 1]!;
    prev.children = [...(prev.children ?? []), removed];
    setItems(tree);
  };
  /** Outdent: become the next sibling of the parent. */
  const outdent = (path: number[]) => {
    if (path.length < 2) return;
    const { tree, removed } = removeAt(items, path);
    const parentPath = path.slice(0, -1);
    const { list, index } = siblingsAt(tree, parentPath);
    list.splice(index + 1, 0, removed);
    setItems(tree);
  };
  const add = () => setItems([...items, { id: crypto.randomUUID(), label: t("menu.newItem"), kind: "custom", url: "/" }]);

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{t("menu.unknown", { name })}</p></div>;
  if (!menu) return <DetailPending failed={loadFailed} onRetry={() => { setLoadFailed(false); setAttempt((n) => n + 1); }} />;

  return (
    <div className={WRAP}>
      <DetailHeader title={menu.label} parent={t("menu.parent")} href={backHref} onBack={onBack}>
        <span className="text-fg-subtle">{menu.name}</span>
      </DetailHeader>
      <div className="flex max-w-[860px] flex-col gap-4">
        {ok ? <Saved /> : null}
        <Input label={t("furniture.label")} value={label} onChange={setLabel} />
        <div className="flex flex-col gap-2">
          {flat.length === 0 ? <p className="text-sm text-fg-subtle">{t("menu.noItems")}</p> : null}
          {flat.map(({ item, path, depth }) => (
            <div key={item.id} style={{ marginLeft: depth * 24 }}>
              <MenuItemRow
                item={item}
                depth={depth}
                pages={pages}
                terms={terms}
                collections={collections}
                onPatch={(p) => patch(path, p)}
                onMove={(d) => move(path, d)}
                onIndent={() => indent(path, depth)}
                onOutdent={() => outdent(path)}
                onRemove={() => remove(path)}
              />
            </div>
          ))}
        </div>
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onPress={add}>{t("menu.addItem")}</Button>
            <Button onPress={save} isDisabled={busy}>{busy ? t("common.saving") : t("menu.save")}</Button>
            <Button variant="ghost" className="text-danger" onPress={del} isDisabled={busy}>{t("menu.delete")}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const MENU_KINDS: { value: MenuItemKind; label: TextKey }[] = [
  { value: "custom", label: "menu.kind.custom" },
  { value: "page", label: "menu.kind.page" },
  { value: "term", label: "menu.kind.term" },
  { value: "collection", label: "menu.kind.collection" },
];

function MenuItemRow({ item, depth, pages, terms, collections, onPatch, onMove, onIndent, onOutdent, onRemove }: {
  item: MenuItem;
  depth: number;
  pages: Page[];
  terms: Array<{ id: string; label: string; taxonomy: string }>;
  collections: CollectionMeta[];
  onPatch: (p: Partial<MenuItem>) => void;
  onMove: (d: number) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const kind = item.kind ?? "custom";
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-3.5">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("furniture.label")}</span>
            <input className={CONTROL} value={item.label} onChange={(e) => onPatch({ label: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("menu.item.pointsAt")}</span>
            <select
              className={CONTROL}
              value={kind}
              // Changing the kind clears the OTHER kind's target. Keeping both would post a
              // `ref` alongside a `url` and store whichever the server happens to read.
              onChange={(e) => onPatch({ kind: e.target.value as MenuItemKind, ref: null, url: e.target.value === "custom" ? "/" : undefined })}
            >
              {MENU_KINDS.map((k) => <option key={k.value} value={k.value}>{t(k.label)}</option>)}
            </select>
          </label>
        </div>
        <div className="flex shrink-0 items-start gap-0.5 pt-5">
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title={t("furniture.moveUp")} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title={t("furniture.moveDown")} onClick={() => onMove(1)}>↓</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title={t("menu.item.indent")} disabled={depth + 1 >= MAX_MENU_DEPTH} onClick={onIndent}>→</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title={t("menu.item.outdent")} disabled={depth === 0} onClick={onOutdent}>←</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-danger" title={t("common.remove")} onClick={onRemove}>✕</button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        {kind === "custom" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("menu.item.url")}</span>
            <input className={CONTROL} value={item.url ?? ""} placeholder={t("menu.item.urlPlaceholder")} onChange={(e) => onPatch({ url: e.target.value })} />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("menu.item.target")}</span>
            <select className={CONTROL} value={item.ref ?? ""} onChange={(e) => onPatch({ ref: e.target.value || null })}>
              <option value="">{t("furniture.pickOne")}</option>
              {kind === "page" ? pages.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.slug})</option>) : null}
              {kind === "term" ? terms.map((term) => <option key={term.id} value={term.id}>{term.taxonomy}: {term.label}</option>) : null}
              {kind === "collection" ? collections.map((c) => <option key={c.slug} value={c.slug}>{c.pluralLabel}</option>) : null}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-subtle">{t("menu.item.opensIn")}</span>
          <select className={CONTROL} value={item.target ?? ""} onChange={(e) => onPatch({ target: e.target.value || undefined })}>
            <option value="">{t("menu.item.sameTab")}</option>
            <option value="_blank">{t("menu.item.newTab")}</option>
          </select>
        </label>
      </div>
      {kind !== "custom" && !item.ref ? (
        <p className="mt-2 text-caption text-danger">{t("menu.item.needsTarget")}</p>
      ) : null}
      {kind !== "custom" ? (
        <p className="mt-2 text-caption text-fg-subtle">
          {t("menu.item.resolvedHint")}
        </p>
      ) : null}
    </div>
  );
}

// --- redirects ------------------------------------------------------------------------

export function RedirectsView({ api, onError, canEdit }: { api: Api; onError: (s: string) => void; canEdit: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { rows, failed, refresh } = useFurnitureList<Redirect>(useCallback(() => api.listRedirects(), [api]), onError);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState(301);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.createRedirect({ fromPath: from, toPath: to, status });
      setFrom(""); setTo("");
      refresh();
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };
  const patch = async (r: Redirect, p: Parameters<Api["updateRedirect"]>[1]) => {
    try { await api.updateRedirect(r.id, p); refresh(); } catch (e) { onError(errText(e)); }
  };
  const del = async (r: Redirect) => {
    if (!confirm(t("redirects.confirmDelete", { from: r.fromPath }))) return;
    try { await api.deleteRedirect(r.id); refresh(); } catch (e) { onError(errText(e)); }
  };

  return (
    <>
      <Head lead={t("redirects.lead")} em={nullableSummary(rows, failed, { empty: t("redirects.none"), forms: i18n.forms("redirects.count") })} />
      <div className={WRAP}>
        <p className="mb-4 max-w-[62ch] text-sm text-fg-muted">
        {t("redirects.intro")}
      </p>
      <div className="flex flex-col gap-2">
        {rows === null && !failed ? <p className="text-fg-subtle">{t("common.loading")}</p> : null}
        {failed ? <LoadFailed onRetry={refresh} /> : null}
        {rows?.length === 0 ? <p className="text-fg-subtle">{t("redirects.empty")}</p> : null}
        {(rows ?? []).map((r) => (
          <div key={r.id} className={`${ROW} ${r.enabled ? "" : "opacity-60"}`}>
            <span className="min-w-0 flex-1 truncate font-medium">{r.fromPath}</span>
            <span className="shrink-0 text-fg-subtle">→</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">{r.toPath}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{r.status}</span>
            {canEdit ? (
              <>
                <Button variant="ghost" size="sm" onPress={() => patch(r, { enabled: !r.enabled })}>{r.enabled ? t("redirects.disable") : t("redirects.enable")}</Button>
                <Button variant="ghost" size="sm" className="text-danger" onPress={() => del(r)}>{t("furniture.delete")}</Button>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[860px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">{t("redirects.new")}</Heading>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-3 max-[720px]:grid-cols-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">{t("redirects.from")}</span>
              <input className={CONTROL} value={from} placeholder={t("redirects.fromPlaceholder")} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">{t("redirects.to")}</span>
              <input className={CONTROL} value={to} placeholder={t("redirects.toPlaceholder")} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">{t("redirects.status")}</span>
              <select className={CONTROL} value={status} onChange={(e) => setStatus(Number(e.target.value))}>
                {REDIRECT_STATUSES.map((s) => <option key={s} value={s}>{t(s === 301 || s === 308 ? "redirects.status.permanent" : "redirects.status.temporary", { status: s })}</option>)}
              </select>
            </label>
          </div>
          <Button className="mt-3" onPress={create} isDisabled={busy || !from.trim() || !to.trim()}>{t("redirects.add")}</Button>
        </div>
      ) : null}
      </div>
    </>
  );
}

// --- taxonomies -----------------------------------------------------------------------

/** What a vocabulary classifies. `null` is EVERYTHING, and it is a real state rather than a
 * shorthand for "all boxes ticked": a vocabulary that was never narrowed keeps applying to
 * whatever the CMS grows next, where an explicit `["page","media"]` freezes it at today's two.
 * So "Everything" is its own option, not the all-checked case. */
function AppliesToField({ value, onChange, disabled }: { value: TaxonomyTarget[] | null; onChange: (v: TaxonomyTarget[] | null) => void; disabled?: boolean }) {
  const { t: tr } = useI18n();
  const toggle = (t: TaxonomyTarget) => {
    const next = (value ?? []).includes(t) ? (value ?? []).filter((x) => x !== t) : [...(value ?? []), t];
    // Unchecking the last one would mean a vocabulary nothing can use, which the server
    // refuses — so it lands back on "Everything", the nearest thing the person meant.
    onChange(next.length === 0 ? null : next);
  };
  return (
    <div className="mt-3">
      <span className="text-caption text-fg-subtle">{tr("taxonomies.appliesTo")}</span>
      {/* "Everything" gets its own line rather than sitting in the row as a third peer: a radio
          beside two checkboxes reads as one group with mismatched controls, when it is actually
          the choice ABOVE them — pick everything, or pick which. */}
      <div className="mt-1 flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input type="radio" checked={value === null} disabled={disabled} onChange={() => onChange(null)} />
          <span className="text-sm text-fg">{tr("taxonomies.appliesTo.everything")}</span>
        </label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-5">
          {TAXONOMY_TARGETS.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="checkbox" checked={(value ?? []).includes(t)} disabled={disabled} onChange={() => toggle(t)} />
              <span className="text-sm text-fg">{tr(TAXONOMY_TARGET_KEYS[t])}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/** How a vocabulary's scope reads in a list row. */
function appliesToText(t: Taxonomy): string {
  const i18n = getI18n();
  const list = t.appliesTo;
  if (!Array.isArray(list) || list.length === 0) return i18n.t("taxonomies.everything");
  const keys: Readonly<Record<string, TextKey>> = TAXONOMY_TARGET_KEYS;
  return list.map((x) => (keys[x] ? i18n.t(keys[x]) : x)).join(" + ").toLowerCase();
}


export function TaxonomiesView({ api, onOpen, onError, canEdit }: { api: Api; onOpen: (slug: string) => void; onError: (s: string) => void; canEdit: boolean }) {
  // No target: this is the screen that EDITS the scope, so it has to show a vocabulary it
  // has narrowed away. Otherwise narrowing one to Media would remove it from the only
  // place that could widen it again.
  const { t: tr } = useI18n();
  const { rows: taxa, failed, refresh } = useFurnitureList(useCallback(() => api.listTaxonomies(), [api]), onError);
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [hierarchical, setHierarchical] = useState(false);
  // `null` is "everything", which is also what an un-narrowed vocabulary stores — so the
  // default here is the same value the server would have written anyway.
  const [appliesTo, setAppliesTo] = useState<TaxonomyTarget[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Scoping a vocabulary and media tagging shipped together, and the flag is the same one for
  // that reason: a server either has both or neither, and a second capability for the same
  // release would be one that can never be false on its own. On an older server the field is
  // hidden rather than offered and silently dropped.
  const { cms: { mediaTerms: scopable } } = useApp();


  const create = async () => {
    setBusy(true);
    try {
      // On a server that cannot scope a vocabulary, `null` is what it would store anyway —
      // so this sends the same value the field's default means rather than a conditional key.
      const created = await api.createTaxonomy({ slug, label, hierarchical, appliesTo: scopable ? appliesTo : null });
      setLabel(""); setSlug(""); setSlugTouched(false); setHierarchical(false); setAppliesTo(null);
      onOpen(created.slug);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <Head lead={tr("taxonomies.lead")} em={tr("taxonomies.leadEm")} />
      <div className={WRAP}>
        <p className="mb-4 max-w-[62ch] text-sm text-fg-muted">
        {tr("taxonomies.intro")}
      </p>
      <div className="flex flex-col gap-2">
        {taxa === null && !failed ? <p className="text-fg-subtle">{tr("common.loading")}</p> : null}
        {failed ? <LoadFailed onRetry={refresh} /> : null}
        {taxa?.length === 0 ? <p className="text-fg-subtle">{tr("taxonomies.empty")}</p> : null}
        {(taxa ?? []).map((t) => (
          <button type="button" key={t.id} className={`${ROW} ${ROW_BUTTON}`} onClick={() => onOpen(t.slug)}>
            <span className="min-w-0 flex-1 truncate font-medium">{t.label}</span>
            <span className="shrink-0 truncate text-fg-subtle">{t.slug}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{t.hierarchical ? tr("taxonomies.nested") : tr("taxonomies.flat")}</span>
            {scopable ? <span className="shrink-0 text-caption text-fg-subtle">{appliesToText(t)}</span> : null}
          </button>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[720px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">{tr("taxonomies.new")}</Heading>
          <KeyFields
            label={label}
            keyValue={slug}
            onLabel={(v) => { setLabel(v); if (!slugTouched) setSlug(slugify(v)); }}
            onKey={(v) => { setSlugTouched(true); setSlug(v); }}
            keyHint={tr("taxonomies.keyHint")}
          />
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" checked={hierarchical} onChange={(e) => setHierarchical(e.target.checked)} />
            <span className="text-sm text-fg">{tr("taxonomies.hierarchical")}</span>
          </label>
          {scopable ? <AppliesToField value={appliesTo} onChange={setAppliesTo} /> : null}
          <Button className="mt-3" onPress={create} isDisabled={busy || !label.trim() || !slug.trim()}>{tr("taxonomies.create")}</Button>
        </div>
      ) : null}
      </div>
    </>
  );
}

export function TaxonomyEditor({ api, slug, onBack, backHref, onDeleted, onError, canEdit }: {
  api: Api;
  slug: string;
  onBack: () => void;
  /** Where `onBack` goes, as an href: the detail header's way back, for a theme that renders it as a link. */
  backHref: string;
  onDeleted: () => void;
  onError: (s: string) => void;
  canEdit: boolean;
}) {
  const { t: tr } = useI18n();
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [tree, setTree] = useState<Term[] | null>(null);
  const [treeFailed, setTreeFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [termLabel, setTermLabel] = useState("");
  const [termSlug, setTermSlug] = useState("");
  const [termSlugTouched, setTermSlugTouched] = useState(false);
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const { cms: { mediaTerms: scopable } } = useApp();

  const refreshTerms = useCallback(() => {
    api.getTermTree(slug).then((t) => { setTree(t); setTreeFailed(false); }).catch((e) => { setTreeFailed(true); onError(errText(e)); });
  }, [api, slug, onError]);

  useEffect(() => {
    let live = true;
    api.listTaxonomies()
      .then((all) => {
        if (!live) return;
        const t = all.find((x) => x.slug === slug);
        if (!t) { setMissing(true); return; }
        setTax(t);
      })
      .catch((e) => { if (live) setLoadFailed(true); onError(errText(e)); });
    return () => { live = false; };
  }, [api, slug, onError, attempt]);
  useEffect(refreshTerms, [refreshTerms]);

  const flat = tree ? flattenTerms(tree) : [];

  const addTerm = async () => {
    setBusy(true);
    try {
      await api.createTerm({ taxonomy: slug, slug: termSlug, label: termLabel, parentId: parentId || null });
      setTermLabel(""); setTermSlug(""); setTermSlugTouched(false); setParentId("");
      refreshTerms();
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };
  const delTerm = async (t: Term) => {
    if (!confirm(tr("taxonomyTerms.confirmDelete", { label: t.label }))) return;
    try { await api.deleteTerm(t.id); refreshTerms(); } catch (e) { onError(errText(e)); }
  };
  const renameTerm = async (t: Term, label: string) => {
    if (label === t.label) return;
    try { await api.updateTerm(t.id, { label }); refreshTerms(); } catch (e) { onError(errText(e)); }
  };
  /** Saved on change rather than behind a Save button, because a narrowing can be REFUSED —
   * the server rejects one that would strand existing assignments — and a refusal has to be
   * visible while the choice that caused it is still on screen. On refusal the field goes back
   * to what is stored, so it never shows a scope the server did not accept. */
  const setAppliesTo = async (next: TaxonomyTarget[] | null) => {
    if (!tax) return;
    const previous = tax.appliesTo ?? null;
    setTax({ ...tax, appliesTo: next });
    try {
      onError("");
      await api.updateTaxonomy(tax.id, { appliesTo: next });
    } catch (e) {
      setTax({ ...tax, appliesTo: previous });
      onError(errText(e));
    }
  };

  const delTaxonomy = async () => {
    if (!tax || !confirm(tr("taxonomy.confirmDelete", { label: tax.label }))) return;
    try { await api.deleteTaxonomy(tax.id); onDeleted(); } catch (e) { onError(errText(e)); }
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{tr("taxonomy.unknown", { slug })}</p></div>;
  if (!tax) return <DetailPending failed={loadFailed} onRetry={() => { setLoadFailed(false); setAttempt((n) => n + 1); }} />;

  return (
    <div className={WRAP}>
      <DetailHeader title={tax.label} parent={tr("taxonomy.parent")} href={backHref} onBack={onBack}>
        <span className="text-fg-subtle">{tax.slug}</span>
      </DetailHeader>
      <div className="flex max-w-[860px] flex-col gap-4">
        <div className="flex flex-col gap-2">
          {tree === null && !treeFailed ? <p className="text-fg-subtle">{tr("common.loading")}</p> : null}
          {tree === null && treeFailed ? <LoadFailed onRetry={refreshTerms} /> : null}
          {tree?.length === 0 ? <p className="text-fg-subtle">{tr("taxonomyTerms.empty")}</p> : null}
          {flat.map(({ term, depth }) => (
            <div key={term.id} className={ROW} style={{ marginLeft: depth * 24 }}>
              <input
                className={`${CONTROL} flex-1`}
                defaultValue={term.label}
                aria-label={tr("taxonomyTerms.labelFor", { label: term.label })}
                disabled={!canEdit}
                // Committed on blur, not per keystroke: each save is a round trip, and a
                // rename mid-word would land a term called "Ne".
                onBlur={(e) => renameTerm(term, e.target.value.trim())}
              />
              <span className="shrink-0 truncate text-fg-subtle">{term.slug}</span>
              {canEdit ? <Button variant="ghost" size="sm" className="text-danger" onPress={() => delTerm(term)}>{tr("furniture.delete")}</Button> : null}
            </div>
          ))}
        </div>

        {canEdit ? (
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <Heading level="2" className="mb-3 font-normal">{tr("taxonomyTerms.new")}</Heading>
            <KeyFields
              label={termLabel}
              keyValue={termSlug}
              onLabel={(v) => { setTermLabel(v); if (!termSlugTouched) setTermSlug(slugify(v)); }}
              onKey={(v) => { setTermSlugTouched(true); setTermSlug(v); }}
              keyHint={tr("taxonomyTerms.keyHint")}
            />
            {tax.hierarchical ? (
              <label className="mt-3 flex flex-col gap-1.5">
                <span className="text-caption text-fg-subtle">{tr("taxonomyTerms.parent")}</span>
                <select className={CONTROL} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">{tr("taxonomyTerms.topLevel")}</option>
                  {flat.map(({ term, depth }) => <option key={term.id} value={term.id}>{"\u00a0\u00a0\u00a0".repeat(depth)}{term.label}</option>)}
                </select>
              </label>
            ) : null}
            <Button className="mt-3" onPress={addTerm} isDisabled={busy || !termLabel.trim() || !termSlug.trim()}>{tr("taxonomyTerms.add")}</Button>
          </div>
        ) : null}

        {canEdit && scopable ? (
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <Heading level="2" className="mb-1 font-normal">{tr("taxonomy.scope.title")}</Heading>
            <p className="max-w-[62ch] text-caption text-fg-subtle">
              {tr("taxonomy.scope.hint")}
            </p>
            <AppliesToField value={tax.appliesTo ?? null} onChange={setAppliesTo} />
          </div>
        ) : null}

        {canEdit ? <Button variant="ghost" className="self-start text-danger" onPress={delTaxonomy}>{tr("taxonomy.delete")}</Button> : null}
      </div>
    </div>
  );
}

interface FlatTerm { term: Term; depth: number }

export function flattenTerms(tree: readonly Term[], depth = 0): FlatTerm[] {
  const out: FlatTerm[] = [];
  for (const term of tree) {
    out.push({ term, depth });
    if (term.children) out.push(...flattenTerms(term.children, depth + 1));
  }
  return out;
}

// --- widget areas ---------------------------------------------------------------------

export function WidgetAreasView({ api, onOpen, onError, canEdit }: { api: Api; onOpen: (name: string) => void; onError: (s: string) => void; canEdit: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { rows: areas, failed, refresh } = useFurnitureList(useCallback(() => api.listWidgetAreas(), [api]), onError);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createWidgetArea(name, label);
      setLabel(""); setName(""); setNameTouched(false);
      onOpen(created.name);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <Head lead={t("widgets.lead")} em={t("widgets.leadEm")} />
      <div className={WRAP}>
        <p className="mb-4 max-w-[62ch] text-sm text-fg-muted">
        {rich(t("widgets.intro"), { code: (s) => <code>{s}</code> })}
      </p>
      <div className="flex flex-col gap-2">
        {areas === null && !failed ? <p className="text-fg-subtle">{t("common.loading")}</p> : null}
        {failed ? <LoadFailed onRetry={refresh} /> : null}
        {areas?.length === 0 ? <p className="text-fg-subtle">{t("widgets.empty")}</p> : null}
        {(areas ?? []).map((a) => (
          <button type="button" key={a.id} className={`${ROW} ${ROW_BUTTON}`} onClick={() => onOpen(a.name)}>
            <span className="min-w-0 flex-1 truncate font-medium">{a.label}</span>
            <span className="shrink-0 truncate text-fg-subtle">{a.name}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{i18n.tp("widgets.count", (a.widgets ?? []).length)}</span>
          </button>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[720px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">{t("widgets.new")}</Heading>
          <KeyFields
            label={label}
            keyValue={name}
            onLabel={(v) => { setLabel(v); if (!nameTouched) setName(slugify(v)); }}
            onKey={(v) => { setNameTouched(true); setName(v); }}
            keyHint={t("furniture.keyHint.layout")}
          />
          <Button className="mt-3" onPress={create} isDisabled={busy || !label.trim() || !name.trim()}>{t("widgets.create")}</Button>
        </div>
      ) : null}
      </div>
    </>
  );
}

export function WidgetAreaEditor({ api, name, onBack, backHref, onDeleted, onError, canEdit }: {
  api: Api;
  name: string;
  onBack: () => void;
  /** Where `onBack` goes, as an href: the detail header's way back, for a theme that renders it as a link. */
  backHref: string;
  onDeleted: () => void;
  onError: (s: string) => void;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const [area, setArea] = useState<WidgetArea | null>(null);
  const [label, setLabel] = useState("");
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [baseline, setBaseline] = useState("");
  useUnsavedGuard(area !== null && JSON.stringify({ label, widgets }) !== baseline);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  // See `DetailPending`: a failed load is not "still loading", and says so with a retry.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let live = true;
    api.listWidgetAreas()
      .then((all) => {
        if (!live) return;
        const a = all.find((x) => x.name === name);
        if (!a) { setMissing(true); return; }
        setArea(a); setLabel(a.label); setWidgets(a.widgets ?? []);
        setVersion(a.version);
        setBaseline(JSON.stringify({ label: a.label, widgets: a.widgets ?? [] }));
      })
      .catch((e) => { if (live) setLoadFailed(true); onError(errText(e)); });
    api.listMenus().then((r) => live && setMenus(r)).catch(() => setMenus([]));
    return () => { live = false; };
  }, [api, name, onError, attempt]);

  const save = async () => {
    if (!area) return;
    setBusy(true);
    try {
      const saved = await api.updateWidgetArea(area.id, { label, widgets, expectedVersion: version });
      setVersion(saved.version);
      setBaseline(JSON.stringify({ label, widgets }));
      setOk(true); setTimeout(() => setOk(false), 1200);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!area || !confirm(t("widgetArea.confirmDelete", { label: area.label }))) return;
    try { await api.deleteWidgetArea(area.id); onDeleted(); } catch (e) { onError(errText(e)); }
  };

  const set = (i: number, w: Widget) => setWidgets(widgets.map((x, j) => (j === i ? w : x)));
  const move = (i: number, d: number) => {
    const to = i + d;
    if (to < 0 || to >= widgets.length) return;
    const next = widgets.slice();
    const [moved] = next.splice(i, 1);
    next.splice(to, 0, moved!);
    setWidgets(next);
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{t("widgetArea.unknown", { name })}</p></div>;
  if (!area) return <DetailPending failed={loadFailed} onRetry={() => { setLoadFailed(false); setAttempt((n) => n + 1); }} />;

  return (
    <div className={WRAP}>
      <DetailHeader title={area.label} parent={t("widgetArea.parent")} href={backHref} onBack={onBack}>
        <span className="text-fg-subtle">{area.name}</span>
      </DetailHeader>
      <div className="flex max-w-[860px] flex-col gap-4">
        {ok ? <Saved /> : null}
        <Input label={t("furniture.label")} value={label} onChange={setLabel} />
        <div className="flex flex-col gap-2">
          {widgets.length === 0 ? <p className="text-sm text-fg-subtle">{t("widgetArea.empty")}</p> : null}
          {widgets.map((w, i) => (
            <WidgetRow
              key={w.id}
              widget={w}
              menus={menus}
              onChange={(next) => set(i, next)}
              onMove={(d) => move(i, d)}
              onRemove={() => setWidgets(widgets.filter((_, j) => j !== i))}
            />
          ))}
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onPress={() => setWidgets([...widgets, { id: crypto.randomUUID(), type: "content", content: { type: "doc", content: [] } }])}>{t("widgetArea.addText")}</Button>
            <Button variant="secondary" size="sm" onPress={() => setWidgets([...widgets, { id: crypto.randomUUID(), type: "menu", menuName: menus[0]?.name ?? "" }])}>{t("widgetArea.addMenu")}</Button>
            <Button variant="secondary" size="sm" onPress={() => setWidgets([...widgets, { id: crypto.randomUUID(), type: "component", componentId: "" }])}>{t("widgetArea.addComponent")}</Button>
            <Button onPress={save} isDisabled={busy}>{busy ? t("common.saving") : t("common.save")}</Button>
            <Button variant="ghost" className="text-danger" onPress={del} isDisabled={busy}>{t("widgetArea.delete")}</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The name of each widget kind, shown on its card. */
const WIDGET_TYPE_KEYS = {
  content: "widgetArea.type.content",
  menu: "widgetArea.type.menu",
  component: "widgetArea.type.component",
} as const satisfies Record<Widget["type"], TextKey>;

function WidgetRow({ widget, menus, onChange, onMove, onRemove }: {
  widget: Widget;
  menus: Menu[];
  onChange: (w: Widget) => void;
  onMove: (d: number) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const patch = (p: Partial<Widget>) => onChange({ ...widget, ...p });
  const typeKeys: Readonly<Record<string, TextKey>> = WIDGET_TYPE_KEYS;
  const typeKey = typeKeys[widget.type];
  return (
    <div className="rounded-lg border border-border bg-surface-muted">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-caption text-fg-subtle">{typeKey ? t(typeKey) : widget.type}</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          value={widget.title ?? ""}
          placeholder={t("widgetArea.titlePlaceholder")}
          aria-label={t("widgetArea.titleLabel")}
          onChange={(e) => patch({ title: e.target.value || null })}
        />
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title={t("furniture.moveUp")} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title={t("furniture.moveDown")} onClick={() => onMove(1)}>↓</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-danger" title={t("common.remove")} onClick={onRemove}>✕</button>
      </div>
      <div className="p-3.5">
        {widget.type === "content" ? (
          <RichText value={(widget.content as RichTextDoc | null) ?? null} onChange={(content) => patch({ content })} />
        ) : widget.type === "menu" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("widgetArea.menu")}</span>
            <select className={CONTROL} value={widget.menuName ?? ""} onChange={(e) => patch({ menuName: e.target.value })}>
              <option value="">{t("furniture.pickOne")}</option>
              {menus.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
            </select>
          </label>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">{t("widgetArea.componentId")}</span>
              <input className={CONTROL} value={widget.componentId ?? ""} onChange={(e) => patch({ componentId: e.target.value.trim() })} />
            </label>
            <JsonProps value={widget.componentProps} onChange={(componentProps) => patch({ componentProps })} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Props for a `component` widget, edited as JSON.
 *
 * A structured editor is impossible here: the CMS does not know the component, so it does
 * not know its props. The text is kept in local state and only parsed on change, so a
 * half-typed object does not blow away what was there — the parent never sees an invalid
 * value, and the error says so instead of the field silently reverting.
 */
function JsonProps({ value, onChange }: { value: Widget["componentProps"]; onChange: (v: Widget["componentProps"]) => void }) {
  const [text, setText] = useState(() => (value ? JSON.stringify(value, null, 2) : ""));
  const [bad, setBad] = useState(false);
  const { t } = useI18n();
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-subtle">{t("widgetArea.props")}</span>
      <textarea
        className={`${CONTROL} h-auto min-h-24 py-2.5 font-mono text-[12px]`}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (next.trim() === "") { setBad(false); onChange(undefined); return; }
          try {
            const parsed: unknown = JSON.parse(next);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { setBad(true); return; }
            setBad(false);
            onChange(parsed as Widget["componentProps"]);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? <span className="text-caption text-danger">{t("widgetArea.propsInvalid")}</span> : null}
    </label>
  );
}
