import { useState } from "preact/hooks";

// pramen runs the same schema / handlers / ACL over different stores (the Driver
// seam). This island walks a dev through a couple of use-case questions and
// recommends one. Decision tree below: questions branch to other questions or to
// a result; results map into STORES.

type StoreId = "do" | "d1" | "pg";

interface Store {
  name: string;
  badge: string;
  badgeKind: "default" | "available" | "roadmap";
  tagline: string;
  best: string[];
  setup: string;
  watch: string[];
}

const STORES: Record<StoreId, Store> = {
  do: {
    name: "Durable Object SQLite",
    badge: "Default",
    badgeKind: "default",
    tagline: "Per-tenant in-process SQLite — pramen's transactional write path.",
    best: [
      "Live queries (the server pushes fresh results in real time)",
      "Per-tenant isolation, with free single-writer transactions",
      "Sub-millisecond in-process reads and point-in-time recovery",
    ],
    setup: "Nothing to configure — use ctx.db in your handlers; subscribe over /live.",
    watch: ["~10 GB per Durable Object", "Cross-tenant queries are awkward (data lives per-tenant)"],
  },
  d1: {
    name: "Worker + D1",
    badge: "Available",
    badgeKind: "available",
    tagline: "The same engine over D1 — no Durable Object. A shared relational store.",
    best: [
      "One shared dataset you query across everything (reports, joins, search)",
      "Read-scale: reads fan out to D1 read replicas (Sessions API), read-your-writes",
      "You don't need live queries",
      "Cloudflare-native — no database to operate",
    ],
    setup: "Send x-pramen-store: d1 (or set PRAMEN_STORE=d1 as the default). Same schema, ACL and handlers; RPC only. @pramen/client carries the read-your-writes bookmark for you.",
    watch: [
      "No live queries (those need a Durable Object)",
      "No interactive transactions / rollback-on-throw (D1 limitation)",
      "One shared database (add a tenant column for multi-tenancy)",
    ],
  },
  pg: {
    name: "Hyperdrive + Postgres",
    badge: "Roadmap",
    badgeKind: "roadmap",
    tagline: "The same engine over your own Postgres/MySQL, via Hyperdrive.",
    best: [
      "You already run Postgres/MySQL (or want BI tools / services on the DB)",
      "Large or inherently shared data",
      "Real interactive transactions on a shared store",
    ],
    setup: "The Driver/Dialect seam is ready (postgresDialect); a pg Driver over Hyperdrive is the remaining piece.",
    watch: ["No live queries (those need a Durable Object)", "You operate the database"],
  },
};

interface Option {
  label: string;
  detail?: string;
  go: string; // next node id (question or "r_*")
}
type Node =
  | { kind: "question"; prompt: string; help?: string; options: Option[] }
  | { kind: "result"; store: StoreId };

const TREE: Record<string, Node> = {
  q1: {
    kind: "question",
    prompt: "Do you need live queries?",
    help: "The server pushing updated results to connected clients in real time (subscriptions over a WebSocket).",
    options: [
      { label: "Yes — real-time push to clients", go: "r_do" },
      { label: "No", go: "q2" },
    ],
  },
  q2: {
    kind: "question",
    prompt: "How is your data shaped?",
    options: [
      {
        label: "Isolated per tenant / entity",
        detail: "each customer, room, or document is its own little world",
        go: "r_do",
      },
      {
        label: "One shared dataset",
        detail: "queried across everything — cross-tenant reports, joins, search",
        go: "q3",
      },
    ],
  },
  q3: {
    kind: "question",
    prompt: "Do you already run — or want to use — an external Postgres/MySQL?",
    help: "e.g. for BI tools, existing services hitting the DB directly, or very large data.",
    options: [
      { label: "Yes", go: "r_pg" },
      { label: "No — keep it Cloudflare-native", go: "r_d1" },
    ],
  },
  r_do: { kind: "result", store: "do" },
  r_d1: { kind: "result", store: "d1" },
  r_pg: { kind: "result", store: "pg" },
};

export default function StoreWizard() {
  const [path, setPath] = useState<string[]>(["q1"]);
  const currentId = path[path.length - 1]!;
  const node = TREE[currentId]!;
  const step = path.filter((id) => TREE[id]!.kind === "question").length;

  const choose = (go: string) => setPath((p) => [...p, go]);
  const back = () => setPath((p) => (p.length > 1 ? p.slice(0, -1) : p));
  const restart = () => setPath(["q1"]);

  return (
    <div class="wiz">
      {node.kind === "question" ? (
        <div class="wiz-question">
          <div class="wiz-step">Question {step} of 3</div>
          <h3 class="wiz-prompt">{node.prompt}</h3>
          {node.help && <p class="wiz-help">{node.help}</p>}
          <div class="wiz-options">
            {node.options.map((o) => (
              <button class="wiz-option" onClick={() => choose(o.go)}>
                <span class="wiz-option-label">{o.label}</span>
                {o.detail && <span class="wiz-option-detail">{o.detail}</span>}
              </button>
            ))}
          </div>
          {path.length > 1 && (
            <button class="wiz-back" onClick={back}>
              ← Back
            </button>
          )}
        </div>
      ) : (
        <Result store={STORES[node.store]} onRestart={restart} />
      )}
    </div>
  );
}

function Result({ store, onRestart }: { store: Store; onRestart: () => void }) {
  return (
    <div class="wiz-result">
      <div class="wiz-result-head">
        <div class="wiz-recommend">Recommended store</div>
        <span class={`wiz-badge wiz-badge-${store.badgeKind}`}>{store.badge}</span>
      </div>
      <h3 class="wiz-store-name">{store.name}</h3>
      <p class="wiz-tagline">{store.tagline}</p>

      <div class="wiz-section">
        <h4>Why</h4>
        <ul class="wiz-good">
          {store.best.map((b) => (
            <li>{b}</li>
          ))}
        </ul>
      </div>

      <div class="wiz-section">
        <h4>Setup</h4>
        <p class="wiz-setup">{store.setup}</p>
      </div>

      <div class="wiz-section">
        <h4>Watch out for</h4>
        <ul class="wiz-watch">
          {store.watch.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      </div>

      <button class="wiz-restart" onClick={onRestart}>
        ↺ Start over
      </button>
    </div>
  );
}
