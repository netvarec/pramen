// Example app — schema, handlers, and ACL. The entire user-facing surface.
// In a finished pramen this would be deployed as a bundle at runtime; for the v0
// skeleton the DO imports it statically.

import {
  Entity,
  defineSchema,
  createApp,
  $identity,
  allow,
  deny,
  policy,
  resolve,
  role,
  $input,
  unique,
  defaultTo,
  BadRequest,
  Forbidden,
  type Identity,
  type FileRef,
  type JsonValue,
} from "@pramen/server";

// Reusable write rule: force ownerId to the authenticated caller (a client cannot
// forge it), even if the request body tries to set a different owner.
const ownedByCaller = { set: { ownerId: (i: Identity | null) => i?.userId ?? null } };

const schema = defineSchema({
  users: Entity(
    (t) => ({
      id: t.textId(), // PK = the JWT subject (e.g. "alice")
      name: t.text(),
      email: t.text(), // sensitive — not exposed via relation traversal
    }),
    (r) => ({ notes: r.hasMany("notes", "ownerId") }),
  ),
  notes: Entity(
    (t) => ({
      id: t.id(),
      title: t.text(),
      body: t.text(),
      ownerId: t.text(),
      createdAt: t.int(),
      // Arbitrary JSON metadata (tags, structured fields). Stored as a TEXT column;
      // handlers read/write the parsed value — db.ts codecs it.
      meta: t.json(),
      // Optional attached file (R2 object). Stored as JSON metadata (a FileRef),
      // not the bytes — see ctx.files + the upload/download handlers below.
      attachment: t.fileRef(),
    }),
    (r) => ({ owner: r.belongsTo("users", "ownerId") }),
  ),
  // Public-write entity for the anonymous-role + capability-read demo: a guest can
  // create a signup and read one back only by presenting its unguessable `code`.
  signups: Entity((t) => ({
    id: t.id(),
    email: t.text(),
    code: unique(t.text()), // unique constraint (a unique index) — like a unique slug
    status: defaultTo(t.text(), "pending"), // DEFAULT — optional on insert, DB fills it
  })),
});

// Handlers bound to this schema — ctx.db is fully typed against it.
const { query, mutation } = createApp(schema);

const handlers = {
  listNotes: query((ctx) =>
    ctx.db.find({ from: "notes", orderBy: { column: "id", dir: "desc" } }),
  ),

  getNote: query(async (ctx, input: { id: number }) => {
    const rows = await ctx.db.find({ from: "notes", where: { id: input.id }, limit: 1 });
    return rows[0] ?? null;
  }),

  // ownerId is accepted here but the create policy's `set` forces it to the
  // caller — so a forged ownerId in the request body is ignored. The `input`
  // validator rejects malformed bodies at the boundary (400).
  createNote: mutation(
    (ctx, input: { title: string; body: string; ownerId?: string; meta?: JsonValue }) =>
      ctx.db.insert("notes", {
        title: input.title,
        body: input.body,
        ownerId: input.ownerId ?? null,
        createdAt: Date.now(),
        // Only write meta when provided, so roles with a restricted create-field
        // list (e.g. teammate) aren't tripped by an always-present column.
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      }),
    {
      input: (raw): { title: string; body: string; ownerId?: string; meta?: JsonValue } => {
        const o = (raw ?? {}) as Record<string, unknown>;
        if (typeof o.title !== "string") throw new Error("title must be a string");
        if (typeof o.body !== "string") throw new Error("body must be a string");
        return {
          title: o.title,
          body: o.body,
          ownerId: typeof o.ownerId === "string" ? o.ownerId : undefined,
          meta: "meta" in o ? (o.meta as JsonValue) : undefined,
        };
      },
    },
  ),

  updateNote: mutation(async (ctx, input: { id: number; title?: string; body?: string }) => {
    const { id, ...patch } = input;
    return (await ctx.db.update("notes", id, patch)) ?? null;
  }),

  deleteNote: mutation((ctx, input: { id: number }) => ctx.db.delete("notes", input.id)),

  // Relations: notes with their owner; a user with their notes.
  listNotesWithOwner: query((ctx) =>
    ctx.db.find({ from: "notes", with: { owner: true }, orderBy: { column: "id", dir: "desc" } }),
  ),

  getUserWithNotes: query(async (ctx, input: { id: string }) => {
    const rows = await ctx.db.find({ from: "users", where: { id: input.id }, with: { notes: true }, limit: 1 });
    return rows[0] ?? null;
  }),

  listUsers: query((ctx) => ctx.db.find({ from: "users" })),

  // Cursor pagination: pass the previous page's `cursor` back as `after`.
  pageNotes: query((ctx, input: { after?: string; limit?: number; dir?: "asc" | "desc" }) =>
    ctx.db.page({ from: "notes", orderBy: { column: "id", dir: input.dir ?? "asc" }, limit: input.limit ?? 2, after: input.after }),
  ),

  // count + aggregates (ACL read scope applies; field access is enforced).
  countNotes: query((ctx, input: { ownerId?: string }) =>
    ctx.db.count({ from: "notes", where: input.ownerId ? { ownerId: input.ownerId } : undefined }),
  ),

  statsByOwner: query((ctx) =>
    ctx.db.aggregate({
      from: "notes",
      groupBy: "ownerId",
      aggregations: { count: { fn: "count" }, firstId: { fn: "min", column: "id" }, lastId: { fn: "max", column: "id" } },
    }),
  ),

  // References the `body` column — denied for roles that can't read it.
  maxBody: query((ctx) => ctx.db.aggregate({ from: "notes", aggregations: { m: { fn: "max", column: "body" } } })),

  // Anonymous (no token) public write — the anonymous role grants `signups` create.
  createSignup: mutation(
    (ctx, input: { email: string; code: string }) => ctx.db.insert("signups", { email: input.email, code: input.code }),
    {
      input: (raw): { email: string; code: string } => {
        const o = (raw ?? {}) as Record<string, unknown>;
        if (typeof o.email !== "string" || typeof o.code !== "string") throw new Error("email and code are required");
        return { email: o.email, code: o.code };
      },
    },
  ),

  // Capability read: the anonymous read policy is scoped to `code = $input("code")`,
  // so a row is readable only by presenting its unguessable code (no enumeration).
  getSignupByCode: query(async (ctx, input: { code: string }) => {
    void input; // the ACL `where` consumes input.code via $input; no manual filter needed
    const rows = await ctx.db.find({ from: "signups", limit: 1 });
    return rows[0] ?? null;
  }),

  // ctx.env — Worker/DO env (bindings + vars + secrets). Real handlers use it to
  // call external APIs (Stripe, Resend, …). Here we only report presence, never the
  // value, to prove env reaches handlers without leaking a secret.
  envCheck: query((ctx) => ({
    hasAuthSecret: typeof ctx.env.AUTH_SECRET === "string" && ctx.env.AUTH_SECRET.length > 0,
    hasKvBinding: ctx.env.KV != null,
  })),

  // ctx.kv — GLOBAL (cross-tenant) config/cache, not per-tenant data (use db for that).
  getConfig: query((ctx, input: { key: string }) => ctx.kv.get(`config:${input.key}`)),
  setConfig: mutation((ctx, input: { key: string; value: string }) =>
    ctx.kv.put(`config:${input.key}`, input.value).then(() => ({ key: input.key, value: input.value })),
  ),

  // Passthrough that exercises the full query surface (operators, OR/AND,
  // multi-column orderBy, limit/offset). ACL row-scope still applies on top.
  queryNotes: query(
    (
      ctx,
      input: {
        where?: Parameters<typeof ctx.db.find>[0]["where"];
        orderBy?: Parameters<typeof ctx.db.find>[0]["orderBy"];
        limit?: number;
        offset?: number;
      },
    ) => ctx.db.find({ from: "notes", where: input.where, orderBy: input.orderBy, limit: input.limit, offset: input.offset }),
  ),

  createUser: mutation((ctx, input: { id: string; name: string; email: string }) =>
    ctx.db.insert("users", input),
  ),

  // --- file storage (R2 via ctx.files) ---
  // The three-step flow: request a signed upload url, PUT the bytes to it, then
  // attach the resulting FileRef to a row. Download is a signed url minted only
  // after an ACL'd read. Bytes never pass through the DO.

  // 1) Mint a signed upload url (authenticated callers only). The client PUTs the
  //    file bytes directly to `url`; `ref` is the draft metadata to attach later.
  requestUpload: mutation(
    (ctx, input: { contentType: string; filename?: string }) => {
      if (!ctx.identity?.userId) throw new Forbidden("authentication required to upload");
      return ctx.files.signUpload({ contentType: input.contentType, filename: input.filename, maxSize: 5_000_000 });
    },
    {
      input: (raw): { contentType: string; filename?: string } => {
        const o = (raw ?? {}) as Record<string, unknown>;
        if (typeof o.contentType !== "string") throw new Error("contentType must be a string");
        return { contentType: o.contentType, filename: typeof o.filename === "string" ? o.filename : undefined };
      },
    },
  ),

  // A tight maxSize (8 bytes) — shows the cap and lets the suite prove the Worker
  // rejects an over-size body while streaming, not just when a length is declared.
  requestTinyUpload: mutation((ctx, input: { contentType: string }) => {
    if (!ctx.identity?.userId) throw new Forbidden("authentication required to upload");
    return ctx.files.signUpload({ contentType: input.contentType, maxSize: 8 });
  }),

  // 2) Attach an uploaded file to a note. Confirms the blob is really in R2 (and
  //    captures its true size) before persisting; the note update is ACL-gated.
  //    Note: head() is an R2 round-trip inside the mutation's transaction — the
  //    coupling is intentional (no blob → no row), at the cost of holding this
  //    tenant's single writer for the call. A hot path could instead trust the
  //    size the upload endpoint already returned.
  attachToNote: mutation(
    async (ctx, input: { id: number; ref: FileRef }) => {
      const head = await ctx.files.head(input.ref.key);
      if (!head) throw new BadRequest("uploaded file not found in storage");
      const ref: FileRef = {
        ...input.ref,
        size: head.size,
        contentType: head.contentType ?? input.ref.contentType,
        uploadedAt: Date.now(),
      };
      return (await ctx.db.update("notes", input.id, { attachment: ref })) ?? null;
    },
    {
      input: (raw): { id: number; ref: FileRef } => {
        const o = (raw ?? {}) as Record<string, unknown>;
        if (typeof o.id !== "number") throw new Error("id must be a number");
        const ref = o.ref as Record<string, unknown> | undefined;
        if (!ref || typeof ref.key !== "string") throw new Error("ref.key must be a string");
        return {
          id: o.id,
          ref: {
            key: ref.key,
            size: typeof ref.size === "number" ? ref.size : 0,
            contentType: typeof ref.contentType === "string" ? ref.contentType : "application/octet-stream",
            filename: typeof ref.filename === "string" ? ref.filename : undefined,
          },
        };
      },
    },
  ),

  // 3) Get a signed download url for a note's attachment — only if ACL lets the
  //    caller read the note. Returns null when there's no note or no attachment.
  getNoteAttachment: query(async (ctx, input: { id: number }) => {
    const rows = await ctx.db.find({ from: "notes", where: { id: input.id }, limit: 1 });
    const note = rows[0];
    if (!note || !note.attachment) return null;
    return ctx.files.signDownload(note.attachment, { download: true });
  }),
};

// ACL — deny-by-default; roles only grant.
//  admin   : full access to notes and users.
//  author  : own notes only; may create; may traverse note.owner (id+name, no
//            email) via directAccess, but has NO flat users read.
//  reader  : reads every note (no body); cannot traverse to owner.
const acl = [
  role("admin", [
    policy("admin:read", "notes", "read", allow()),
    policy("admin:create", "notes", "create", ownedByCaller), // notes admin creates are owned by admin
    policy("admin:update", "notes", "update", allow()),
    policy("admin:delete", "notes", "delete", allow()),
    policy("admin:users:read", "users", "read", allow()),
    policy("admin:users:create", "users", "create", allow()),
    policy("admin:signups:read", "signups", "read", allow()),
    policy("admin:signups:create", "signups", "create", allow()),
  ]),
  // anonymous: applied to callers with NO verified token. A guest may create a
  // signup (public write) and read one back only by presenting its `code`
  // ($input capability) — they cannot enumerate signups or touch notes/users.
  role("anonymous", [
    policy("anon:signups:create", "signups", "create", allow()),
    policy("anon:signups:read", "signups", "read", { where: { code: $input("code") } }),
  ]),
  role("author", [
    policy("author:read", "notes", "read", {
      where: { ownerId: $identity("userId") },
      relations: { owner: { directAccess: true, fields: ["id", "name"] } },
    }),
    policy("author:create", "notes", "create", {
      ...ownedByCaller,
      validate: ({ values }) => {
        if (!values.title) throw new Error("title is required");
      },
    }),
    policy("author:update", "notes", "update", { where: { ownerId: $identity("userId") } }),
    policy("author:delete", "notes", "delete", { where: { ownerId: $identity("userId") } }),
  ]),
  role("reader", [
    policy("reader:read", "notes", "read", { fields: ["id", "title", "ownerId", "createdAt"] }),
  ]),
  // teammate: cell-level ACL via the declarative form. Reads EVERY note but sees
  // `body` only on notes it owns; may edit any title but `body` only on its own.
  // On create, `set` forces ownerId to the caller, so a teammate can always set
  // body on the note it is creating (the conditional `when` sees the forced owner).
  role("teammate", [
    policy("teammate:read", "notes", "read", {
      fields: ["id", "title", "ownerId", "createdAt"],
      conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
    }),
    policy("teammate:create", "notes", "create", {
      ...ownedByCaller,
      fields: ["title", "createdAt"],
      conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
    }),
    policy("teammate:update", "notes", "update", {
      fields: ["title"],
      conditionalFields: [{ fields: ["body"], when: { ownerId: $identity("userId") } }],
    }),
  ]),
  // peeker: same per-row read visibility as teammate, but via the function escape hatch.
  role("peeker", [
    policy("peeker:read", "notes", "read", {
      fields: ["id", "title", "ownerId", "createdAt"],
      fieldsFn: (identity, row) => (row.ownerId === identity?.userId ? ["body"] : []),
    }),
  ]),
  // manager: reads notes owned by anyone on the caller's team — an ACL `where`
  // using an operator (`in`) whose value is an $identity marker resolving to an
  // array. No `team` claim -> the rule matches nothing (safe deny).
  role("manager", [
    policy("manager:read", "notes", "read", { where: { ownerId: { in: $identity("team") } } }),
  ]),
  // member: read access is computed per request from DB state — you may read
  // everything only once you've authored at least one note; otherwise nothing.
  role("member", [
    policy("member:create", "notes", "create", ownedByCaller),
    policy(
      "member:read",
      "notes",
      "read",
      resolve(async ({ identity, db }) => {
        if (!identity?.userId) return deny();
        const owned = await db.find({ from: "notes", where: { ownerId: identity.userId }, limit: 1 });
        return owned.length > 0 ? allow() : deny();
      }),
    ),
  ]),
];

// Public (pre-auth) routes — e.g. a payment/webhook callback that authenticates by
// signature, not JWT. A real handler verifies the signature on the raw body; here we
// just accept and forward a privileged mutation into the DO via ctx.callPrivileged.
const routes = [
  {
    method: "POST",
    path: "/hooks/signup",
    handler: async (request: Request, _env: Readonly<Record<string, unknown>>, ctx: { callPrivileged: (o: { name: string; input?: unknown; roles?: string[] }) => Promise<Response> }) => {
      const body = (await request.json().catch(() => ({}))) as { email?: string; code?: string };
      // (verify a signature header here in a real webhook)
      return ctx.callPrivileged({ name: "createSignup", input: { email: body.email ?? "", code: body.code ?? "" } });
    },
  },
];

export const app = { schema, handlers, acl, routes };
