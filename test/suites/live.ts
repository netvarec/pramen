// Live queries + row-level invalidation: subscribe, then verify pushes after
// HTTP and WS mutations, and that an unrelated insert wakes listNotes but NOT a
// getNote(other id) view, while updating that row does.

import { assert, http, sleep, token, wsClient } from "../lib";

export async function runLive(base: string, wsUrl: string): Promise<void> {
  const TENANT = "live-demo";
  const post = http(base, TENANT);
  const auth = await token("admin", ["admin"]); // full access — this suite isn't about ACL

  const live = wsClient(wsUrl, { authorization: `Bearer ${auth}`, "x-mrak-tenant": TENANT });
  await live.ready;
  const isList = (m: any) => m.type === "data" && m.id === "list";
  const isOne = (m: any) => m.type === "data" && m.id === "one";

  const anchor = await post("createNote", { title: "anchor", body: "original" }, auth);
  assert(anchor.body.ok, "created anchor note");
  const anchorId = anchor.body.result.id as number;

  live.send({ type: "subscribe", id: "list", name: "listNotes" });
  const list0 = await live.next(isList, "initial list");
  live.send({ type: "subscribe", id: "one", name: "getNote", input: { id: anchorId } });
  const one0 = await live.next(isOne, "initial one");
  assert(one0.result.id === anchorId, "single-row sub seeded with the anchor row");
  const baseCount = list0.result.length;
  live.drain();

  // INSERT a different row -> list wakes, getNote(anchor) does not.
  await post("createNote", { title: "other", body: "unrelated" }, auth);
  const listPush = await live.next(isList, "list push after insert");
  assert(listPush.result.length === baseCount + 1, "list grew by one after insert");
  await sleep(400);
  assert(!live.has(isOne), "NO push to getNote(anchor) on an unrelated insert");
  live.drain();

  // UPDATE the anchor row -> its getNote wakes (and the list).
  await post("updateNote", { id: anchorId, title: "anchor-updated" }, auth);
  const onePush = await live.next(isOne, "getNote push after its row updated");
  assert(onePush.result.title === "anchor-updated", "single-row sub reflects the update");
  assert(live.has(isList), "list also pushed (its row content changed)");

  // WS "call" mutation also triggers pushes.
  live.drain();
  live.send({ type: "call", id: "c1", name: "createNote", input: { title: "via-ws", body: "z" } });
  const reply = await live.next((m) => m.type === "result" && m.id === "c1", "ws call reply");
  assert(reply.result.title === "via-ws", "WS call returned the created note");
  const wsPush = await live.next(isList, "list push after WS mutation");
  assert(wsPush.result.some((n: any) => n.title === "via-ws"), "WS mutation pushed to the list");
  live.close();
}
