// The pramen admin dashboard. A single focused inspector: config bar -> tenant
// vessel -> schema strata (tables) -> row browser, with view/edit/create/delete
// over the /admin/data primitives. Editing is a robust JSON textarea (no schema
// guessing). All API failures render verbatim (error + code) in a banner.

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, type Config, type Row, type SchemaResult } from "./api";

const LS = { base: "pramen.admin.baseUrl", token: "pramen.admin.token", tenant: "pramen.admin.tenant" };
const PAGE = 25;

const useLocal = (key: string, initial: string): [string, (v: string) => void] => {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? initial);
  const set = useCallback(
    (next: string) => {
      setV(next);
      localStorage.setItem(key, next);
    },
    [key],
  );
  return [v, set];
};

function renderCell(v: unknown) {
  if (v === null || v === undefined) return <span class="cell null">null</span>;
  if (typeof v === "boolean") return <span class="cell bool">{String(v)}</span>;
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return (
      <span class="cell json" title={s}>
        {s}
      </span>
    );
  }
  const s = String(v);
  return (
    <span class="cell" title={s}>
      {s}
    </span>
  );
}

type Editor = { mode: "create" | "edit"; original: Row | null; text: string } | null;

export function App() {
  const [baseUrl, setBaseUrl] = useLocal(LS.base, "http://localhost:8787");
  const [token, setToken] = useLocal(LS.token, "");
  const [tenant, setTenant] = useLocal(LS.tenant, "main");

  const cfg: Config = useMemo(() => ({ baseUrl, token }), [baseUrl, token]);

  const [tenants, setTenants] = useState<string[]>([]);
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ message: string; code: string } | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const report = useCallback((e: unknown) => {
    if (e instanceof ApiError) setErr({ message: e.message, code: e.code });
    else setErr({ message: e instanceof Error ? e.message : String(e), code: "unknown" });
  }, []);

  // Load tenant list (best-effort: a fresh deploy may have none; manual entry still works).
  const loadTenants = useCallback(async () => {
    if (!token) return;
    try {
      setTenants(await api.tenants(cfg));
    } catch (e) {
      // Surface only if it's auth — a missing list is fine.
      if (e instanceof ApiError && e.status === 403) report(e);
    }
  }, [cfg, token, report]);

  const loadSchema = useCallback(async () => {
    if (!token) return;
    setErr(null);
    try {
      const s = await api.schema(cfg, tenant);
      setSchema(s);
      setTable((cur) => (cur && cur in s.tables ? cur : (Object.keys(s.tables)[0] ?? null)));
    } catch (e) {
      setSchema(null);
      setTable(null);
      report(e);
    }
  }, [cfg, tenant, token, report]);

  const loadRows = useCallback(async () => {
    if (!token || !table) return;
    setLoading(true);
    setErr(null);
    try {
      const [r, c] = await Promise.all([api.list(cfg, tenant, table, PAGE, offset), api.count(cfg, tenant, table)]);
      setRows(r);
      setCount(c);
    } catch (e) {
      setRows(null);
      setCount(null);
      report(e);
    } finally {
      setLoading(false);
    }
  }, [cfg, tenant, table, offset, token, report]);

  // tenants + schema react to config/tenant; rows react to table/page.
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void loadTenants();
      void loadSchema();
    }, 250);
    return () => clearTimeout(debounce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token, tenant]);

  useEffect(() => {
    setOffset(0);
  }, [table, tenant]);

  useEffect(() => {
    void loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, tenant, offset, baseUrl, token]);

  const columns = useMemo(() => (table && schema ? schema.tables[table] : null) ?? [], [table, schema]);

  const openCreate = () => {
    setEditErr(null);
    const skeleton: Row = {};
    for (const c of columns) if (c !== "id") skeleton[c] = null;
    setEditor({ mode: "create", original: null, text: JSON.stringify(skeleton, null, 2) });
  };

  const openEdit = async (row: Row) => {
    setEditErr(null);
    try {
      const full = (await api.get(cfg, tenant, table!, row.id)) ?? row;
      setEditor({ mode: "edit", original: full, text: JSON.stringify(full, null, 2) });
    } catch (e) {
      report(e);
    }
  };

  const saveEditor = async () => {
    if (!editor || !table) return;
    let parsed: Row;
    try {
      parsed = JSON.parse(editor.text) as Row;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("must be a JSON object");
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : "invalid JSON");
      return;
    }
    setBusy(true);
    setEditErr(null);
    try {
      if (editor.mode === "create") {
        await api.create(cfg, tenant, table, parsed);
      } else {
        const orig = editor.original ?? {};
        const id = orig.id;
        // Send only changed fields as the patch; never send id back.
        const patch: Row = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (k === "id") continue;
          if (JSON.stringify(v) !== JSON.stringify(orig[k])) patch[k] = v;
        }
        if (Object.keys(patch).length === 0) {
          setEditErr("no changes to save");
          setBusy(false);
          return;
        }
        await api.update(cfg, tenant, table, id, patch);
      }
      setEditor(null);
      await loadRows();
    } catch (e) {
      setEditErr(e instanceof ApiError ? `${e.message} (${e.code})` : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async (row: Row) => {
    if (!table) return;
    if (!confirm(`Delete row id=${JSON.stringify(row.id)} from "${table}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.remove(cfg, tenant, table, row.id);
      await loadRows();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const tableNames = schema ? Object.keys(schema.tables) : [];
  const page = Math.floor(offset / PAGE) + 1;
  const totalPages = count != null ? Math.max(1, Math.ceil(count / PAGE)) : null;

  return (
    <>
      <div class="bar">
        <div class="brand">
          <span class="mark">pramen</span>
          <span class="sub">admin</span>
        </div>
        <div class="field url">
          <label>base url</label>
          <input value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} placeholder="http://localhost:8787" spellcheck={false} />
        </div>
        <div class="field token">
          <label>admin token</label>
          <input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="paste an admin JWT (roles include &quot;admin&quot;)" spellcheck={false} />
        </div>
        <div class="hint">Must be an admin token — every endpoint checks roles for &quot;admin&quot;.</div>
      </div>

      <div class="layout">
        <aside class="side">
          <p class="sec-title">Tenant</p>
          <div class="tenant-row">
            {tenants.length > 0 ? (
              <select value={tenants.includes(tenant) ? tenant : ""} onChange={(e) => setTenant((e.target as HTMLSelectElement).value)}>
                {!tenants.includes(tenant) && <option value="">{tenant} (manual)</option>}
                {tenants.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              <input value={tenant} onInput={(e) => setTenant((e.target as HTMLInputElement).value)} placeholder="main" spellcheck={false} />
            )}
            <button class="ghost sm" title="Edit tenant name manually" onClick={() => {
              const next = prompt("Tenant name", tenant);
              if (next != null && next.trim()) setTenant(next.trim());
            }}>edit</button>
          </div>

          <p class="sec-title">Schema</p>
          {schema ? (
            <div class={`hashchip${schema.hash ? "" : " none"}`} title="applied schema hash">
              <span class="dot" />
              {schema.hash ? schema.hash.slice(0, 12) : "no schema hash"}
            </div>
          ) : (
            <div class="muted" style="margin-bottom:14px">{token ? "—" : "enter a token"}</div>
          )}

          <p class="sec-title">Tables{tableNames.length ? ` · ${tableNames.length}` : ""}</p>
          {tableNames.length > 0 ? (
            <ul class="tables">
              {tableNames.map((t) => (
                <li key={t}>
                  <button class={t === table ? "active" : ""} onClick={() => setTable(t)}>
                    <span class="tname">{t}</span>
                    <span class="cols">{schema!.tables[t].length} cols</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div class="muted">{token ? "no tables" : ""}</div>
          )}
        </aside>

        <main class="main">
          {err && (
            <div class="banner">
              <div>
                {err.message} <code>{err.code}</code>
              </div>
              <button class="ghost sm" onClick={() => setErr(null)}>dismiss</button>
            </div>
          )}

          {!table ? (
            <div class="placeholder">
              <div class="big">{token ? "select a table" : "paste an admin token to begin"}</div>
              <div>The dashboard talks to the pramen Worker over HTTP. Tenant defaults to <code style="color:var(--amber)">main</code>.</div>
            </div>
          ) : (
            <>
              <div class="main-head">
                <h2>{table}</h2>
                <span class="countchip">{count == null ? "…" : `${count} row${count === 1 ? "" : "s"}`}</span>
                <span class="spacer" />
                <button class="ghost sm" onClick={() => void loadRows()} disabled={loading}>refresh</button>
                <button class="primary" onClick={openCreate}>+ new row</button>
              </div>

              <div class="toolbar">
                <div class="pager">
                  <button class="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ prev</button>
                  <span>
                    page {page}
                    {totalPages != null ? ` / ${totalPages}` : ""}
                  </span>
                  <button class="sm" disabled={loading || (count != null && offset + PAGE >= count)} onClick={() => setOffset(offset + PAGE)}>next ›</button>
                </div>
              </div>

              {loading && !rows ? (
                <div class="loading">loading…</div>
              ) : rows && rows.length === 0 ? (
                <div class="empty">no rows on this page</div>
              ) : rows ? (
                <div class="tablewrap">
                  <table class="grid">
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                        <th style="text-align:right">actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={(row.id as string) ?? i}>
                          {columns.map((c) => (
                            <td key={c}>{renderCell(row[c])}</td>
                          ))}
                          <td>
                            <div class="rowactions">
                              <button class="ghost sm" onClick={() => void openEdit(row)}>edit</button>
                              <button class="danger sm" onClick={() => void del(row)} disabled={busy}>del</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
        </main>
      </div>

      {editor && (
        <div class="scrim" onClick={(e) => e.target === e.currentTarget && setEditor(null)}>
          <div class="modal">
            <div class="modal-head">
              <h3>{editor.mode === "create" ? `new ${table} row` : `edit ${table} · id=${JSON.stringify(editor.original?.id)}`}</h3>
              <span class="spacer" />
              <button class="ghost sm" onClick={() => setEditor(null)}>✕</button>
            </div>
            <div class="modal-body">
              <label>row json {editor.mode === "edit" ? "(only changed fields are sent as the patch)" : "(sent as values)"}</label>
              <textarea
                value={editor.text}
                spellcheck={false}
                onInput={(e) => setEditor({ ...editor, text: (e.target as HTMLTextAreaElement).value })}
              />
              {editErr && <div class="jsonerr" style="margin-top:8px">{editErr}</div>}
            </div>
            <div class="modal-foot">
              <span class="muted">{editor.mode === "edit" ? "id is never modified" : "id is assigned by the server unless provided"}</span>
              <span class="spacer" />
              <button class="ghost" onClick={() => setEditor(null)}>cancel</button>
              <button class="primary" onClick={() => void saveEditor()} disabled={busy}>
                {busy ? "saving…" : editor.mode === "create" ? "create" : "save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
