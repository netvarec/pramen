// @pramen/client end-to-end against the running server: typed RPC over HTTP, and a
// live subscription over WebSocket (using query-string auth, the browser path)
// that receives a push after a mutation.

import { createClient } from "@pramen/client";
import { assert, sleep, token } from "../lib";
import type { app } from "../../example/app";

async function waitUntil(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error("waitUntil: timed out");
}

export async function runClient(base: string): Promise<void> {
  const tok = await token("admin", ["admin"]);
  const client = createClient<typeof app.handlers>({ url: base, token: tok, tenant: "client-demo" });

  // typed RPC over HTTP
  const created = await client.call("createNote", { title: "via-client", body: "x" });
  assert((created as { title?: string }).title === "via-client", "client.call() creates a note (typed RPC over HTTP)");

  // live subscription over WebSocket (auth via query string — the browser path)
  let latest: Array<{ title?: string }> = [];
  let pushes = 0;
  const stop = client.subscribe("listNotes", undefined, {
    onData: (notes) => {
      latest = notes as Array<{ title?: string }>;
      pushes++;
    },
  });

  await waitUntil(() => pushes >= 1);
  const initial = latest.length;
  assert(initial >= 1, "client.subscribe() delivers the initial result");

  // a mutation pushes to the live subscription
  await client.call("createNote", { title: "client-live", body: "y" });
  await waitUntil(() => latest.some((n) => n.title === "client-live"));
  assert(latest.some((n) => n.title === "client-live"), "client subscription receives a live push after a mutation");
  assert(latest.length === initial + 1, "live result grew by one");

  stop();
  client.close();
}
