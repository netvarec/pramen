// The CMS visual editor. Left: page list. Center: region canvas (blocks per region, add
// from a palette filtered by allowedTypes, reorder, remove, select). Right: the selected
// block's schema-driven field form, or page settings (Settings / SEO / Workflow / i18n /
// Audit). All mutations go through the semantic CMS handlers (validation/publish enforced).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, ApiError, loadConfig, saveConfig, type Config } from "./api";
import { FieldForm } from "./fields";
import type { AssembledPage, AuditEntry, BlockType, ContentType, FieldDefinition, Media, Page, RegionDefinition, RenderedBlock } from "./types";

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

type View = "pages" | "media" | "users" | "settings";
interface Me { userId?: string; roles?: string[]; [k: string]: unknown }

function Editor({ api, cfg, onReconfigure }: { api: Api; cfg: Config; onReconfigure: () => void }) {
  const [pages, setPages] = useState<Page[]>([]);
  const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
  const [current, setCurrent] = useState<Page | null>(null);
  const [view, setView] = useState<View>("pages");
  const [err, setErr] = useState("");
  const [me, setMe] = useState<Me | null>(null);

  const refreshPages = useCallback(() => {
    api.listPages().then(setPages).catch((e) => setErr(errMsg(e)));
  }, [api]);
  useEffect(() => {
    refreshPages();
    api.listBlockTypes().then(setBlockTypes).catch((e) => setErr(errMsg(e)));
    // `me` gates the Users tab — a failing call is fine (leaves it undefined).
    api.call<Me>("me").then(setMe).catch(() => setMe({}));
  }, [api, refreshPages]);

  const isAdmin = (me?.roles ?? []).includes("admin");
  const go = (v: View) => { setView(v); setCurrent(null); };

  return (
    <>
      <div className="bar">
        <span className="brand">
          pramen <span className="dim">· cms</span>
        </span>
        {view === "pages" && current ? (
          <span className="crumb">
            <a onClick={() => setCurrent(null)}>Pages</a> / <b>{current.title}</b>
          </span>
        ) : null}
        <span className="grow" />
        <nav className="tabs nav" style={{ margin: 0 }}>
          <button className={view === "pages" ? "on" : ""} onClick={() => go("pages")}>Pages</button>
          <button className={view === "media" ? "on" : ""} onClick={() => go("media")}>Media</button>
          {isAdmin ? (
            <button className={view === "users" ? "on" : ""} onClick={() => go("users")}>Users</button>
          ) : null}
          <button className={view === "settings" ? "on" : ""} onClick={() => go("settings")}>Settings</button>
        </nav>
        <span className="muted" style={{ marginLeft: 12 }}>{cfg.tenant}</span>
        <button className="ghost sm" onClick={onReconfigure}>
          sign out
        </button>
      </div>
      {err ? <div className="banner err">{err}</div> : null}
      {view === "media" ? (
        <MediaLibrary api={api} onError={setErr} />
      ) : view === "users" ? (
        <UsersView api={api} me={me} onError={setErr} />
      ) : view === "settings" ? (
        <SettingsView api={api} cfg={cfg} me={me} onSignOut={onReconfigure} onError={setErr} />
      ) : current ? (
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
    <>
      <div className="hero">
        <h1 className="hero-h">
          <span className="lead">Pages</span>
          <span className="em">{pages.length === 0 ? "None yet" : pages.length === 1 ? "1 page total" : `${pages.length} pages total`}</span>
        </h1>
        <div className="cta">
          <span className="cta-text">
            Let&apos;s <span className="em">create</span> something
          </span>
          <button className="primary" onClick={() => setCreating(true)}>
            + New page
          </button>
        </div>
      </div>
      <div className="list-wrap">
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
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          Create a <span className="dim">new page</span> and define the essentials<span className="dim">.</span>
        </h2>
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
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="btype">{block.block_type}</span>
        <span style={{ flex: 1 }} />
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

// --- media library (a top-level view: browse, upload, edit alt, delete) ---
const PAGE_SIZE = 60;

function MediaLibrary({ api, onError }: { api: Api; onError: (s: string) => void }) {
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
      <div className="hero">
        <h1 className="hero-h">
          <span className="lead">Media</span>
          <span className="em">{media.length === 0 ? "None yet" : media.length === 1 ? "1 file" : `${media.length}${hasMore ? "+" : ""} files`}</span>
        </h1>
        <div className="cta">
          <span className="cta-text">
            Let&apos;s <span className="em">upload</span> something
          </span>
          <label className={`btn primary${busy ? " disabled" : ""}`}>
            {busy ? "Uploading…" : "+ Upload"}
            <input type="file" multiple hidden disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      </div>
      <div className="media-lib">
      {media.length === 0 ? (
        <p className="muted">No media yet. Upload images to use them in blocks and SEO.</p>
      ) : (
        <div className="media-grid">
          {media.map((m) => (
            <div key={m.id} className={`media-cell${selected?.id === m.id ? " sel" : ""}`} onClick={() => setSelected(m)}>
              {isImage(m) ? <img src={api.resolve(`/media/${m.file.key}`)} alt={m.alt ?? ""} /> : <div className="ext">{ext(m)}</div>}
              <div className="fn">{m.file.filename ?? m.id}</div>
            </div>
          ))}
        </div>
      )}
      {hasMore ? (
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button className="sm" onClick={() => load(offset)}>
            Load more
          </button>
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
    <div className="scrim" onClick={onClose}>
      <div className="modal media-detail" onClick={(e) => e.stopPropagation()}>
        <h2>
          <span className="dim">Media</span> {media.file.filename ?? ""}
        </h2>
        {isImage(media) ? <img src={url} alt={media.alt ?? ""} /> : <div className="ext lg">{ext(media)}</div>}
        <label className="field">
          <span className="lbl">Alt text (for accessibility &amp; SEO)</span>
          <input value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the image…" />
        </label>
        <div className="kv">
          <span>Type</span>
          <span>{media.file.contentType ?? "—"}</span>
          <span>Size</span>
          <span>{fmtBytes(media.file.size)}</span>
          <span>Uploaded</span>
          <span>{media.file.uploadedAt ? new Date(media.file.uploadedAt).toLocaleString() : (media.createdAt ?? "—")}</span>
          <span>URL</span>
          <span>
            <a href={url} target="_blank" rel="noreferrer">
              /media/{media.file.key}
            </a>
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="primary" onClick={save} disabled={busy || alt === (media.alt ?? "")}>
            Save
          </button>
          <button className="sm" onClick={() => navigator.clipboard?.writeText(url)}>
            Copy URL
          </button>
          <span className="grow" />
          <button className="ghost danger" onClick={del} disabled={busy}>
            Delete
          </button>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
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

function UsersView({ api, me, onError }: { api: Api; me: Me | null; onError: (s: string) => void }) {
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
      <div className="hero">
        <h1 className="hero-h">
          <span className="lead">Users</span>
          <span className="em">{users.length === 0 ? "None yet" : users.length === 1 ? "1 account" : `${users.length} accounts`}</span>
        </h1>
        <div className="cta">
          <span className="cta-text">Let&apos;s <span className="em">invite</span> someone</span>
          <button className="primary" onClick={() => setInviting(true)}>+ Invite</button>
        </div>
      </div>
      <div className="list-wrap">
        <div className="list">
          {users.map((u) => {
            const roles = rolesOf(u);
            const isMe = me?.userId === u.username;
            const active = u.active === undefined || u.active === null ? true : Boolean(Number(u.active));
            return (
              <div className="row" key={u.username} style={{ cursor: "default", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 200, gap: 2 }}>
                  <span style={{ fontWeight: 600 }}>{u.username}{isMe ? <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>(you)</span> : null}</span>
                  {u.email && u.email !== u.username ? <span className="muted" style={{ fontSize: 12 }}>{u.email}</span> : null}
                  {u.createdAt ? <span className="muted" style={{ fontSize: 11 }}>joined {new Date(Number(u.createdAt)).toLocaleDateString()}</span> : null}
                </div>
                <RolesInput value={roles} disabled={busy === u.username} onSave={(next) => setRoles(u, next)} />
                <span className={`pill ${active ? "published" : "archived"}`}>{active ? "active" : "inactive"}</span>
                <button className="sm ghost" disabled={busy === u.username || isMe} onClick={() => setActive(u, !active)}>
                  {active ? "Deactivate" : "Activate"}
                </button>
                <button className="sm ghost danger" disabled={busy === u.username || isMe} onClick={() => del(u)}>
                  Delete
                </button>
              </div>
            );
          })}
          {users.length === 0 ? <p className="muted">No users yet. Invite someone to get started.</p> : null}
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
        style={{ width: 220 }}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setText(value.join(", ")); setEditing(false); } }}
      />
    );
  }
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "wrap", cursor: "pointer" }} onClick={() => setEditing(true)} title="Click to edit">
      {value.length === 0 ? <span className="pill">no roles</span> : value.map((r) => <span key={r} className={`pill ${r === "admin" ? "published" : ""}`}>{r}</span>)}
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
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          Invite an <span className="dim">editor</span> or teammate
        </h2>
        <p className="muted" style={{ marginTop: -8 }}>They&apos;ll get a one-time magic link that logs them in and creates their account.</p>
        <label className="field">
          <span className="lbl">Email</span>
          <input value={email} type="email" autoFocus onChange={(e) => setEmail(e.target.value)} placeholder="them@example.com" />
        </label>
        <label className="field">
          <span className="lbl">Roles <span className="muted" style={{ fontWeight: 400 }}>(comma-separated — e.g. editor, reviewer, admin)</span></span>
          <input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="editor" />
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={invite} disabled={busy || !email}>{busy ? "Sending…" : "Send invite"}</button>
        </div>
      </div>
    </div>
  );
}

// --- settings ----------------------------------------------------------------

function SettingsView({ api, cfg, me, onSignOut, onError }: { api: Api; cfg: Config; me: Me | null; onSignOut: () => void; onError: (s: string) => void }) {
  return (
    <>
      <div className="hero">
        <h1 className="hero-h">
          <span className="lead">Settings</span>
          <span className="em">{me?.userId ?? "your account"}</span>
        </h1>
      </div>
      <div className="list-wrap" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
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
    <div className="inspect" style={{ background: "var(--surface-2)" }}>
      <div className="sect" style={{ marginTop: 0 }}>My account</div>
      {msg ? <div className="banner ok">{msg}</div> : null}
      <div className="kv" style={{ marginBottom: 16 }}>
        <span>Username</span><span>{me?.userId ?? "—"}</span>
        <span>Roles</span><span>{(me?.roles ?? []).join(", ") || "—"}</span>
      </div>
      <label className="field">
        <span className="lbl">Change contact email</span>
        <input value={email} type="email" onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </label>
      <button className="primary" onClick={saveEmail} disabled={busy || !email} style={{ width: "100%" }}>Save email</button>
      <div style={{ height: 20 }} />
      <label className="field">
        <span className="lbl">Current password</span>
        <input value={pwCurrent} type="password" onChange={(e) => setPwCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span className="lbl">New password <span className="muted" style={{ fontWeight: 400 }}>(at least 8 characters)</span></span>
        <input value={pwNew} type="password" onChange={(e) => setPwNew(e.target.value)} autoComplete="new-password" />
      </label>
      <button className="primary" onClick={savePassword} disabled={busy || pwNew.length < 8 || pwCurrent.length === 0} style={{ width: "100%" }}>Change password</button>
      <div style={{ height: 24 }} />
      <button className="ghost danger" onClick={onSignOut} style={{ width: "100%" }}>Sign out</button>
    </div>
  );
}

function AboutCard({ cfg, me }: { cfg: Config; me: Me | null }) {
  return (
    <div className="inspect" style={{ background: "var(--surface-2)" }}>
      <div className="sect" style={{ marginTop: 0 }}>About</div>
      <div className="kv">
        <span>Tenant</span><span>{cfg.tenant || "main"}</span>
        <span>API</span><span style={{ wordBreak: "break-all" }}>{cfg.baseUrl}</span>
        <span>Signed in as</span><span>{me?.userId ?? "—"}</span>
        <span>Editor</span><span>pramen · cms-editor</span>
      </div>
    </div>
  );
}
