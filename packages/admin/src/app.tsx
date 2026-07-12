// The pramen admin dashboard. A single focused inspector: config bar -> tenant
// vessel -> schema strata (tables) -> row browser, with view/edit/create/delete
// over the /admin/data primitives. Editing is a robust JSON textarea (no schema
// guessing). All API failures render verbatim (error + code) in a banner.

import { Button, Input } from "@podoba/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Config, type Row, type SchemaResult } from "./api";

const LS = { base: "pramen.admin.baseUrl", token: "pramen.admin.token", tenant: "pramen.admin.tenant" };
const PAGE = 25;

// Tokenized bare control (podoba filled-field skin) for the native inputs/selects.
const CONTROL = "h-10 w-full rounded-lg border border-border bg-surface-card px-4 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-brand-green";

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
  if (v === null || v === undefined) return <span className="italic text-fg-subtle">null</span>;
  if (typeof v === "boolean") return <span className="text-accent-strong">{String(v)}</span>;
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return (
      <span className="block max-w-[280px] truncate font-mono text-xs text-fg-muted" title={s}>
        {s}
      </span>
    );
  }
  const s = String(v);
  return (
    <span className="block max-w-[280px] truncate" title={s}>
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
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      <div className="flex flex-wrap items-end gap-4 border-b border-border bg-surface px-7 py-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[15px] font-bold text-fg">pramen</span>
          <span className="text-fg-subtle">admin</span>
        </div>
        <div className="min-w-[220px] flex-1">
          <Input label="base url" value={baseUrl} onChange={setBaseUrl} placeholder="http://localhost:8787" spellCheck="false" />
        </div>
        <div className="min-w-[260px] flex-1">
          <Input label="admin token" type="password" value={token} onChange={setToken} placeholder='paste an admin JWT (roles include "admin")' spellCheck="false" />
        </div>
        <div className="w-full text-xs text-fg-subtle">Must be an admin token — every endpoint checks roles for &quot;admin&quot;.</div>
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-5 px-7 py-5 max-[820px]:grid-cols-1">
        <aside className="flex flex-col gap-2">
          <p className="text-sm text-fg-subtle">Tenant</p>
          <div className="flex items-center gap-1.5">
            {tenants.length > 0 ? (
              <select className={CONTROL} value={tenants.includes(tenant) ? tenant : ""} onChange={(e) => setTenant(e.target.value)}>
                {!tenants.includes(tenant) && <option value="">{tenant} (manual)</option>}
                {tenants.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            ) : (
              <input className={CONTROL} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="main" spellCheck={false} />
            )}
            <Button variant="ghost" size="sm" className="shrink-0" onPress={() => {
              const next = prompt("Tenant name", tenant);
              if (next != null && next.trim()) setTenant(next.trim());
            }}>edit</Button>
          </div>

          <p className="mt-3 text-sm text-fg-subtle">Schema</p>
          {schema ? (
            <div className={`flex items-center gap-2 rounded-full border border-border px-3 py-1 font-mono text-xs ${schema.hash ? "text-fg-muted" : "text-fg-subtle"}`} title="applied schema hash">
              <span className={`h-2 w-2 rounded-full ${schema.hash ? "bg-brand-green" : "bg-fg-subtle"}`} />
              {schema.hash ? schema.hash.slice(0, 12) : "no schema hash"}
            </div>
          ) : (
            <div className="mb-3.5 text-fg-subtle">{token ? "—" : "enter a token"}</div>
          )}

          <p className="mt-3 text-sm text-fg-subtle">Tables{tableNames.length ? ` · ${tableNames.length}` : ""}</p>
          {tableNames.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {tableNames.map((t) => (
                <li key={t}>
                  <button
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${t === table ? "border-fg bg-surface-card text-fg" : "border-transparent text-fg-muted hover:bg-surface-card"}`}
                    onClick={() => setTable(t)}
                  >
                    <span className="font-medium">{t}</span>
                    <span className="text-xs text-fg-subtle">{schema!.tables[t].length} cols</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-fg-subtle">{token ? "no tables" : ""}</div>
          )}
        </aside>

        <main className="min-w-0">
          {err && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-danger bg-surface-card px-4 py-2.5 text-sm text-danger">
              <div>
                {err.message} <code className="font-mono">{err.code}</code>
              </div>
              <Button variant="ghost" size="sm" onPress={() => setErr(null)}>dismiss</Button>
            </div>
          )}

          {!table ? (
            <div className="rounded-panel border border-border bg-surface-card px-8 py-12 text-center">
              <div className="mb-2 text-xl text-fg">{token ? "select a table" : "paste an admin token to begin"}</div>
              <div className="text-fg-muted">The dashboard talks to the pramen Worker over HTTP. Tenant defaults to <code className="font-mono text-accent-strong">main</code>.</div>
            </div>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-3">
                <h2 className="m-0 text-2xl font-normal text-fg">{table}</h2>
                <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-fg-muted">{count == null ? "…" : `${count} row${count === 1 ? "" : "s"}`}</span>
                <span className="flex-1" />
                <Button variant="ghost" size="sm" onPress={() => void loadRows()} isDisabled={loading}>refresh</Button>
                <Button size="sm" onPress={openCreate}>+ new row</Button>
              </div>

              <div className="mb-3 flex items-center gap-2">
                <Button variant="secondary" size="sm" isDisabled={offset === 0 || loading} onPress={() => setOffset(Math.max(0, offset - PAGE))}>‹ prev</Button>
                <span className="text-sm text-fg-muted">
                  page {page}
                  {totalPages != null ? ` / ${totalPages}` : ""}
                </span>
                <Button variant="secondary" size="sm" isDisabled={loading || (count != null && offset + PAGE >= count)} onPress={() => setOffset(offset + PAGE)}>next ›</Button>
              </div>

              {loading && !rows ? (
                <div className="py-12 text-center text-fg-subtle">loading…</div>
              ) : rows && rows.length === 0 ? (
                <div className="py-12 text-center text-fg-subtle">no rows on this page</div>
              ) : rows ? (
                <div className="overflow-x-auto rounded-panel border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c} className="whitespace-nowrap border-b border-border bg-surface-card px-3 py-2 text-left font-medium text-fg-muted">{c}</th>
                        ))}
                        <th className="border-b border-border bg-surface-card px-3 py-2 text-right font-medium text-fg-muted">actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={(row.id as string) ?? i} className="hover:bg-surface-card">
                          {columns.map((c) => (
                            <td key={c} className="border-b border-border px-3 py-2 align-top">{renderCell(row[c])}</td>
                          ))}
                          <td className="border-b border-border px-3 py-2 align-top">
                            <div className="flex justify-end gap-1">
                              <Button variant="ghost" size="sm" onPress={() => void openEdit(row)}>edit</Button>
                              <Button variant="ghost" size="sm" className="text-danger" onPress={() => void del(row)} isDisabled={busy}>del</Button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,15,5,0.28)] p-6" onClick={(e) => e.target === e.currentTarget && setEditor(null)}>
          <div className="flex max-h-[86vh] w-full max-w-[680px] flex-col overflow-hidden rounded-panel border border-border bg-surface-card shadow-[0_24px_60px_rgba(30,20,10,0.12)]">
            <div className="flex items-center gap-2 border-b border-border px-6 py-4">
              <h3 className="m-0 text-lg font-normal text-fg">{editor.mode === "create" ? `new ${table} row` : `edit ${table} · id=${JSON.stringify(editor.original?.id)}`}</h3>
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onPress={() => setEditor(null)}>✕</Button>
            </div>
            <div className="flex flex-col gap-2 overflow-auto px-6 py-4">
              <label className="text-sm font-medium text-fg">row json {editor.mode === "edit" ? "(only changed fields are sent as the patch)" : "(sent as values)"}</label>
              <textarea
                className="min-h-[280px] w-full resize-y rounded-lg border border-border bg-surface-card px-4 py-3 font-mono text-[13px] text-fg outline-none focus:border-brand-green"
                value={editor.text}
                spellCheck={false}
                onChange={(e) => setEditor({ ...editor, text: e.target.value })}
              />
              {editErr && <div className="mt-2 rounded-lg border border-danger bg-surface-card px-3.5 py-2.5 text-[13px] text-danger">{editErr}</div>}
            </div>
            <div className="flex items-center gap-2 border-t border-border px-6 py-4">
              <span className="text-fg-subtle">{editor.mode === "edit" ? "id is never modified" : "id is assigned by the server unless provided"}</span>
              <span className="flex-1" />
              <Button variant="ghost" onPress={() => setEditor(null)}>cancel</Button>
              <Button onPress={() => void saveEditor()} isDisabled={busy}>
                {busy ? "saving…" : editor.mode === "create" ? "create" : "save changes"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
