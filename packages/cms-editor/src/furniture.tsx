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
import { useUnsavedGuard } from "./app-context";
import type { Api } from "./api";
import { CONTROL, RichText, slugify } from "./fields";
import { ROW, WRAP } from "./chrome";
import { PageHeader } from "./page-header";
import type { CollectionMeta, Menu, MenuItem, MenuItemKind, Page, Redirect, RichTextDoc, Taxonomy, Term, Widget, WidgetArea } from "./types";
import { MAX_MENU_DEPTH, REDIRECT_STATUSES } from "./types";


export function errText(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/** The site-furniture screens' header — the same panel as the library screens, at the
 * quieter type scale these have always used. See `page-header.tsx`. */
function Head(props: { lead: string; em: string; children?: React.ReactNode }) {
  return <PageHeader {...props} size="md" />;
}

function Saved() {
  return <div className="rounded-lg border border-brand-green bg-brand-green/20 px-3.5 py-2.5 text-small text-fg">saved</div>;
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
  return (
    <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
      <Input label="Label" value={label} onChange={onLabel} />
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium text-fg">Key</span>
        <input className={CONTROL} value={keyValue} onChange={(e) => onKey(e.target.value.trim())} />
        <span className="text-caption text-fg-subtle">{keyHint}</span>
      </label>
    </div>
  );
}

// --- menus ----------------------------------------------------------------------------

export function MenusView({ api, onOpen, onError, canEdit }: { api: Api; onOpen: (name: string) => void; onError: (s: string) => void; canEdit: boolean }) {
  const [menus, setMenus] = useState<Menu[] | null>(null);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listMenus().then(setMenus).catch((e) => { setMenus([]); onError(errText(e)); });
  }, [api, onError]);
  useEffect(refresh, [refresh]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createMenu(name, label);
      setLabel(""); setName(""); setNameTouched(false);
      onOpen(created.name);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className={WRAP}>
      <Head lead="Navigation" em={menus === null ? "Menus" : menus.length === 1 ? "1 menu" : `${menus.length} menus`} />
      <div className="flex flex-col gap-2">
        {menus === null ? <p className="text-fg-subtle">Loading…</p> : null}
        {menus?.length === 0 ? <p className="text-fg-subtle">No menus yet. A menu is read by name — <code>getMenu(&quot;primary&quot;)</code> — from your layout.</p> : null}
        {(menus ?? []).map((m) => (
          <div key={m.id} className={`${ROW} cursor-pointer hover:bg-surface-muted`} onClick={() => onOpen(m.name)}>
            <span className="min-w-0 flex-1 truncate font-medium">{m.label}</span>
            <span className="shrink-0 truncate text-fg-subtle">{m.name}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{countItems(m.items ?? [])} item(s)</span>
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[720px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">New menu</Heading>
          <KeyFields
            label={label}
            keyValue={name}
            onLabel={(v) => { setLabel(v); if (!nameTouched) setName(slugify(v)); }}
            onKey={(v) => { setNameTouched(true); setName(v); }}
            keyHint="What your layout asks for. Not renameable afterwards."
          />
          <Button className="mt-3" onPress={create} isDisabled={busy || !label.trim() || !name.trim()}>Create menu</Button>
        </div>
      ) : null}
    </div>
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

export function MenuEditor({ api, name, collections, onBack, onDeleted, onError, canEdit }: {
  api: Api;
  name: string;
  collections: CollectionMeta[];
  onBack: () => void;
  onDeleted: () => void;
  onError: (s: string) => void;
  canEdit: boolean;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
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
      .catch((e) => onError(errText(e)));
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
  }, [api, name, onError]);

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
    if (!menu || !confirm(`Delete the menu “${menu.label}”? Any layout reading it will render nothing.`)) return;
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
  const add = () => setItems([...items, { id: crypto.randomUUID(), label: "New item", kind: "custom", url: "/" }]);

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Unknown menu: {name}</p></div>;
  if (!menu) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Loading…</p></div>;

  return (
    <div className={WRAP}>
      <div className="mb-4 mt-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={onBack}>← Menus</Button>
        <h1 className="text-[22px] font-normal text-fg">{menu.label}</h1>
        <span className="text-fg-subtle">{menu.name}</span>
      </div>
      <div className="flex max-w-[860px] flex-col gap-4">
        {ok ? <Saved /> : null}
        <Input label="Label" value={label} onChange={setLabel} />
        <div className="flex flex-col gap-2">
          {flat.length === 0 ? <p className="text-sm text-fg-subtle">No items yet.</p> : null}
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
            <Button variant="secondary" size="sm" onPress={add}>+ Add item</Button>
            <Button onPress={save} isDisabled={busy}>{busy ? "Saving…" : "Save menu"}</Button>
            <Button variant="ghost" className="text-danger" onPress={del} isDisabled={busy}>Delete menu</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const MENU_KINDS: { value: MenuItemKind; label: string }[] = [
  { value: "custom", label: "A URL" },
  { value: "page", label: "A page" },
  { value: "term", label: "A term" },
  { value: "collection", label: "A collection" },
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
  const kind = item.kind ?? "custom";
  return (
    <div className="rounded-lg border border-border bg-surface-muted p-3.5">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Label</span>
            <input className={CONTROL} value={item.label} onChange={(e) => onPatch({ label: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Points at</span>
            <select
              className={CONTROL}
              value={kind}
              // Changing the kind clears the OTHER kind's target. Keeping both would post a
              // `ref` alongside a `url` and store whichever the server happens to read.
              onChange={(e) => onPatch({ kind: e.target.value as MenuItemKind, ref: null, url: e.target.value === "custom" ? "/" : undefined })}
            >
              {MENU_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
        </div>
        <div className="flex shrink-0 items-start gap-0.5 pt-5">
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title="Move up" onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title="Move down" onClick={() => onMove(1)}>↓</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title="Nest under the item above" disabled={depth + 1 >= MAX_MENU_DEPTH} onClick={onIndent}>→</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title="Move out a level" disabled={depth === 0} onClick={onOutdent}>←</button>
          <button type="button" className="px-1.5 text-fg-subtle hover:text-danger" title="Remove" onClick={onRemove}>✕</button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        {kind === "custom" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">URL</span>
            <input className={CONTROL} value={item.url ?? ""} placeholder="/about or https://…" onChange={(e) => onPatch({ url: e.target.value })} />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Target</span>
            <select className={CONTROL} value={item.ref ?? ""} onChange={(e) => onPatch({ ref: e.target.value || null })}>
              <option value="">— pick one —</option>
              {kind === "page" ? pages.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.slug})</option>) : null}
              {kind === "term" ? terms.map((t) => <option key={t.id} value={t.id}>{t.taxonomy}: {t.label}</option>) : null}
              {kind === "collection" ? collections.map((c) => <option key={c.slug} value={c.slug}>{c.pluralLabel}</option>) : null}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-subtle">Opens in</span>
          <select className={CONTROL} value={item.target ?? ""} onChange={(e) => onPatch({ target: e.target.value || undefined })}>
            <option value="">this tab</option>
            <option value="_blank">a new tab</option>
          </select>
        </label>
      </div>
      {kind !== "custom" && !item.ref ? (
        <p className="mt-2 text-caption text-danger">Pick a target, or this item cannot be saved.</p>
      ) : null}
      {kind !== "custom" ? (
        <p className="mt-2 text-caption text-fg-subtle">
          The URL is worked out when the menu is read, so it follows the target. An item whose target is unpublished or gone is left out of the public menu rather than rendered as a dead link.
        </p>
      ) : null}
    </div>
  );
}

// --- redirects ------------------------------------------------------------------------

export function RedirectsView({ api, onError, canEdit }: { api: Api; onError: (s: string) => void; canEdit: boolean }) {
  const [rows, setRows] = useState<Redirect[] | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState(301);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listRedirects().then(setRows).catch((e) => { setRows([]); onError(errText(e)); });
  }, [api, onError]);
  useEffect(refresh, [refresh]);

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
    if (!confirm(`Delete the redirect from ${r.fromPath}?`)) return;
    try { await api.deleteRedirect(r.id); refresh(); } catch (e) { onError(errText(e)); }
  };

  return (
    <div className={WRAP}>
      <Head lead="Old URLs, kept alive" em={rows === null ? "Redirects" : rows.length === 1 ? "1 redirect" : `${rows.length} redirects`} />
      <p className="mb-4 max-w-[62ch] text-sm text-fg-muted">
        Changing a page&apos;s slug changes a live URL and breaks every link to it. A redirect is how the old one keeps working.
        Disabling one keeps the record of what the old URL was, which deleting it does not.
      </p>
      <div className="flex flex-col gap-2">
        {rows === null ? <p className="text-fg-subtle">Loading…</p> : null}
        {rows?.length === 0 ? <p className="text-fg-subtle">No redirects yet.</p> : null}
        {(rows ?? []).map((r) => (
          <div key={r.id} className={`${ROW} ${r.enabled ? "" : "opacity-60"}`}>
            <span className="min-w-0 flex-1 truncate font-medium">{r.fromPath}</span>
            <span className="shrink-0 text-fg-subtle">→</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">{r.toPath}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{r.status}</span>
            {canEdit ? (
              <>
                <Button variant="ghost" size="sm" onPress={() => patch(r, { enabled: !r.enabled })}>{r.enabled ? "disable" : "enable"}</Button>
                <Button variant="ghost" size="sm" className="text-danger" onPress={() => del(r)}>delete</Button>
              </>
            ) : null}
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[860px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">New redirect</Heading>
          <div className="grid grid-cols-[1fr_1fr_auto] gap-3 max-[720px]:grid-cols-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">From (a path on this site)</span>
              <input className={CONTROL} value={from} placeholder="/old-page" onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">To (a path, or a full URL)</span>
              <input className={CONTROL} value={to} placeholder="/new-page" onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">Status</span>
              <select className={CONTROL} value={status} onChange={(e) => setStatus(Number(e.target.value))}>
                {REDIRECT_STATUSES.map((s) => <option key={s} value={s}>{s}{s === 301 || s === 308 ? " permanent" : " temporary"}</option>)}
              </select>
            </label>
          </div>
          <Button className="mt-3" onPress={create} isDisabled={busy || !from.trim() || !to.trim()}>Add redirect</Button>
        </div>
      ) : null}
    </div>
  );
}

// --- taxonomies -----------------------------------------------------------------------

export function TaxonomiesView({ api, onOpen, onError, canEdit }: { api: Api; onOpen: (slug: string) => void; onError: (s: string) => void; canEdit: boolean }) {
  const [taxa, setTaxa] = useState<Taxonomy[] | null>(null);
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [hierarchical, setHierarchical] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listTaxonomies().then(setTaxa).catch((e) => { setTaxa([]); onError(errText(e)); });
  }, [api, onError]);
  useEffect(refresh, [refresh]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createTaxonomy({ slug, label, hierarchical });
      setLabel(""); setSlug(""); setSlugTouched(false); setHierarchical(false);
      onOpen(created.slug);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className={WRAP}>
      <Head lead="How this site" em="is classified" />
      <p className="mb-4 max-w-[62ch] text-sm text-fg-muted">
        A vocabulary is a way of grouping pages — categories, tags, regions. There are no built-in ones:
        a deployment declares what it sorts by, the same way it declares its content types.
      </p>
      <div className="flex flex-col gap-2">
        {taxa === null ? <p className="text-fg-subtle">Loading…</p> : null}
        {taxa?.length === 0 ? <p className="text-fg-subtle">No vocabularies yet.</p> : null}
        {(taxa ?? []).map((t) => (
          <div key={t.id} className={`${ROW} cursor-pointer hover:bg-surface-muted`} onClick={() => onOpen(t.slug)}>
            <span className="min-w-0 flex-1 truncate font-medium">{t.label}</span>
            <span className="shrink-0 truncate text-fg-subtle">{t.slug}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{t.hierarchical ? "nested" : "flat"}</span>
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[720px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">New vocabulary</Heading>
          <KeyFields
            label={label}
            keyValue={slug}
            onLabel={(v) => { setLabel(v); if (!slugTouched) setSlug(slugify(v)); }}
            onKey={(v) => { setSlugTouched(true); setSlug(v); }}
            keyHint="A URL segment — terms live under it. Not renameable afterwards."
          />
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" checked={hierarchical} onChange={(e) => setHierarchical(e.target.checked)} />
            <span className="text-sm text-fg">Terms can nest (categories rather than tags)</span>
          </label>
          <Button className="mt-3" onPress={create} isDisabled={busy || !label.trim() || !slug.trim()}>Create vocabulary</Button>
        </div>
      ) : null}
    </div>
  );
}

export function TaxonomyEditor({ api, slug, onBack, onDeleted, onError, canEdit }: {
  api: Api;
  slug: string;
  onBack: () => void;
  onDeleted: () => void;
  onError: (s: string) => void;
  canEdit: boolean;
}) {
  const [tax, setTax] = useState<Taxonomy | null>(null);
  const [tree, setTree] = useState<Term[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [termLabel, setTermLabel] = useState("");
  const [termSlug, setTermSlug] = useState("");
  const [termSlugTouched, setTermSlugTouched] = useState(false);
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);

  const refreshTerms = useCallback(() => {
    api.getTermTree(slug).then(setTree).catch((e) => { setTree([]); onError(errText(e)); });
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
      .catch((e) => onError(errText(e)));
    return () => { live = false; };
  }, [api, slug, onError]);
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
    if (!confirm(`Delete “${t.label}”? Pages tagged with it lose the tag; any terms under it move to the top level.`)) return;
    try { await api.deleteTerm(t.id); refreshTerms(); } catch (e) { onError(errText(e)); }
  };
  const renameTerm = async (t: Term, label: string) => {
    if (label === t.label) return;
    try { await api.updateTerm(t.id, { label }); refreshTerms(); } catch (e) { onError(errText(e)); }
  };
  const delTaxonomy = async () => {
    if (!tax || !confirm(`Delete the vocabulary “${tax.label}”? Every term in it goes too, along with every page's assignments.`)) return;
    try { await api.deleteTaxonomy(tax.id); onDeleted(); } catch (e) { onError(errText(e)); }
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Unknown vocabulary: {slug}</p></div>;
  if (!tax) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Loading…</p></div>;

  return (
    <div className={WRAP}>
      <div className="mb-4 mt-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={onBack}>← Taxonomies</Button>
        <h1 className="text-[22px] font-normal text-fg">{tax.label}</h1>
        <span className="text-fg-subtle">{tax.slug}</span>
      </div>
      <div className="flex max-w-[860px] flex-col gap-4">
        <div className="flex flex-col gap-2">
          {tree === null ? <p className="text-fg-subtle">Loading…</p> : null}
          {tree?.length === 0 ? <p className="text-fg-subtle">No terms yet.</p> : null}
          {flat.map(({ term, depth }) => (
            <div key={term.id} className={ROW} style={{ marginLeft: depth * 24 }}>
              <input
                className={`${CONTROL} flex-1`}
                defaultValue={term.label}
                aria-label={`Label for ${term.label}`}
                disabled={!canEdit}
                // Committed on blur, not per keystroke: each save is a round trip, and a
                // rename mid-word would land a term called "Ne".
                onBlur={(e) => renameTerm(term, e.target.value.trim())}
              />
              <span className="shrink-0 truncate text-fg-subtle">{term.slug}</span>
              {canEdit ? <Button variant="ghost" size="sm" className="text-danger" onPress={() => delTerm(term)}>delete</Button> : null}
            </div>
          ))}
        </div>

        {canEdit ? (
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <Heading level="2" className="mb-3 font-normal">New term</Heading>
            <KeyFields
              label={termLabel}
              keyValue={termSlug}
              onLabel={(v) => { setTermLabel(v); if (!termSlugTouched) setTermSlug(slugify(v)); }}
              onKey={(v) => { setTermSlugTouched(true); setTermSlug(v); }}
              keyHint="The URL segment for this term."
            />
            {tax.hierarchical ? (
              <label className="mt-3 flex flex-col gap-1.5">
                <span className="text-caption text-fg-subtle">Nested under</span>
                <select className={CONTROL} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">— top level —</option>
                  {flat.map(({ term, depth }) => <option key={term.id} value={term.id}>{"— ".repeat(depth)}{term.label}</option>)}
                </select>
              </label>
            ) : null}
            <Button className="mt-3" onPress={addTerm} isDisabled={busy || !termLabel.trim() || !termSlug.trim()}>Add term</Button>
          </div>
        ) : null}

        {canEdit ? <Button variant="ghost" className="self-start text-danger" onPress={delTaxonomy}>Delete this vocabulary</Button> : null}
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
  const [areas, setAreas] = useState<WidgetArea[] | null>(null);
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.listWidgetAreas().then(setAreas).catch((e) => { setAreas([]); onError(errText(e)); });
  }, [api, onError]);
  useEffect(refresh, [refresh]);

  const create = async () => {
    setBusy(true);
    try {
      const created = await api.createWidgetArea(name, label);
      setLabel(""); setName(""); setNameTouched(false);
      onOpen(created.name);
    } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className={WRAP}>
      <Head lead="Parts of the layout" em="you can fill in" />
      <p className="mb-4 max-w-[62ch] text-sm text-fg-muted">
        A widget area is a named slot in your layout — a sidebar, a footer column — that an editor fills without touching code.
        Your layout reads one by name: <code>getWidgetArea(&quot;sidebar&quot;)</code>.
      </p>
      <div className="flex flex-col gap-2">
        {areas === null ? <p className="text-fg-subtle">Loading…</p> : null}
        {areas?.length === 0 ? <p className="text-fg-subtle">No widget areas yet.</p> : null}
        {(areas ?? []).map((a) => (
          <div key={a.id} className={`${ROW} cursor-pointer hover:bg-surface-muted`} onClick={() => onOpen(a.name)}>
            <span className="min-w-0 flex-1 truncate font-medium">{a.label}</span>
            <span className="shrink-0 truncate text-fg-subtle">{a.name}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{(a.widgets ?? []).length} widget(s)</span>
          </div>
        ))}
      </div>
      {canEdit ? (
        <div className="mt-6 max-w-[720px] rounded-lg border border-border bg-surface-muted p-4">
          <Heading level="2" className="mb-3 font-normal">New widget area</Heading>
          <KeyFields
            label={label}
            keyValue={name}
            onLabel={(v) => { setLabel(v); if (!nameTouched) setName(slugify(v)); }}
            onKey={(v) => { setNameTouched(true); setName(v); }}
            keyHint="What your layout asks for. Not renameable afterwards."
          />
          <Button className="mt-3" onPress={create} isDisabled={busy || !label.trim() || !name.trim()}>Create widget area</Button>
        </div>
      ) : null}
    </div>
  );
}

export function WidgetAreaEditor({ api, name, onBack, onDeleted, onError, canEdit }: {
  api: Api;
  name: string;
  onBack: () => void;
  onDeleted: () => void;
  onError: (s: string) => void;
  canEdit: boolean;
}) {
  const [area, setArea] = useState<WidgetArea | null>(null);
  const [label, setLabel] = useState("");
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [baseline, setBaseline] = useState("");
  useUnsavedGuard(area !== null && JSON.stringify({ label, widgets }) !== baseline);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [missing, setMissing] = useState(false);
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
      .catch((e) => onError(errText(e)));
    api.listMenus().then((r) => live && setMenus(r)).catch(() => setMenus([]));
    return () => { live = false; };
  }, [api, name, onError]);

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
    if (!area || !confirm(`Delete the widget area “${area.label}”?`)) return;
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

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Unknown widget area: {name}</p></div>;
  if (!area) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Loading…</p></div>;

  return (
    <div className={WRAP}>
      <div className="mb-4 mt-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={onBack}>← Widgets</Button>
        <h1 className="text-[22px] font-normal text-fg">{area.label}</h1>
        <span className="text-fg-subtle">{area.name}</span>
      </div>
      <div className="flex max-w-[860px] flex-col gap-4">
        {ok ? <Saved /> : null}
        <Input label="Label" value={label} onChange={setLabel} />
        <div className="flex flex-col gap-2">
          {widgets.length === 0 ? <p className="text-sm text-fg-subtle">No widgets yet.</p> : null}
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
            <Button variant="secondary" size="sm" onPress={() => setWidgets([...widgets, { id: crypto.randomUUID(), type: "content", content: { type: "doc", content: [] } }])}>+ Text</Button>
            <Button variant="secondary" size="sm" onPress={() => setWidgets([...widgets, { id: crypto.randomUUID(), type: "menu", menuName: menus[0]?.name ?? "" }])}>+ Menu</Button>
            <Button variant="secondary" size="sm" onPress={() => setWidgets([...widgets, { id: crypto.randomUUID(), type: "component", componentId: "" }])}>+ Component</Button>
            <Button onPress={save} isDisabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button variant="ghost" className="text-danger" onPress={del} isDisabled={busy}>Delete area</Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WidgetRow({ widget, menus, onChange, onMove, onRemove }: {
  widget: Widget;
  menus: Menu[];
  onChange: (w: Widget) => void;
  onMove: (d: number) => void;
  onRemove: () => void;
}) {
  const patch = (p: Partial<Widget>) => onChange({ ...widget, ...p });
  return (
    <div className="rounded-lg border border-border bg-surface-muted">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-caption text-fg-subtle">{widget.type}</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
          value={widget.title ?? ""}
          placeholder="Title (optional)"
          aria-label="Widget title"
          onChange={(e) => patch({ title: e.target.value || null })}
        />
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title="Move up" onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg" title="Move down" onClick={() => onMove(1)}>↓</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-danger" title="Remove" onClick={onRemove}>✕</button>
      </div>
      <div className="p-3.5">
        {widget.type === "content" ? (
          <RichText value={(widget.content as RichTextDoc | null) ?? null} onChange={(content) => patch({ content })} />
        ) : widget.type === "menu" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Menu</span>
            <select className={CONTROL} value={widget.menuName ?? ""} onChange={(e) => patch({ menuName: e.target.value })}>
              <option value="">— pick one —</option>
              {menus.map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
            </select>
          </label>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">Component id — your front end maps this to one of its own components</span>
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
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-subtle">Props (JSON object, optional)</span>
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
      {bad ? <span className="text-caption text-danger">Not a JSON object — the last valid value is what will be saved.</span> : null}
    </label>
  );
}
