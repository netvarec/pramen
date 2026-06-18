// Cursor (keyset) pagination: walking pages with `after` covers every row once,
// in order, with correct hasMore/cursor signalling; an invalid cursor is a 400.

import { assert, http, token } from "../lib";

export async function runPagination(base: string): Promise<void> {
  const TENANT = "page-demo";
  const post = http(base, TENANT);
  const admin = await token("admin", ["admin"]);

  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push((await post("createNote", { title: `p${i}`, body: "x" }, admin)).body.result.id);

  // Walk forward in pages of 2.
  const seen: number[] = [];
  let after: string | undefined;
  let pages = 0;
  for (;;) {
    const r = await post("pageNotes", { limit: 2, after }, admin);
    assert(r.status === 200, "pageNotes ok");
    const page = r.body.result;
    for (const n of page.items) seen.push(n.id);
    pages++;
    if (!page.hasMore) {
      assert(page.cursor != null || page.items.length === 0, "last page still returns a cursor for its tail");
      break;
    }
    assert(page.items.length === 2, "a non-final page is full (limit 2)");
    after = page.cursor;
    assert(typeof after === "string", "non-final page returns a cursor");
    if (pages > 10) throw new Error("pagination did not terminate");
  }

  assert(pages === 3, "5 rows over limit 2 => 3 pages (2 + 2 + 1)");
  assert(JSON.stringify(seen) === JSON.stringify(ids), "every row seen exactly once, in ascending id order");

  // Descending order paginates too.
  const desc = await post("pageNotes", { limit: 3, dir: "desc" }, admin);
  assert(
    JSON.stringify(desc.body.result.items.map((n: any) => n.id)) === JSON.stringify([...ids].reverse().slice(0, 3)),
    "descending first page returns the three highest ids",
  );

  // A garbage cursor is rejected at the boundary.
  const bad = await post("pageNotes", { after: "not-a-real-cursor!!" }, admin);
  assert(bad.status === 400 && bad.body.code === "bad_request", "invalid cursor -> 400 bad_request");
}
