// Kv — a thin, prefixed wrapper over the project's Workers KV namespace, handed
// to handlers as ctx.kv.
//
// Two levels of namespacing keep things isolated:
//  - Across projects: each project declares its own KV namespace in oblaka.ts
//    (named per project), so projects in one account never share a namespace.
//  - Within the namespace: keys are prefixed (`app:` for handler data) so they
//    never collide with mrak-internal keys (the tenant registry uses `tenant:`).
//
// ctx.kv is GLOBAL across all tenants of the project — use it for config, feature
// flags, and caches, NOT per-tenant data (that's ctx.db). KV is eventually
// consistent and is NOT part of a mutation's transaction.

export class Kv {
  constructor(
    private readonly ns: KVNamespace,
    private readonly prefix = "app:",
  ) {}

  private full(key: string): string {
    return this.prefix + key;
  }

  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string, type?: "json"): Promise<string | null | unknown> {
    return type === "json" ? this.ns.get(this.full(key), "json") : this.ns.get(this.full(key), "text");
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    await this.ns.put(this.full(key), value, opts);
  }

  async delete(key: string): Promise<void> {
    await this.ns.delete(this.full(key));
  }

  /** List keys under an (app-relative) prefix; returned names have the internal
   * prefix stripped. cursor is null when the listing is complete. */
  async list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor: string | null }> {
    const res = await this.ns.list({ prefix: this.full(opts?.prefix ?? ""), limit: opts?.limit, cursor: opts?.cursor });
    return {
      keys: res.keys.map((k) => k.name.slice(this.prefix.length)),
      cursor: res.list_complete ? null : ((res as { cursor?: string }).cursor ?? null),
    };
  }
}
