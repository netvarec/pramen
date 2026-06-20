// Driver + Dialect — the substrate seam. mrak's ACL, read-engine, repository, and
// migrator are written against these two interfaces, so the same data layer runs
// over any SQL backend:
//
//   - Driver  : how to execute SQL and run a transaction (async). One per backend
//               (DO SQLite, D1, Hyperdrive→Postgres, …).
//   - Dialect : how a backend spells SQL (identifier quoting, bind placeholders,
//               RETURNING support, value encoding). One per SQL flavor.
//
// This makes "Worker + D1" or "Worker + Hyperdrive/Postgres" a matter of plugging
// in a Driver, rather than rewriting the engine. Live queries remain a DO-only
// capability (they need a single writer + a stateful socket host).

export type Row = Record<string, unknown>;

export interface Dialect {
  /** Render an identifier (table/column), quoting as the backend requires. */
  id(name: string): string;
  /** Bind placeholder for the `n`-th parameter (1-based): `?` (SQLite/MySQL) or `$n` (Postgres). */
  placeholder(n: number): string;
  /** Whether INSERT/UPDATE/DELETE ... RETURNING is supported (SQLite/Postgres yes; MySQL no). */
  readonly returning: boolean;
  /** Coerce a JS value for binding (e.g. boolean → 0/1 on SQLite). */
  encode(v: unknown): unknown;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Column/table names come from developer schema keys (and validated `where` keys),
// never raw user input — but we still guard the identifier shape before interpolating.
function checkIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`invalid identifier: ${name}`);
  return name;
}

/** SQLite (DO SQLite and D1 both speak this). Bare identifiers, `?` placeholders,
 * booleans stored as INTEGER 0/1, RETURNING supported. */
export const sqliteDialect: Dialect = {
  id: checkIdent,
  placeholder: () => "?",
  returning: true,
  encode: (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v),
};

/** Postgres (e.g. over Hyperdrive). Double-quoted identifiers preserve case (so
 * `ownerId` doesn't fold to `ownerid`), `$n` placeholders, native booleans,
 * RETURNING supported. */
export const postgresDialect: Dialect = {
  id: (name) => `"${checkIdent(name)}"`,
  placeholder: (n) => `$${n}`,
  returning: true,
  encode: (v) => v, // the pg driver handles type encoding
};

export interface Driver {
  readonly dialect: Dialect;
  /** Run a parameterized statement and return the result rows (empty for writes
   * without RETURNING). Params are already dialect-encoded by the caller. */
  exec(sql: string, params: unknown[]): Promise<Row[]>;
  /** Run `fn` inside a transaction: commit on resolve, roll back on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** DO SQLite — the in-process store. `SqlStorage` is synchronous; we wrap it as an
 * async Driver. Transactions use the DO's atomic `transaction()`. */
export class DoSqliteDriver implements Driver {
  readonly dialect = sqliteDialect;
  constructor(private readonly storage: DurableObjectStorage) {}

  async exec(sql: string, params: unknown[]): Promise<Row[]> {
    return this.storage.sql.exec(sql, ...params).toArray() as Row[];
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.storage.transaction(fn);
  }
}

/** D1 — SQLite over RPC. Async by nature. D1 has no interactive transactions, so
 * `transaction()` runs `fn` without one (a documented limitation: mutations don't
 * roll back on throw the way they do on a DO). Use a DO when you need that. */
export class D1Driver implements Driver {
  readonly dialect = sqliteDialect;
  constructor(private readonly db: D1Database) {}

  async exec(sql: string, params: unknown[]): Promise<Row[]> {
    const stmt = params.length ? this.db.prepare(sql).bind(...params) : this.db.prepare(sql);
    const { results } = await stmt.all<Row>();
    return results ?? [];
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
