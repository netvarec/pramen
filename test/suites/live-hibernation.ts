// A live subscription surviving DO hibernation.
//
// The DO holds subscriptions in MEMORY, keyed by socket, because the WS attachment is
// capped at ~2 KB and a full set does not fit. Hibernation drops that map — but it
// leaves the socket OPEN. So the client saw no close, never replayed, and the DO
// broadcast to a socket it no longer believed was subscribed to anything: pushes died
// silently, for the life of the tab, with every indicator still reading "connected".
// Only a reload brought them back.
//
// This suite has to wait, because hibernation is the thing under test. Measured on
// workerd: a five-second idle still pushes, a ten-second idle does not. IDLE_MS is three
// times the largest idle observed NOT to hibernate — the smallest wait that reliably
// reaches the bug.

import { assert, http, sleep, token, wsClient } from "../lib";

const IDLE_MS = 15_000;

export async function runLiveHibernation(base: string, wsUrl: string): Promise<void> {
  const TENANT = "live-hibernation";
  const post = http(base, TENANT);
  const auth = await token("admin", ["admin"]);
  const headers = { authorization: `Bearer ${auth}`, "x-pramen-tenant": TENANT };
  const isList = (m: any) => m.type === "data" && m.id === "list";

  await post("createNote", { title: "before", body: "x" }, auth);

  const live = wsClient(wsUrl, headers);
  await live.ready;
  live.send({ type: "subscribe", id: "list", name: "listNotes" });
  const seeded = await live.next(isList, "initial list");
  const baseCount = seeded.result.length as number;
  live.drain();

  // Long enough for the DO to hibernate and lose the subscription map.
  await sleep(IDLE_MS);

  await post("createNote", { title: "after-hibernation", body: "y" }, auth);

  // The DO cannot push — a woken instance has no record that this socket subscribed to
  // anything. Saying so is the whole fix: a close is what tells the client to replay.
  // Before it, this socket stayed open and deaf and the assertion below timed out.
  const code = await live.closed(8000);
  assert(code === 4410, `hibernated socket was closed 4410 to ask for a resubscribe (got ${code})`);

  // And replaying returns the state the lost push would have carried, so the round trip
  // costs the client a reconnect and nothing else.
  const again = wsClient(wsUrl, headers);
  await again.ready;
  again.send({ type: "subscribe", id: "list", name: "listNotes" });
  const replayed = await again.next(isList, "list after resubscribing");
  assert(replayed.result.length === baseCount + 1, "the write made during hibernation is in the replayed list");
  assert(
    replayed.result.some((n: any) => n.title === "after-hibernation"),
    "and it is the row that was actually written",
  );
  again.close();
}
