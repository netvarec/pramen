#!/usr/bin/env bun
// mrak CLI. Run with `bun scripts/cli.ts <command>` (or `mrak <command>` once installed).
//
//   mrak help
//   mrak init [dir]
//   mrak schema sql                 print CREATE TABLE for the schema
//   mrak schema hash                print the schema hash
//   mrak schema snapshot            save the current schema to .mrak/schema.json
//   mrak schema diff                compare the schema to the snapshot (safe vs unsafe changes)
//   mrak schema status [--tenant t] [--url u] [--token jwt]   compare a deployed tenant to the schema
//   mrak token <sub> [roles...] [--tenant a,b]                mint a dev JWT

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTableSql } from "../src/runtime/ddl";
import { schemaHash } from "../src/runtime/migrate";
import { diffSchemaShape, schemaShape, type SchemaShape } from "../src/runtime/schema-diff";
import type { SchemaDef } from "../src/sdk/schema";
import { sign } from "./jwt";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) i++; // skip flag + its value
    else out.push(args[i]!);
  }
  return out;
}

function fail(msg: string): never {
  console.error(`mrak: ${msg}`);
  process.exit(1);
}

async function loadApp(): Promise<{ schema: SchemaDef }> {
  const explicit = flag("app");
  const candidates = explicit ? [explicit] : ["./app.ts", "./example/app.ts"];
  for (const c of candidates) {
    const p = resolve(process.cwd(), c);
    if (existsSync(p)) {
      const mod = (await import(p)) as { app?: { schema?: SchemaDef } };
      if (mod.app?.schema) return mod.app as { schema: SchemaDef };
      fail(`${c} does not export { app }`);
    }
  }
  return fail(`no app found (looked for ${candidates.join(", ")}); pass --app <path>`);
}

const HELP = `mrak — reactive backend on Cloudflare

Usage: mrak <command>

  help                      show this help
  init [dir]                scaffold a new project (app.ts + oblaka.ts)
  schema sql                print CREATE TABLE statements for the schema
  schema hash               print the schema hash
  schema snapshot           save the schema shape to .mrak/schema.json
  schema diff               compare the schema to the snapshot (safe vs unsafe)
  schema status             compare a deployed tenant's schema to the local schema
                            [--tenant t] [--url u] [--token jwt]
  token <sub> [roles...]    mint a dev JWT [--tenant a,b]

Flags: --app <path> to point at your app module (default ./app.ts or ./example/app.ts).`;

async function schemaCmd(sub: string | undefined): Promise<void> {
  const snapshotPath = resolve(process.cwd(), ".mrak/schema.json");

  if (sub === "sql") {
    const { schema } = await loadApp();
    for (const [table, def] of Object.entries(schema)) console.log(createTableSql(table, def) + ";");
    return;
  }
  if (sub === "hash") {
    const { schema } = await loadApp();
    console.log(schemaHash(schema));
    return;
  }
  if (sub === "snapshot") {
    const { schema } = await loadApp();
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const snap = { hash: schemaHash(schema), shape: schemaShape(schema) };
    writeFileSync(snapshotPath, JSON.stringify(snap, null, 2) + "\n");
    console.log(`wrote ${snapshotPath} (${Object.keys(snap.shape).length} tables)`);
    return;
  }
  if (sub === "diff") {
    const { schema } = await loadApp();
    const next = schemaShape(schema);
    if (!existsSync(snapshotPath)) {
      console.log("no snapshot — run `mrak schema snapshot` to set a baseline.");
      return;
    }
    const prev = (JSON.parse(readFileSync(snapshotPath, "utf8")) as { shape: SchemaShape }).shape;
    const changes = diffSchemaShape(prev, next);
    if (changes.length === 0) {
      console.log("no changes since snapshot.");
      return;
    }
    for (const c of changes) {
      const where = c.column ? `${c.table}.${c.column}` : c.table;
      const note = c.detail ? ` (${c.detail})` : "";
      console.log(`${c.destructive ? "  ⚠" : "  +"} ${c.kind} ${where}${note}${c.destructive ? "  [destructive]" : ""}`);
    }
    console.log("\nAll changes are auto-applied on the next DO boot.");
    if (changes.some((c) => c.destructive))
      console.log("⚠ destructive changes rebuild the table and CAN lose data. A drop+add is applied as such unless\n  the column declares `renamedFrom` (which migrates the data).");
    return;
  }
  if (sub === "status") {
    const { schema } = await loadApp();
    const url = flag("url") ?? "http://localhost:8787";
    const tenant = flag("tenant") ?? "main";
    const token = flag("token") ?? (await sign({ sub: "cli", roles: ["admin"] }));
    const res = await fetch(`${url}/admin/schema?tenant=${encodeURIComponent(tenant)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { hash: string | null; tables: Record<string, string[]> };
      error?: string;
    };
    if (!res.ok || !body.ok || !body.result) fail(`status failed: ${body.error ?? res.status}`);
    const live = body.result!;
    const current = schemaHash(schema);
    console.log(`tenant:  ${tenant}`);
    console.log(`live:    ${live.hash ?? "(none)"}`);
    console.log(`current: ${current}`);
    console.log(live.hash === current ? "✓ up to date" : "⚠ BEHIND — migrates on the tenant's next boot");
    const want = schemaShape(schema);
    for (const table of Object.keys(want)) {
      const liveCols = new Set(live.tables[table] ?? []);
      const missing = Object.keys(want[table]!).filter((col) => !liveCols.has(col));
      if (!live.tables[table]) console.log(`  + table ${table} (not yet created live)`);
      else if (missing.length) console.log(`  + ${table}: ${missing.join(", ")} (not yet added live)`);
    }
    return;
  }
  console.log(HELP);
}

async function tokenCmd(args: string[]): Promise<void> {
  const pos = positionals(args);
  const sub = pos[0];
  if (!sub) fail("token: <sub> required");
  const roles = pos.slice(1);
  const tenants = flag("tenant")?.split(",");
  console.log(await sign({ sub, roles: roles.length ? roles : ["admin"], ...(tenants ? { tenants } : {}) }));
}

function initCmd(args: string[]): void {
  const dir = resolve(process.cwd(), positionals(args)[0] ?? ".");
  mkdirSync(dir, { recursive: true });
  const write = (name: string, content: string) => {
    const p = resolve(dir, name);
    if (existsSync(p)) return void console.log(`  skip ${name} (exists)`);
    writeFileSync(p, content);
    console.log(`  + ${name}`);
  };
  write("app.ts", APP_TEMPLATE);
  write("oblaka.ts", OBLAKA_TEMPLATE);
  console.log(`\nScaffolded a mrak project in ${dir}.`);
  console.log("Next: wire the server entry (src/index.ts), then `oblaka oblaka.ts && wrangler dev`.");
}

const APP_TEMPLATE = `import { Entity, defineSchema, createApp } from "mrak";

const schema = defineSchema({
  notes: Entity((t) => ({ id: t.id(), title: t.text(), body: t.text(), createdAt: t.int() })),
});

const { query, mutation } = createApp(schema);

const handlers = {
  listNotes: query((ctx) => ctx.db.find({ from: "notes", orderBy: { column: "id", dir: "desc" } })),
  createNote: mutation((ctx, input: { title: string; body: string }) =>
    ctx.db.insert("notes", { title: input.title, body: input.body, createdAt: Date.now() }),
  ),
};

// Deny-by-default. Grant access with role()/policy(); see the mrak docs.
const acl: never[] = [];

export const app = { schema, handlers, acl };
`;

const OBLAKA_TEMPLATE = `import { define, DurableObject, KVNamespace, Worker } from "oblaka-iac";

const PROJECT = "my-mrak-app"; // unique per project — namespaces all CF resources

export default define(({ env }) => {
  const vars = env === "local" ? { AUTH_SECRET: "dev-secret-change-me" } : {};
  return new Worker({
    dir: ".",
    name: PROJECT,
    main: "./src/index.ts",
    compatibility_date: "2026-06-19",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true },
    bindings: {
      MRAK: new DurableObject({ name: PROJECT + "-store", className: "MrakDO" }),
      KV: new KVNamespace({ name: PROJECT + "-kv" }),
    },
    vars,
  });
});
`;

async function main(): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    case "init":
      return initCmd(argv.slice(1));
    case "schema":
      return schemaCmd(argv[1]);
    case "token":
      return tokenCmd(argv.slice(1));
    default:
      console.error(`mrak: unknown command "${cmd}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

await main();
