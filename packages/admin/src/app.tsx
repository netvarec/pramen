// The pramen admin dashboard. A single focused inspector: connection + tenant ->
// schema strata (tables) -> row browser, with view/edit/create/delete over the
// /admin/data primitives. Editing is a robust JSON textarea (no schema guessing).
// All API failures render verbatim (error + code) in a banner.
//
// Design system = podoba (@podoba/react + tokens). The chrome is podoba's AppShell
// (topbar + sidebar + main); data uses its Table/Dialog/Select/Card/Badge. Dark mode
// is free — the token vars flip under `[data-theme="dark"]`.

import { AppShell, Badge, Button, Card, Dialog, Heading, Input, MoonIcon, Select, SelectItem, SunIcon, Table, Text, Topbar, type TableColumn } from "@podoba/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Config, type Row, type SchemaResult } from "./api";

const LS = { base: "pramen.admin.baseUrl", token: "pramen.admin.token", tenant: "pramen.admin.tenant", theme: "pramen.admin.theme" };
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
  if (v === null || v === undefined) return <span className="italic text-fg-subtle">null</span>;
  if (typeof v === "boolean") return <span className="text-accent-strong">{String(v)}</span>;
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return (
      <span className="block max-w-[280px] truncate font-mono text-caption text-fg-muted" title={s}>
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
  const [theme, setTheme] = useLocal(LS.theme, "light");

  // podoba tokens flip on `[data-theme="dark"]` — no `dark:` prefixes needed.
  useEffect(() => {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  }, [theme]);

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
  // Manual tenants (not in the discovered list) still show in the Select as an option.
  const tenantOptions = tenants.includes(tenant) || !tenant ? tenants : [tenant, ...tenants];

  // Row table = one column per schema field + a trailing actions column. Rebuilt each
  // render so the edit/del closures capture current cfg/tenant/table (cheap; few cols).
  const tableColumns: TableColumn<Row>[] = [
    ...columns.map((c) => ({ key: c, header: c, render: (row: Row) => renderCell(row[c]) })),
    {
      key: "__actions",
      header: "actions",
      align: "right" as const,
      render: (row: Row) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onPress={() => void openEdit(row)}>
            edit
          </Button>
          <Button variant="destructive" size="sm" isDisabled={busy} onPress={() => void del(row)}>
            del
          </Button>
        </div>
      ),
    },
  ];

  const sidebar = (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex flex-col gap-3">
        <Input label="base url" size="sm" value={baseUrl} onChange={setBaseUrl} placeholder="http://localhost:8787" />
        <Input label="admin token" size="sm" type="password" value={token} onChange={setToken} placeholder="paste an admin JWT" />
        <Text size="caption" tone="subtle">
          Every endpoint checks roles for &quot;admin&quot;.
        </Text>
      </div>

      {tenantOptions.length > 0 ? (
        <div className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <Select
              label="Tenant"
              placeholder="select a tenant"
              selectedKey={tenant || null}
              onSelectionChange={(k) => setTenant(String(k))}
            >
              {tenantOptions.map((t) => (
                <SelectItem key={t} id={t}>
                  {t === tenant && !tenants.includes(t) ? `${t} (manual)` : t}
                </SelectItem>
              ))}
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onPress={() => {
              const next = prompt("Tenant name", tenant);
              if (next != null && next.trim()) setTenant(next.trim());
            }}
          >
            edit
          </Button>
        </div>
      ) : (
        <Input label="Tenant" size="sm" value={tenant} onChange={setTenant} placeholder="main" />
      )}

      <div className="flex flex-col gap-2">
        <Text size="caption" tone="muted" className="font-medium uppercase tracking-wide">
          Schema
        </Text>
        {schema ? (
          <div className="flex items-center gap-2 rounded-full border border-border px-3 py-1 font-mono text-caption" title="applied schema hash">
            <span className={`h-2 w-2 rounded-full ${schema.hash ? "bg-brand-green" : "bg-fg-subtle"}`} />
            <span className={schema.hash ? "text-fg-muted" : "text-fg-subtle"}>{schema.hash ? schema.hash.slice(0, 12) : "no schema hash"}</span>
          </div>
        ) : (
          <Text size="small" tone="subtle">
            {token ? "—" : "enter a token"}
          </Text>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Text size="caption" tone="muted" className="font-medium uppercase tracking-wide">
          Tables{tableNames.length ? ` · ${tableNames.length}` : ""}
        </Text>
        {tableNames.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {tableNames.map((t) => (
              <li key={t}>
                <button
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-small transition-colors ${t === table ? "bg-surface-card font-medium text-fg" : "text-fg-muted hover:bg-surface-card"}`}
                  onClick={() => setTable(t)}
                >
                  <span>{t}</span>
                  <Text size="caption" tone="subtle">
                    {schema!.tables[t].length}
                  </Text>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Text size="small" tone="subtle">
            {token ? "no tables" : ""}
          </Text>
        )}
      </div>
    </div>
  );

  const topbar = (
    <Topbar className="px-6">
      <Topbar.Brand>
        <span className="text-callout font-bold text-fg">pramen</span>
        <span className="text-fg-subtle">admin</span>
      </Topbar.Brand>
      <Topbar.Actions>
        <Button
          variant="ghost"
          size="sm"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
        </Button>
      </Topbar.Actions>
    </Topbar>
  );

  return (
    <>
      <AppShell topbar={topbar} sidebar={sidebar} sidebarLabel="Admin navigation" drawerToggleLabel="Toggle navigation">
        {err && (
          <Card variant="outlined" padding="none" className="mb-4 flex items-center justify-between gap-3 border-danger px-4 py-2.5">
            <Text size="small" className="text-danger">
              {err.message} <code className="font-mono">{err.code}</code>
            </Text>
            <Button variant="ghost" size="sm" onPress={() => setErr(null)}>
              dismiss
            </Button>
          </Card>
        )}

        {!table ? (
          <Card variant="outlined" padding="lg" className="text-center">
            <Heading level="3" className="mb-2">
              {token ? "select a table" : "paste an admin token to begin"}
            </Heading>
            <Text tone="muted">
              The dashboard talks to the pramen Worker over HTTP. Tenant defaults to <code className="font-mono text-accent-strong">main</code>.
            </Text>
          </Card>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <Heading level="2">{table}</Heading>
              <Badge color="grey" label={count == null ? "…" : `${count} row${count === 1 ? "" : "s"}`} />
              <span className="flex-1" />
              <Button variant="ghost" size="sm" isDisabled={loading} onPress={() => void loadRows()}>
                refresh
              </Button>
              <Button size="sm" onPress={openCreate}>
                + new row
              </Button>
            </div>

            <div className="mb-3 flex items-center gap-2">
              <Button variant="secondary" size="sm" isDisabled={offset === 0 || loading} onPress={() => setOffset(Math.max(0, offset - PAGE))}>
                ‹ prev
              </Button>
              <Text size="small" tone="muted">
                page {page}
                {totalPages != null ? ` / ${totalPages}` : ""}
              </Text>
              <Button variant="secondary" size="sm" isDisabled={loading || (count != null && offset + PAGE >= count)} onPress={() => setOffset(offset + PAGE)}>
                next ›
              </Button>
            </div>

            {loading && !rows ? (
              <Text tone="subtle" className="block py-12 text-center">
                loading…
              </Text>
            ) : rows ? (
              <Card variant="outlined" padding="none" className="overflow-hidden">
                <Table columns={tableColumns} data={rows} getRowKey={(r, i) => String((r.id as string) ?? i)} emptyMessage="no rows on this page" aria-label={`${table} rows`} />
              </Card>
            ) : null}
          </>
        )}
      </AppShell>

      <Dialog
        isOpen={editor != null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        size="lg"
        title={editor ? (editor.mode === "create" ? `new ${table} row` : `edit ${table} · id=${JSON.stringify(editor.original?.id)}`) : undefined}
        description={editor?.mode === "edit" ? "Only changed fields are sent as the patch." : editor ? "Sent as the row's values." : undefined}
      >
        {() =>
          editor && (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-2">
                <Text size="small" weight="medium">
                  row json
                </Text>
                {/* A code field: token-styled native textarea so JSON stays monospaced
                    (podoba's Textarea is a sans-serif form control). */}
                <textarea
                  className="min-h-[300px] w-full resize-y rounded-lg border border-border bg-surface px-4 py-3 font-mono text-caption text-fg outline-none transition-colors focus:border-brand-green focus:ring-2 focus:ring-ring"
                  value={editor.text}
                  spellCheck={false}
                  onChange={(e) => setEditor({ ...editor, text: e.target.value })}
                />
              </label>
              {editErr && (
                <Card variant="outlined" padding="none" className="border-danger px-3.5 py-2.5">
                  <Text size="small" className="text-danger">
                    {editErr}
                  </Text>
                </Card>
              )}
              <div className="flex items-center gap-2">
                <Text size="small" tone="subtle">
                  {editor.mode === "edit" ? "id is never modified" : "id is assigned by the server unless provided"}
                </Text>
                <span className="flex-1" />
                <Button variant="ghost" onPress={() => setEditor(null)}>
                  cancel
                </Button>
                <Button isDisabled={busy} onPress={() => void saveEditor()}>
                  {busy ? "saving…" : editor.mode === "create" ? "create" : "save changes"}
                </Button>
              </div>
            </div>
          )
        }
      </Dialog>
    </>
  );
}
