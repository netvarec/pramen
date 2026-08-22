// Thin browser client for pramen's admin HTTP API. Every call carries the admin
// bearer token; failures surface as an ApiError that the UI renders verbatim
// (error + code), with a friendlier hint for a 403 (not an admin token).

/** Any JSON value. Declared locally (not imported from @pramen/server) so the admin
 * stays a standalone browser bundle with no server-package dependency. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Whatever `GET /tenants` answered with — trusted to be JSON and nothing more. */
export type TenantsResult = JsonValue;

/** One row of admin data, as the `/admin/data` endpoint returns it. */
export type Row = Record<string, JsonValue>;

export interface SchemaResult {
  hash: string | null;
  tables: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Config {
  baseUrl: string;
  token: string;
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: string;
  code?: string;
}

async function call<T>(cfg: Config, path: string, init?: RequestInit): Promise<T> {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const headers = new Headers();
  if (init?.body) headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${cfg.token}`);
  // caller-supplied headers win, matching the previous spread order
  for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers });
  } catch (e) {
    throw new ApiError(
      `network error reaching ${base} — is pramen running and is CORS_ORIGINS set?`,
      "network",
      0,
    );
  }

  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    // non-JSON (e.g. the plain-text root help page or an upstream 500)
  }

  if (!res.ok || !body || body.ok === false) {
    const code = body?.code ?? String(res.status);
    let message = body?.error ?? `request failed (${res.status})`;
    if (res.status === 403) message = `not an admin token — ${message}`;
    throw new ApiError(message, code, res.status);
  }
  return body.result as T;
}

/** One registered Durable Object, the shape `GET /tenants` actually returns. Mirrors
 * `DoRef` in @pramen/server, duplicated rather than imported because the admin is a
 * standalone browser bundle that does not depend on the server package. */
interface TenantRef {
  tenant: string;
  partition: string;
}

/** Tenant names out of whatever `GET /tenants` answered with.
 *
 * The server returns `{tenant, partition}[]` — one entry per registered Durable Object,
 * so a tenant with several partitions appears more than once. This call was typed
 * `string[]` and the result fed straight into `<SelectItem>`, which put an OBJECT where
 * React expected a child: it threw during render and blanked the entire dashboard for
 * anyone whose deployment had even one tenant.
 *
 * Deduped, because the picker chooses a tenant and every partition of a tenant is the
 * same choice here — the admin always talks to the default partition. Sorted so the
 * order does not drift with KV listing order.
 *
 * A plain `string[]` is tolerated too. The admin is a client you point at arbitrary
 * deployments — a freshly built bundle against a long-running Worker, say — so the
 * server on the other end is not necessarily the version that produced this parser.
 */
export function tenantNames(result: TenantsResult): string[] {
  if (!Array.isArray(result)) return [];
  const names = result
    .map((entry) => (typeof entry === "string" ? entry : (entry as Partial<TenantRef> | null)?.tenant))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return [...new Set(names)].sort();
}

export const api = {
  tenants: async (cfg: Config): Promise<string[]> => tenantNames(await call<TenantsResult>(cfg, "/tenants")),

  schema: (cfg: Config, tenant: string) =>
    call<SchemaResult>(cfg, `/admin/schema?tenant=${encodeURIComponent(tenant)}`),

  list: (cfg: Config, tenant: string, table: string, limit: number, offset: number) =>
    call<Row[]>(cfg, "/admin/data", {
      method: "POST",
      body: JSON.stringify({ tenant, table, op: "list", limit, offset }),
    }),

  count: (cfg: Config, tenant: string, table: string) =>
    call<number>(cfg, "/admin/data", {
      method: "POST",
      body: JSON.stringify({ tenant, table, op: "count" }),
    }),

  get: (cfg: Config, tenant: string, table: string, id: unknown) =>
    call<Row | null>(cfg, "/admin/data", {
      method: "POST",
      body: JSON.stringify({ tenant, table, op: "get", id }),
    }),

  create: (cfg: Config, tenant: string, table: string, values: Row) =>
    call<Row>(cfg, "/admin/data", {
      method: "POST",
      body: JSON.stringify({ tenant, table, op: "create", values }),
    }),

  update: (cfg: Config, tenant: string, table: string, id: unknown, patch: Row) =>
    call<Row | null>(cfg, "/admin/data", {
      method: "POST",
      body: JSON.stringify({ tenant, table, op: "update", id, patch }),
    }),

  remove: (cfg: Config, tenant: string, table: string, id: unknown) =>
    call<boolean>(cfg, "/admin/data", {
      method: "POST",
      body: JSON.stringify({ tenant, table, op: "delete", id }),
    }),
};
