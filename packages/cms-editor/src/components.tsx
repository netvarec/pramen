// Presentational + interactive pieces of the editor, shared across route files. The
// route modules under `routes/` are thin adapters: they pull `api`/`me`/`setError` from
// the app context and wire URL params + navigation into these components.

import { Button, Input, Textarea } from "@podoba/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Api, ApiError } from "./api";
import { FieldForm } from "./fields";
import type { Config } from "./api";
import type { Me } from "./app-context";
import type { AssembledPage, AuditEntry, BlockType, ContentType, FieldDefinition, Media, Page, RegionDefinition, RenderedBlock } from "./types";

export type InspectorTab = "settings" | "seo" | "workflow" | "i18n" | "audit";
export const INSPECTOR_TABS: InspectorTab[] = ["settings", "seo", "workflow", "i18n", "audit"];

// --- presentational primitives (podoba tokens; replaces styles.ts classes) ---

const ROW = "flex items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5";
const WRAP = "mx-auto max-w-[1200px] px-7 pb-8 pt-2";

function Hero({ lead, em, children }: { lead: string; em: string; children?: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[1200px] grid-cols-[1fr_auto] items-center gap-6 px-7 pb-6 pt-8 max-[820px]:grid-cols-1">
      <h1 className="m-0 text-[56px] font-normal leading-[1.05] tracking-[-0.01em] max-[820px]:text-[40px]">
        <span className="block text-fg-subtle">{lead}</span>
        <span className="block text-fg">{em}</span>
      </h1>
      {children}
    </div>
  );
}

function Cta({ text, em, children }: { text: string; em: string; children: ReactNode }) {
  return (
    <div className="flex min-w-[360px] items-center gap-4 rounded-full bg-brand-green py-3 pl-7 pr-3 max-[820px]:min-w-0">
      <span className="text-lg text-[#0f3a25]">
        {text} <span className="font-semibold">{em}</span>
      </span>
      {children}
    </div>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-[18px] text-sm text-fg-subtle first:mt-0">{children}</div>;
}

function Pill({ status, children }: { status?: string; children: ReactNode }) {
  const tone =
    status === "published" || status === "active"
      ? "bg-brand-green text-[#0f3a25] border-transparent"
      : status === "in_review" || status === "review"
        ? "bg-accent-yellow text-[#4a3512] border-transparent"
        : status === "rejected" || status === "archived" || status === "inactive"
          ? "border-danger text-danger bg-surface-card"
          : "border-border text-fg-muted bg-surface-card";
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tone}`}>{children}</span>;
}

function Modal({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,15,5,0.28)] p-6" onClick={onClose}>
      <div
        className={`max-h-[86vh] w-full overflow-auto rounded-panel border border-border bg-surface-card px-9 py-8 shadow-[0_24px_60px_rgba(30,20,10,0.12)] ${wide ? "max-w-[680px]" : "max-w-[520px]"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ModalTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-5 text-[28px] font-normal leading-[1.15] text-fg">{children}</h2>;
}

function KV({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-2 text-[13px] text-fg-muted [&>span:nth-child(odd)]:text-fg-subtle ${className ?? ""}`}>{children}</div>;
}

function Card({ children }: { children: ReactNode }) {
  return <div className="overflow-auto rounded-panel border border-border bg-surface-card p-6">{children}</div>;
}

function Banner({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <div className={`my-2 rounded-lg border px-3.5 py-2.5 text-[13px] ${ok ? "border-brand-green bg-brand-green/20 text-[#0f3a25]" : "border-danger bg-surface-card text-danger"}`}>{children}</div>
  );
}

const Dim = ({ children }: { children: ReactNode }) => <span className="text-fg-subtle">{children}</span>;

// --- pages list --------------------------------------------------------------

export function PageList({ api, pages, blockTypes, onOpen, onCreated, onError }: { api: Api; pages: Page[]; blockTypes: BlockType[]; onOpen: (p: Page) => void; onCreated: () => void; onError: (s: string) => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Hero lead="Pages" em={pages.length === 0 ? "None yet" : pages.length === 1 ? "1 page total" : `${pages.length} pages total`}>
        <Cta text="Let's" em="create something">
          <Button className="shrink-0" onPress={() => setCreating(true)}>+ New page</Button>
        </Cta>
      </Hero>
      <div className={WRAP}>
        <div className="flex flex-col gap-2">
          {pages.map((p) => (
            <div className={`${ROW} cursor-pointer hover:bg-surface-muted`} key={p.id} onClick={() => onOpen(p)}>
              <span className="flex-1 truncate font-medium">{p.title}</span>
              <span className="text-fg-subtle">/{p.slug}</span>
              <span className="text-fg-subtle">{p.locale}</span>
              <Pill status={p.status}>{p.status}</Pill>
            </div>
          ))}
          {pages.length === 0 ? <p className="text-fg-subtle">No pages yet. {blockTypes.length === 0 ? "Define block types + a content type first (via the API/admin)." : "Create one."}</p> : null}
        </div>
      </div>
      {creating ? <CreatePage api={api} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); onCreated(); }} onError={onError} /> : null}
    </>
  );
}

function CreatePage({ api, onClose, onCreated, onError }: { api: Api; onClose: () => void; onCreated: () => void; onError: (s: string) => void }) {
  const [cts, setCts] = useState<ContentType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  useEffect(() => {
    api.listContentTypes().then((r) => { setCts(r); if (r[0]) setTypeId(r[0].id); }).catch((e) => onError(errMsg(e)));
  }, [api, onError]);
  const create = async () => {
    try {
      await api.call("createPage", { typeId, title, slug: slug || slugify(title) });
      onCreated();
    } catch (e) {
      onError(errMsg(e));
    }
  };
  return (
    <Modal onClose={onClose}>
      <ModalTitle>Create a <Dim>new page</Dim> and define the essentials<Dim>.</Dim></ModalTitle>
      <div className="flex flex-col gap-4">
        <label className="flex w-full flex-col gap-2">
          <span className="text-sm font-medium text-fg">Content type</span>
          <select className="h-10 w-full rounded-lg border border-border bg-surface-card px-4 text-sm text-fg outline-none focus:border-brand-green" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {cts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
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

// --- page editor -------------------------------------------------------------

export function PageEditor({ api, page, blockTypes, tab, onTab, onBack, onChange }: { api: Api; page: Page; blockTypes: BlockType[]; tab: InspectorTab; onTab: (t: InspectorTab) => void; onBack: () => void; onChange: (p: Page) => void }) {
  const [ct, setCt] = useState<ContentType | null>(null);
  const [assembled, setAssembled] = useState<AssembledPage | null>(null);
  const [selected, setSelected] = useState<RenderedBlock | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

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
  useEffect(() => {
    reload();
    setSelected(null);
  }, [reload]);

  const regions: RegionDefinition[] = ct?.regions ?? [];
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(""), 1800); };

  const addBlock = async (region: string, slug: string) => {
    try {
      await api.call("addBlock", { pageId: page.id, blockTypeSlug: slug, region, fields: {} });
      await reload();
      flash("block added");
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const removeBlock = async (b: RenderedBlock) => {
    try {
      await api.call("removeBlock", { pageBlockId: b.id });
      if (selected?.id === b.id) setSelected(null);
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

  return (
    <div className="grid min-h-[calc(100vh-68px)] grid-cols-[260px_1fr_400px] gap-5 px-7 pb-7 pt-2 max-[820px]:grid-cols-1">
      <div className="overflow-auto rounded-panel bg-surface-muted p-[18px]">
        <Button variant="ghost" size="sm" onPress={onBack}>← all pages</Button>
        <Section>Regions</Section>
        {regions.map((r) => (
          <div key={r.name} className={`${ROW} mb-2`}>
            <span className="flex-1 truncate font-medium">{r.label ?? r.name}</span>
            <span className="text-fg-subtle">{(assembled?.regions[r.name] ?? []).length}</span>
          </div>
        ))}
        <Section>Status</Section>
        <div className={ROW}>
          <span className="flex-1 truncate font-medium">{page.title}</span>
          <Pill status={page.status}>{page.status}</Pill>
        </div>
      </div>

      <div className="overflow-auto py-1.5">
        {err ? <Banner>{err}</Banner> : null}
        {msg ? <Banner ok>{msg}</Banner> : null}
        {regions.map((r) => {
          const blocks = assembled?.regions[r.name] ?? [];
          const allowed = r.allowedTypes && r.allowedTypes.length ? r.allowedTypes : blockTypes.map((b) => b.slug);
          return (
            <div className="mb-6" key={r.name}>
              <h3 className="m-0 mb-3 flex items-baseline gap-3 text-[22px] font-normal text-fg">
                {r.label ?? r.name}
                {r.allowedTypes ? <span className="text-[11px] font-normal text-fg-subtle">only: {r.allowedTypes.join(", ")}</span> : null}
              </h3>
              {blocks.map((b, i) => (
                <div className={`mb-2.5 rounded-panel border bg-surface-card p-3.5 ${selected?.id === b.id ? "border-fg" : "border-border"}`} key={b.id} onClick={() => setSelected(b)}>
                  <div className="flex items-center gap-2.5">
                    <span className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg-muted">{b.block_type}</span>
                    {b.is_shared ? <span className="text-[11px] text-accent-strong">shared</span> : null}
                    <span className="flex-1 truncate text-fg-subtle">{summarize(b.fields)}</span>
                    <Button variant="ghost" size="sm" onPress={() => reorderMove(blocks, r.name, i, -1, reorder)}>↑</Button>
                    <Button variant="ghost" size="sm" onPress={() => reorderMove(blocks, r.name, i, 1, reorder)}>↓</Button>
                    <Button variant="ghost" size="sm" className="text-danger" onPress={() => removeBlock(b)}>✕</Button>
                  </div>
                </div>
              ))}
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {allowed.map((slug) => (
                  <Button key={slug} variant="secondary" size="sm" onPress={() => addBlock(r.name, slug)}>+ {btBySlug.get(slug)?.name ?? slug}</Button>
                ))}
              </div>
            </div>
          );
        })}
        {regions.length === 0 ? <p className="text-fg-subtle">This page's content type has no regions.</p> : null}
      </div>

      <div className="overflow-auto rounded-panel border border-border bg-surface-card p-5">
        {selected ? (
          <BlockInspector api={api} block={selected} blockType={btBySlug.get(selected.block_type)} onClose={() => setSelected(null)} onSaved={reload} onError={setErr} />
        ) : (
          <>
            <div className="mb-3 flex gap-1">
              {INSPECTOR_TABS.map((t) => (
                <Button key={t} variant="ghost" size="sm" className={tab === t ? "bg-surface-muted text-fg" : "text-fg-muted"} onPress={() => onTab(t)}>{t}</Button>
              ))}
            </div>
            {tab === "settings" ? <Settings page={page} /> : null}
            {tab === "seo" ? <SeoPanel api={api} page={page} onError={setErr} /> : null}
            {tab === "workflow" ? <Workflow api={api} page={page} onChanged={(p) => { onChange(p); }} onError={setErr} /> : null}
            {tab === "i18n" ? <I18n api={api} page={page} onError={setErr} /> : null}
            {tab === "audit" ? <AuditLog api={api} pageId={page.id} onError={setErr} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function BlockInspector({ api, block, blockType, onClose, onSaved, onError }: { api: Api; block: RenderedBlock; blockType: BlockType | undefined; onClose: () => void; onSaved: () => void; onError: (s: string) => void }) {
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Load RAW fields (media as ids) for editing.
    api.call<{ fields?: Record<string, unknown> }>("getBlock", { blockId: block.block_id }).then((b) => setFields(b?.fields ?? {})).catch((e) => onError(errMsg(e)));
  }, [api, block.block_id, onError]);
  const schema: FieldDefinition[] = blockType?.fieldsSchema ?? [];
  const save = async () => {
    setBusy(true);
    try {
      await api.call("updateBlock", { blockId: block.block_id, fields });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg-muted">{block.block_type}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onPress={onClose}>done</Button>
      </div>
      {schema.length === 0 ? <p className="text-fg-subtle">This block type has no fields.</p> : <FieldForm schema={schema} value={fields} onChange={setFields} api={api} />}
      <Button className="mt-3 w-full" onPress={save} isDisabled={busy}>Save block</Button>
    </div>
  );
}

function Settings({ page }: { page: Page }) {
  // The core CMS API doesn't expose a general page-rename handler; keep this read-only +
  // link the essentials. (A future `updatePage` handler would back editable title/slug.)
  return (
    <KV>
      <span>Title</span>
      <span>{page.title}</span>
      <span>Slug</span>
      <span>/{page.slug}</span>
      <span>Locale</span>
      <span>{page.locale}</span>
      <span>Status</span>
      <span>{page.status}</span>
    </KV>
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

function Workflow({ api, page, onChanged, onError }: { api: Api; page: Page; onChanged: (p: Page) => void; onError: (s: string) => void }) {
  const act = async (name: string, input?: unknown) => {
    try {
      const r = await api.call<{ page?: Page }>(name, { pageId: page.id, ...(input as object) });
      if (r?.page) onChanged(r.page);
    } catch (e) {
      onError(errMsg(e));
    }
  };
  return (
    <div>
      <Section>Workflow</Section>
      <div className="mb-3 flex items-center gap-2 text-[13px] text-fg-muted">
        <span className="text-fg-subtle">Status</span>
        <Pill status={page.status}>{page.status}</Pill>
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="secondary" onPress={() => act("submitForReview")}>Submit for review</Button>
        <Button onPress={() => act("approve")}>Approve (publish)</Button>
        <Button variant="secondary" onPress={() => act("reject")}>Reject</Button>
        <Button variant="secondary" onPress={() => act("publishPage")}>Publish directly</Button>
        <Button variant="ghost" onPress={() => act("unpublishPage")}>Unpublish</Button>
      </div>
      <p className="mt-2.5 text-fg-subtle">Submit is editor-gated; approve/publish are reviewer-gated.</p>
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

// --- media library (a top-level view: browse, upload, edit alt, delete) ---
const PAGE_SIZE = 60;

export function MediaLibrary({ api, onError }: { api: Api; onError: (s: string) => void }) {
  const [media, setMedia] = useState<Media[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Media | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (off: number) => {
      api
        .listMedia(PAGE_SIZE, off)
        .then((rows) => {
          setMedia((prev) => (off === 0 ? rows : [...prev, ...rows]));
          setHasMore(rows.length === PAGE_SIZE);
          setOffset(off + rows.length);
        })
        .catch((e) => onError(errMsg(e)));
    },
    [api, onError],
  );
  useEffect(() => { load(0); }, [load]);

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
        <Cta text="Let's" em="upload something">
          <label className={`inline-flex shrink-0 cursor-pointer items-center rounded-full bg-surface-inverted px-6 py-3 text-compact text-fg-inverted ${busy ? "pointer-events-none opacity-50" : ""}`}>
            {busy ? "Uploading…" : "+ Upload"}
            <input type="file" multiple hidden disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
          </label>
        </Cta>
      </Hero>
      <div className={WRAP}>
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
        {selected ? (
          <MediaDetail
            api={api}
            media={selected}
            onClose={() => setSelected(null)}
            onSaved={(m) => { setSelected(m); setMedia((prev) => prev.map((x) => (x.id === m.id ? m : x))); }}
            onDeleted={(id) => { setSelected(null); setMedia((prev) => prev.filter((x) => x.id !== id)); }}
            onError={onError}
          />
        ) : null}
      </div>
    </>
  );
}

function MediaDetail({ api, media, onClose, onSaved, onDeleted, onError }: { api: Api; media: Media; onClose: () => void; onSaved: (m: Media) => void; onDeleted: (id: string) => void; onError: (s: string) => void }) {
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
    if (!confirm("Delete this file permanently? If a block or page still references it, that image will break — this cannot be undone.")) return;
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
    <Modal onClose={onClose} wide>
      <ModalTitle><Dim>Media</Dim> {media.file.filename ?? ""}</ModalTitle>
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
        <Cta text="Let's" em="invite someone">
          <Button className="shrink-0" onPress={() => setInviting(true)}>+ Invite</Button>
        </Cta>
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
    <Modal onClose={onClose}>
      <ModalTitle>Invite an <Dim>editor</Dim> or teammate</ModalTitle>
      <p className="-mt-2 mb-4 text-fg-subtle">They&apos;ll get a one-time magic link that logs them in and creates their account.</p>
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
function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function summarize(fields: Record<string, unknown>): string {
  const first = Object.values(fields).find((v) => typeof v === "string" && v);
  return typeof first === "string" ? (first.length > 48 ? first.slice(0, 48) + "…" : first) : "";
}
function reorderMove(blocks: RenderedBlock[], region: string, i: number, d: number, reorder: (region: string, order: string[]) => void) {
  const j = i + d;
  if (j < 0 || j >= blocks.length) return;
  const ids = blocks.map((b) => b.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  reorder(region, ids);
}
