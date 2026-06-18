// Live-query smoke test, including row-level invalidation. Run against
// `wrangler dev` (default port 8799):
//   bun run scripts/live-smoke.ts [port]
//
// Proves:
//  - subscribe -> initial data
//  - a mutation pushes fresh results to affected subscriptions (HTTP and WS)
//  - row-level: inserting a note wakes listNotes but NOT a getNote(other id);
//    updating that row wakes its getNote view (and listNotes).

const port = process.argv[2] ?? "8799";
const httpBase = `http://localhost:${port}`;
const wsUrl = `ws://localhost:${port}/live`;
const TENANT = "live-demo";
const AUTH = "Bearer admin"; // full access — this test isn't about ACL

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

const ws = new WebSocket(wsUrl, {
  headers: { authorization: AUTH, "x-mrak-tenant": TENANT },
} as any);
const inbox: any[] = [];
let notify: (() => void) | null = null;
ws.addEventListener("message", (e) => {
  inbox.push(JSON.parse(String(e.data)));
  notify?.();
});

function next(pred: (m: any) => boolean, label: string): Promise<any> {
  return deadline(
    new Promise((resolve) => {
      const scan = () => {
        const idx = inbox.findIndex(pred);
        if (idx >= 0) {
          notify = null; // stop this resolved waiter from eating later frames
          resolve(inbox.splice(idx, 1)[0]);
        } else {
          notify = scan;
        }
      };
      scan();
    }),
    5000,
    label,
  );
}

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
};

const dataFor = (id: string) => (m: any) => m.type === "data" && m.id === id;
const post = (name: string, input?: unknown) =>
  fetch(`${httpBase}/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH, "x-mrak-tenant": TENANT },
    body: JSON.stringify(input ?? {}),
  }).then((r) => r.json());

await deadline(new Promise<void>((res) => ws.addEventListener("open", () => res())), 5000, "ws open");
console.log("connected", wsUrl);

// Anchor row we will keep a single-row subscription on.
const anchor = await post("createNote", { title: "anchor", body: "original" });
assert(anchor.ok, "created anchor note");
const anchorId = anchor.result.id as number;

// Subscribe to a list view and a single-row view.
ws.send(JSON.stringify({ type: "subscribe", id: "list", name: "listNotes" }));
const list0 = await next(dataFor("list"), "initial list");
ws.send(JSON.stringify({ type: "subscribe", id: "one", name: "getNote", input: { id: anchorId } }));
const one0 = await next(dataFor("one"), "initial one");
assert(one0.result.id === anchorId, "single-row sub seeded with the anchor row");
const baseCount = list0.result.length;
inbox.length = 0;

// --- row-level: INSERT a different row ---
await post("createNote", { title: "other", body: "unrelated" });
const listPush = await next(dataFor("list"), "list push after insert");
assert(listPush.result.length === baseCount + 1, "list grew by one after insert");
await sleep(400); // give any erroneous push time to arrive
assert(!inbox.some(dataFor("one")), "NO push to getNote(anchor) on an unrelated insert");
inbox.length = 0;

// --- row-level: UPDATE the anchor row ---
await post("updateNote", { id: anchorId, title: "anchor-updated" });
const onePush = await next(dataFor("one"), "getNote push after its row updated");
assert(onePush.result.title === "anchor-updated", "single-row sub reflects the update");
assert(inbox.some(dataFor("list")), "list also pushed (its row content changed)");

ws.close();
console.log("\nALL LIVE-QUERY + ROW-LEVEL CHECKS PASSED");
process.exit(0);
