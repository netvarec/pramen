#!/usr/bin/env bun
// @pramen/cms CLI — ships as the `pramen-cms` bin.
//
//   pramen-cms help
//   pramen-cms types [--tenant t] [--url u] [--token jwt] [--out path]
//
// A separate bin from `pramen` on purpose: @pramen/cms is optional, so the runtime CLI
// should not carry a command named after it. `pramen` knows about schemas, tokens and
// scaffolding; this knows about content types. Both mint their dev token with the same
// `signDevToken` from @pramen/server, so there is one signer, not two.
//
// Bun shebang, matching the `pramen` bin: the built dist/ uses extensionless ESM imports.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { signDevToken } from "@pramen/server";
import { generateBlockTypes, type FieldDefinition } from "./index";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  // `--out` with an empty $OUT silently printed to stdout instead of erroring, and
  // `--tenant --out x` set tenant to "--out".
  if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value`);
  return v;
}
function fail(msg: string): never {
  console.error(`pramen-cms: ${msg}`);
  process.exit(1);
  throw new Error(msg); // unreachable — process.exit is typed as returning
}

const HELP = `pramen-cms — CLI for @pramen/cms

Usage: pramen-cms <command>

  help                      show this help
  types                     generate TS interfaces for a tenant's block types
                            [--tenant t] [--url u] [--token jwt] [--out path]

Block types are DATA — rows a webmaster adds with no deploy — so their shape is only
knowable from a running instance. \`types\` reads them from one and emits an interface per
slug plus a BlockFieldsBySlug registry. With no --out it prints.`;

/** A block-type row as the content API returns it. */
interface BlockTypeRow {
  slug: string;
  fieldsSchema?: FieldDefinition[] | null;
}

async function typesCmd(): Promise<void> {
  // Read every flag BEFORE the network call, so a malformed invocation fails on the
  // invocation rather than on whatever the fetch happens to do first.
  const url = flag("url") ?? "http://localhost:8787";
  const tenant = flag("tenant") ?? "main";
  const dest = flag("out");
  const token = flag("token") ?? (await signDevToken({ sub: "cli", roles: ["admin"] }));

  let res: Response;
  try {
    res = await fetch(`${url}/rpc/listBlockTypes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pramen-tenant": tenant, authorization: `Bearer ${token}` },
      body: "{}",
    });
  } catch (e) {
    // A wrong --url is the common mistake; surface it as a CLI error, not a stack trace.
    fail(`types: cannot reach ${url} (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = (await res!.json().catch(() => ({}))) as { ok?: boolean; result?: BlockTypeRow[]; error?: string };
  if (!res!.ok || body.ok !== true || !Array.isArray(body.result)) {
    fail(`types: listBlockTypes failed (${body.error ?? res!.status})`);
  }
  const rows = body.result!;
  // Refuse rather than write an empty module. A --tenant typo routes to a fresh Durable
  // Object whose cms_block_types is legitimately empty, so this is the likely cause — and
  // exiting 0 after clobbering src/cms.gen.ts would sail through a regenerate-and-diff CI.
  if (rows.length === 0) {
    fail(`types: tenant '${tenant}' has no block types — refusing to write an empty module (check --tenant/--url)`);
  }

  const out = generateBlockTypes(rows);
  if (!dest) {
    process.stdout.write(out); // composes with a pipe, like `pramen schema sql`
    return;
  }
  const path = resolve(process.cwd(), dest);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out);
  } catch (e) {
    // Same treatment as the fetch above — an unwritable --out is a CLI error, not a stack.
    fail(`types: cannot write ${dest} (${e instanceof Error ? e.message : String(e)})`);
  }
  console.log(`  + ${dest}  (${rows.length} block type${rows.length === 1 ? "" : "s"} from tenant '${tenant}')`);
}

async function main(): Promise<void> {
  switch (argv[0]) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    case "types":
      return typesCmd();
    default:
      console.error(`pramen-cms: unknown command "${argv[0]}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

await main();
