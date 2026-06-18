// Live-query smoke test. Run against `wrangler dev` (default port 8799):
//   bun run scripts/live-smoke.ts [port]
//
// 1. open WS /live, subscribe to listNotes -> expect initial data
// 2. createNote over HTTP -> expect a pushed data update on the subscription
// 3. createNote over WS via "call" -> expect a result reply + another push

const port = process.argv[2] ?? "8799";
const httpBase = `http://localhost:${port}`;
const wsUrl = `ws://localhost:${port}/live`;

function deadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

const ws = new WebSocket(wsUrl);
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
          notify = null; // critical: stop this resolved waiter from eating later frames
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

await deadline(
  new Promise<void>((res) => ws.addEventListener("open", () => res())),
  5000,
  "ws open",
);
console.log("connected", wsUrl);

const isS1Data = (m: any) => m.type === "data" && m.id === "s1";

// 1. subscribe
ws.send(JSON.stringify({ type: "subscribe", id: "s1", name: "listNotes" }));
const initial = await next(isS1Data, "initial data");
const baseCount = initial.result.length;
console.log(`subscribed; initial listNotes count = ${baseCount}`);
inbox.length = 0; // drain so the next s1 frame is unambiguously the push

// 2. mutate over HTTP -> expect a push
const created = await (
  await fetch(`${httpBase}/rpc/createNote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "live-http", body: "via http" }),
  })
).json();
assert(created.ok, "http createNote succeeded");

const push1 = await next(isS1Data, "push after HTTP mutation");
assert(push1.result.length === baseCount + 1, "HTTP push grew the result by one");
assert(push1.result[0].title === "live-http", "HTTP push includes the created note");
inbox.length = 0;

// 3. mutate over WS "call" -> expect result reply + another push
ws.send(JSON.stringify({ type: "call", id: "c1", name: "createNote", input: { title: "live-ws", body: "via ws" } }));
const callReply = await next((m) => m.type === "result" && m.id === "c1", "call reply");
assert(callReply.result.title === "live-ws", "WS call returned the created note");

const push2 = await next(isS1Data, "push after WS mutation");
assert(push2.result.length === baseCount + 2, "WS push grew the result by two");
assert(push2.result[0].title === "live-ws", "WS push includes the WS-created note");

ws.close();
console.log("\nALL LIVE-QUERY CHECKS PASSED");
process.exit(0);
