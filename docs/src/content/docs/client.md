---
title: Clients
order: 8
summary: Typed RPC and live subscriptions from the browser with @mrak/client and @mrak/react.
---

## @mrak/client

A typed client: `call()` is RPC over HTTP, `subscribe()` is a live query over an
auto-reconnecting WebSocket. It is generic over your server's handler map, so calls
are fully typed with **no runtime dependency** on the server — import the type only.

```ts
import { createClient } from "@mrak/client";
import type { app } from "../server/app"; // type-only, erased at build

const mrak = createClient<typeof app.handlers>({ url, token, tenant: "acme" });

const note = await mrak.call("createNote", { title: "hi", body: "..." }); // typed
const stop = mrak.subscribe("listNotes", undefined, { onData: (notes) => render(notes) });
```

## @mrak/react

Hooks that re-render on every server push:

```tsx
import { useLiveQuery, useMutation } from "@mrak/react";

function Notes({ mrak }) {
  const { data, loading } = useLiveQuery(mrak, "listNotes");
  const createNote = useMutation(mrak, "createNote");

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
