// The CMS visual editor. Left: page list. Center: region canvas (blocks per region, add
// from a palette filtered by allowedTypes, reorder, remove, select). Right: the selected
// block's schema-driven field form, or page settings (Settings / SEO / Workflow / i18n /
// Audit). All mutations go through the semantic CMS handlers (validation/publish enforced).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, ApiError, loadConfig, saveConfig, type Config } from "./api";
import { FieldForm } from "./fields";
import type { AssembledPage, AuditEntry, BlockType, ContentType, FieldDefinition, Page, RegionDefinition, RenderedBlock } from "./types";

export function App() {
  const [cfg, setCfg] = useState<Config>(loadConfig());
  const api = useMemo(() => new Api(cfg), [cfg]);
  const configured = cfg.baseUrl && cfg.token;
  if (!configured) return <Setup cfg={cfg} onSave={(c) => { saveConfig(c); setCfg(c); }} />;
  return <Editor api={api} cfg={cfg} onReconfigure={() => setCfg({ ...cfg, token: "" })} />;
}

function Setup({ cfg, onSave }: { cfg: Config; onSave: (c: Config) => void }) {
  const [c, setC] = useState(cfg);
  return (
    <div className="setup">
      <h1>
        pramen <span className="dim">· cms editor</span>
      </h1>
      <p className="muted">Point at your Worker and paste an editor/reviewer JWT. CORS must allow this origin (`CORS_ORIGINS`).</p>
      <label className="field">
        <span className="lbl">Worker base URL</span>
        <input value={c.baseUrl} onChange={(e) => setC({ ...c, baseUrl: e.target.value })} placeholder="https://your-worker.workers.dev" />
      </label>
      <label className="field">
        <span className="lbl">Tenant</span>
        <input value={c.tenant} onChange={(e) => setC({ ...c, tenant: e.target.value })} placeholder="main" />
      </label>
      <label className="field">
        <span className="lbl">Bearer token (editor or reviewer)</span>
        <input value={c.token} onChange={(e) => setC({ ...c, token: e.target.value })} placeholder="eyJ…" />
      </label>
      <button className="primary" onClick={() => onSave(c)} disabled={!c.baseUrl || !c.token}>
        Connect
      </button>
    </div>
  );
}

function Editor({ api, cfg, onReconfigure }: { api: Api; cfg: Config; onReconfigure: () => void }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
  const [current, setCurrent] = useState<Page | null>(null);
  const [err, setErr] = useState("");

  const refreshPages = useCallback(() => {
    api.listPages().then(setPages).catch((e) => setErr(errMsg(e)));
  }, [api]);
  useEffect(() => {
    refreshPages();
    api.listBlockTypes().then(setBlockTypes).catch((e) => setErr(errMsg(e)));
  }, [api, refreshPages]);

  return (
    <>
      <div className="bar">
        <span className="brand">
          pramen <span className="dim">· cms</span>
        </span>
        <span className="crumb">
          {current ? (
            <>
              <a onClick={() => setCurrent(null)}>Pages</a> / <b>{current.title}</b>
            </>
          ) : (
            <b>Pages</b>
          )}
        </span>
        <span className="grow" />
        <span className="muted">{cfg.tenant}</span>
        <button className="ghost sm" onClick={onReconfigure}>
          sign out
        </button>
      </div>
      {err ? <div className="banner err">{err}</div> : null}
      {current ? (
        <PageEditor api={api} page={current} blockTypes={blockTypes} onBack={() => { setCurrent(null); refreshPages(); }} onChange={(p) => setCurrent(p)} />
      ) : (
        <PageList api={api} pages={pages} blockTypes={blockTypes} onOpen={setCurrent} onCreated={refreshPages} onError={setErr} />
      )}
    </>
  );
}

function PageList({ api, pages, blockTypes, onOpen, onCreated, onError }: { api: Api; pages: Page[]; blockTypes: BlockType[]; onOpen: (p: Page) => void; onCreated: () => void; onError: (s: string) => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <div style={{ padding: 20, maxWidth: 780, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Pages</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + New page
        </button>
      </div>
      <div className="list">
        {pages.map((p) => (
          <div className="row" key={p.id} onClick={() => onOpen(p)}>
            <span className="grow">{p.title}</span>
            <span className="muted">/{p.slug}</span>
            <span className="muted">{p.locale}</span>
            <span className={`pill ${p.status}`}>{p.status}</span>
          </div>
        ))}
        {pages.length === 0 ? <p className="muted">No pages yet. {blockTypes.length === 0 ? "Define block types + a content type first (via the API/admin)." : "Create one."}</p> : null}
      </div>
      {creating ? <CreatePage api={api} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); onCreated(); }} onError={onError} /> : null}
    </div>
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
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New page</h2>
        <label className="field">
          <span className="lbl">Content type</span>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {cts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="lbl">Slug</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(title)} />
        </label>
        <div style={{ textAlign: "right", marginTop: 10 }}>
          <button className="ghost" onClick={onClose}>
            cancel
          </button>{" "}
          <button className="primary" onClick={create} disabled={!typeId || !title}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function PageEditor({ api, page, blockTypes, onBack, onChange }: { api: Api; page: Page; blockTypes: BlockType[]; onBack: () => void; onChange: (p: Page) => void }) {
  const [ct, setCt] = useState<ContentType | null>(null);
  const [assembled, setAssembled] = useState<AssembledPage | null>(null);
  const [selected, setSelected] = useState<RenderedBlock | null>(null);
  const [tab, setTab] = useState<"settings" | "seo" | "workflow" | "i18n" | "audit">("settings");
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
    <div className="layout">
      <div className="side">
        <button className="ghost sm" onClick={onBack}>
          ← all pages
        </button>
        <div className="sect">Regions</div>
        {regions.map((r) => (
          <div key={r.name} className="row" style={{ cursor: "default" }}>
            <span className="grow">{r.label ?? r.name}</span>
            <span className="muted">{(assembled?.regions[r.name] ?? []).length}</span>
          </div>
        ))}
        <div className="sect">Status</div>
        <div className="row" style={{ cursor: "default" }}>
          <span className="grow">{page.title}</span>
          <span className={`pill ${page.status}`}>{page.status}</span>
        </div>
      </div>

      <div className="canvas">
        {err ? <div className="banner err">{err}</div> : null}
        {msg ? <div className="banner ok">{msg}</div> : null}
        {regions.map((r) => {
          const blocks = assembled?.regions[r.name] ?? [];
          const allowed = r.allowedTypes && r.allowedTypes.length ? r.allowedTypes : blockTypes.map((b) => b.slug);
          return (
            <div className="region" key={r.name}>
              <h3>
                {r.label ?? r.name}
                {r.allowedTypes ? <span className="allow">only: {r.allowedTypes.join(", ")}</span> : null}
              </h3>
              {blocks.map((b, i) => (
                <div className={`block ${selected?.id === b.id ? "selected" : ""}`} key={b.id} onClick={() => setSelected(b)}>
                  <div className="bhead">
                    <span className="btype">{b.block_type}</span>
                    {b.is_shared ? <span className="shared">shared</span> : null}
                    <span className="grow muted">{summarize(b.fields)}</span>
                    <button className="ghost sm" onClick={(e) => { e.stopPropagation(); reorderMove(blocks, r.name, i, -1, reorder); }}>
                      ↑
                    </button>
                    <button className="ghost sm" onClick={(e) => { e.stopPropagation(); reorderMove(blocks, r.name, i, 1, reorder); }}>
                      ↓
                    </button>
                    <button className="ghost sm danger" onClick={(e) => { e.stopPropagation(); removeBlock(b); }}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              <div className="palette">
                {allowed.map((slug) => (
                  <button key={slug} className="sm" onClick={() => addBlock(r.name, slug)}>
                    + {btBySlug.get(slug)?.name ?? slug}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {regions.length === 0 ? <p className="muted">This page's content type has no regions.</p> : null}
      </div>

      <div className="inspect">
        {selected ? (
          <BlockInspector api={api} block={selected} blockType={btBySlug.get(selected.block_type)} onClose={() => setSelected(null)} onSaved={reload} onError={setErr} />
        ) : (
          <>
            <div className="tabs">
              {(["settings", "seo", "workflow", "i18n", "audit"] as const).map((t) => (
                <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            {tab === "settings" ? <Settings api={api} page={page} onSaved={onChange} onError={setErr} /> : null}
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
      <div style={{ display: "flex", alignItems: "center" }}>
        <b className="btype" style={{ flex: 1, color: "var(--spring)", fontFamily: "var(--mono)" }}>
          {block.block_type}
        </b>
        <button className="ghost sm" onClick={onClose}>
          done
        </button>
      </div>
      {schema.length === 0 ? <p className="muted">This block type has no fields.</p> : <FieldForm schema={schema} value={fields} onChange={setFields} api={api} />}
      <button className="primary" style={{ marginTop: 12, width: "100%" }} onClick={save} disabled={busy}>
        Save block
      </button>
    </div>
  );
}

function Settings({ api, page, onSaved, onError }: { api: Api; page: Page; onSaved: (p: Page) => void; onError: (s: string) => void }) {
  // The core CMS API doesn't expose a general page-rename handler; keep this read-only +
  // link the essentials. (A future `updatePage` handler would back editable title/slug.)
  void api;
  void onSaved;
  void onError;
  return (
    <div className="kv">
      <span>Title</span>
      <span>{page.title}</span>
      <span>Slug</span>
      <span>/{page.slug}</span>
      <span>Locale</span>
      <span>{page.locale}</span>
      <span>Status</span>
      <span>{page.status}</span>
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
  const F = (k: keyof typeof f, label: string, area = false) => (
    <label className="field">
      <span className="lbl">{label}</span>
      {area ? <textarea value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /> : <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}
    </label>
  );
  return (
    <div>
      <div className="sect">SEO</div>
      {ok ? <div className="banner ok">saved</div> : null}
      {F("metaTitle", "Meta title")}
      {F("metaDescription", "Meta description", true)}
      {F("canonicalUrl", "Canonical URL")}
      {F("robots", "Robots (e.g. noindex)")}
      {F("ogTitle", "OG title")}
      {F("ogDescription", "OG description", true)}
      <button className="primary" style={{ width: "100%" }} onClick={save}>
        Save SEO
      </button>
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
      <div className="sect">Workflow</div>
      <p className="kv">
        <span>Status</span>
        <span className={`pill ${page.status}`}>{page.status}</span>
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={() => act("submitForReview")}>Submit for review</button>
        <button className="primary" onClick={() => act("approve")}>
          Approve (publish)
        </button>
        <button onClick={() => act("reject")}>Reject</button>
        <button onClick={() => act("publishPage")}>Publish directly</button>
        <button className="ghost" onClick={() => act("unpublishPage")}>
          Unpublish
        </button>
      </div>
      <p className="muted" style={{ marginTop: 10 }}>Submit is editor-gated; approve/publish are reviewer-gated.</p>
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
      <div className="sect">Translations</div>
      <div className="list">
        {translations.map((t) => (
          <div className="row" key={t.id} style={{ cursor: "default" }}>
            <span className="grow">{t.locale}</span>
            <span className="muted">/{t.slug}</span>
            <span className={`pill ${t.status}`}>{t.status}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="locale (e.g. cs)" />
        <button onClick={create} disabled={!locale}>
          add
        </button>
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
      <div className="sect">Audit trail</div>
      <div className="list">
        {rows.map((a) => (
          <div className="row" key={a.id} style={{ cursor: "default", fontSize: 12 }}>
            <span className="btype">{a.action}</span>
            <span className="grow muted">
              {a.fromStatus} → {a.toStatus}
            </span>
            <span className="muted">{a.actor ?? "system"}</span>
          </div>
        ))}
        {rows.length === 0 ? <p className="muted">No history yet.</p> : null}
      </div>
    </div>
  );
}

// --- helpers ---
function errMsg(e: unknown): string {
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
