// MrakDO — the database. One instance per tenant (see src/index.ts routing).
// Holds the SQLite store in-process, applies the schema on boot, and dispatches
// handler RPCs. This is the Cloudflare analog of a the prior runtime V8 worker bound to its
// own Turso connection — except single-writer serialization is provided by the
// platform rather than enforced by hand.

import { DurableObject } from "cloudflare:workers";
import { app } from "../example/app";
import { schemaDDL } from "./runtime/ddl";
import { Db } from "./runtime/db";
import { dispatch } from "./runtime/dispatch";

export class MrakDO extends DurableObject {
  private readonly db: Db;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.db = new Db(ctx.storage.sql);

    // Apply DDL before any request is served. blockConcurrencyWhile guarantees
    // no fetch() runs until the schema is in place.
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of schemaDDL(app.schema)) {
        ctx.storage.sql.exec(stmt);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).pathname.replace(/^\/rpc\//, "");
    let input: unknown;
    if (request.method === "POST") {
      input = await request.json().catch(() => undefined);
    }

    try {
      const result = await dispatch(app.handlers, this.db, this.ctx.storage, name, input);
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 400 });
    }
  }
}
