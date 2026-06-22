// Thin browser client for pramen's admin HTTP API. Every call carries the admin
// bearer token; failures surface as an ApiError that the UI renders verbatim
// (error + code), with a friendlier hint for a 403 (not an admin token).

export type Row = Record<string, unknown>;

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
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${cfg.token}`,
        ...(init?.headers ?? {}),
      },
    });
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

export const api = {
  tenants: (cfg: Config) => call<string[]>(cfg, "/tenants"),

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
