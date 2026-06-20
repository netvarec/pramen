// Shared helpers for the e2e suites. Each suite is an async function that throws
// on the first failed assertion; test/e2e.test.ts boots one wrangler-dev server
// and runs them all against distinct tenants.

export { sign, token } from "../scripts/jwt";

export function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

export interface Res {
  status: number;
  body: any;
}

/** An HTTP caller bound to a base URL + tenant. */
export function http(base: string, tenant: string) {
  return async (name: string, input: unknown, bearer?: string): Promise<Res> => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-pramen-tenant": tenant };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const r = await fetch(`${base}/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(input ?? {}) });
    return { status: r.status, body: await r.json() };
  };
}

/** A minimal live-query WebSocket client with an inbox + predicate waiter. */
export function wsClient(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as any);
  const inbox: any[] = [];
  let notify: (() => void) | null = null;
  ws.addEventListener("message", (e) => {
    inbox.push(JSON.parse(String(e.data)));
    notify?.();
  });

  const ready = new Promise<void>((res) => ws.addEventListener("open", () => res()));

  function next(pred: (m: any) => boolean, label: string, ms = 5000): Promise<any> {
    return Promise.race([
      new Promise<any>((resolve) => {
        const scan = () => {
          const i = inbox.findIndex(pred);
          if (i >= 0) {
            notify = null; // stop this resolved waiter from eating later frames
            resolve(inbox.splice(i, 1)[0]);
          } else notify = scan;
        };
        scan();
      }),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
    ]);
  }

  return {
    ready,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next,
    drain: () => {
      inbox.length = 0;
    },
    has: (pred: (m: any) => boolean) => inbox.some(pred),
    close: () => ws.close(),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
