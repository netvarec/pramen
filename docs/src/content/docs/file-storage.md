---
title: File storage
order: 9
summary: Store files in R2 with a fileRef column, ctx.files signed URLs, and direct-to-storage uploads — bytes never touch the database.
---

## The model

Files live in **R2**, not in the database. A `fileRef` column stores only small JSON
metadata — never the bytes:

```ts
const schema = defineSchema({
  notes: Entity((t) => ({
    id: t.id(),
    title: t.text(),
    attachment: t.fileRef(), // { key, size, contentType, filename?, uploadedAt? }
  })),
});
```

The bytes are an R2 object addressed by a tenant-scoped `key`. The column is an
ordinary field for ACL purposes (projected away for roles that can't read it), and
the metadata round-trips as a `FileRef` object through reads, writes, and relations.

## ctx.files

Handlers get `ctx.files`, a per-tenant facade. They never touch the R2 binding
directly:

```ts
// mint a signed upload URL + draft metadata (call from a mutation)
const { url, ref } = await ctx.files.signUpload({ contentType, filename, maxSize });

// mint a signed download URL — ONLY after an ACL'd read of the owning row
const { url } = await ctx.files.signDownload(note.attachment, { download: true });

// confirm an upload landed / cascade-delete a blob
const head = await ctx.files.head(ref.key);
await ctx.files.delete(ref.key);
```

Knowing a key is **not** authorization: a download URL only exists because a handler
read the row through `ctx.db` (so row/field ACL gated it) and chose to sign one.

## The upload flow

Bytes go **directly** between the client and R2 through the Worker — they never pass
through the Durable Object.

```ts
// server
const handlers = {
  requestUpload: mutation((ctx, input: { contentType: string; filename?: string }) => {
    if (!ctx.identity?.userId) throw new Forbidden("auth required");
    return ctx.files.signUpload({ ...input, maxSize: 5_000_000 });
  }),

  attachToNote: mutation(async (ctx, input: { id: number; ref: FileRef }) => {
    const head = await ctx.files.head(input.ref.key); // confirm it's really in R2
    if (!head) throw new BadRequest("upload not found");
    return ctx.db.update("notes", input.id, {
      attachment: { ...input.ref, size: head.size },
    });
  }),

  getNoteAttachment: query(async (ctx, input: { id: number }) => {
    const [note] = await ctx.db.find({ from: "notes", where: { id: input.id }, limit: 1 });
    return note?.attachment ? ctx.files.signDownload(note.attachment, { download: true }) : null;
  }),
};
```

```ts
// client (@pramen/client)
const { url, ref } = await pramen.call("requestUpload", { contentType: file.type, filename: file.name });
await pramen.upload(url, file, { contentType: file.type }); // PUTs bytes to R2
await pramen.call("attachToNote", { id, ref });

const dl = await pramen.call("getNoteAttachment", { id });
window.location.href = pramen.fileUrl(dl.url); // resolve the relative signed URL
```

## How it works

- Upload/download stream through the Worker's `/files/upload` (PUT) and
  `/files/download` (GET) routes, authorized purely by an **HMAC token** in the URL —
  no S3 credentials, and no bytes through the Durable Object.
- Signed URLs are **relative**, so the server never needs to know its own public
  origin; the client resolves them with `pramen.fileUrl(...)`.
- The token secret is `FILES_SECRET` (falls back to `AUTH_SECRET`). Tokens are scoped
  to a tenant + key + operation (get/put) and expire.
- Size-capped uploads must declare a `content-length`; downloads are served with
  `X-Content-Type-Options: nosniff` and an attachment disposition.

## Configuration

Declare the R2 bucket in `oblaka.ts`:

```ts
bindings: {
  // …
  FILES: new R2Bucket({ name: `${PROJECT}-files` }),
},
```

`FILES_SECRET` is a dev var locally; set it as a secret in real environments
(`wrangler secret put FILES_SECRET`).
