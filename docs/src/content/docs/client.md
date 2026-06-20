---
title: Clients
order: 8
summary: Typed RPC and live subscriptions from the browser with @pramen/client and @pramen/react.
---

## @pramen/client

A typed client: `call()` is RPC over HTTP, `subscribe()` is a live query over an
auto-reconnecting WebSocket. It is generic over your server's handler map, so calls
are fully typed with **no runtime dependency** on the server — import the type only.

```ts
import { createClient } from "@pramen/client";
import type { app } from "../server/app"; // type-only, erased at build

const pramen = createClient<typeof app.handlers>({ url, token, tenant: "acme" });

const note = await pramen.call("createNote", { title: "hi", body: "..." }); // typed
const stop = pramen.subscribe("listNotes", undefined, { onData: (notes) => render(notes) });
```

## @pramen/react

Hooks that re-render on every server push:

```tsx
import { useLiveQuery, useMutation } from "@pramen/react";

function Notes({ pramen }) {
  const { data, loading } = useLiveQuery(pramen, "listNotes");
  const createNote = useMutation(pramen, "createNote");

  if (loading) return <p>Loading…</p>;
  return (
    <>
      <ul>{data.map((n) => <li key={n.id}>{n.title}</li>)}</ul>
      <button onClick={() => createNote({ title: "New", body: "" })}>Add</button>
    </>
  );
}
```

Because the client is generic over `typeof app.handlers`, handler names, inputs, and
result shapes are all checked at compile time — a typo or a wrong input type is a
build error, not a runtime surprise.
