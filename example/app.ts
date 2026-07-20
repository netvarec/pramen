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
  hidden,
  trigger,
  defaultTo,
  expr,
  primaryKey,
  generated,
  BadRequest,
  Forbidden,
  type Identity,
  type HandlerContext,
  type QueueContext,
  type QueueMessage,
  type FileRef,
  type JsonValue,
  type WhereClause,
} from "@pramen/server";
import {
  authSchema,
  authHandlers,
  magicLinkSchema,
  createMagicLinkAuth,
  userHandlers,
  createUserHandlers,
  authPolicies,
} from "@pramen/auth";
// @pramen/cms — the block/page builder, wired as an ordinary app fragment.
import { cmsSchema, cmsHandlers, cmsPolicies, cmsTasks, cmsRoutes, defineBlockType, defineContentType, cmsBootstrap, collection, createCollectionHandlers, collectionPolicies } from "@pramen/cms";

// Reusable write rule: force ownerId to the authenticated caller (a client cannot
// forge it), even if the request body tries to set a different owner.
const ownedByCaller = { set: { ownerId: (i: Identity | null) => i?.userId ?? null } };

const schema = defineSchema({
  // @pramen/auth's user table (signup/login) — migrated alongside the app's own.
  ...authSchema,
  // @pramen/auth's passwordless magic-link table (requestMagicLink/loginWithMagicLink).
  ...magicLinkSchema,
  // @pramen/cms's block/page-builder tables (cms_pages, cms_blocks, cms_block_types, …).
  ...cmsSchema,
  // A COLLECTION-backed entity: `lectures` is an ordinary pramen entity (real, queryable
  // columns), registered as a CMS collection below so it gets a generic list/edit UI in the
  // editor — the "edit arbitrary content, not just pages" escape hatch. No mandatory slug.
  lectures: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    title: t.text(),
    speaker: defaultTo(t.text(), ""),
    date: defaultTo(t.text(), ""),
    abstract: defaultTo(t.text(), ""),
    createdAt: defaultTo(t.text(), expr.now()),
  })),
  // A custom, authSchema-shaped users table with an EXTRA `tenants` column — the
  // multi-tenant accounts pattern. createUserHandlers({ table: "org_accounts" }) +
  // authPolicies({ table: "org_accounts", ... }) manage it without a rename.
  org_accounts: Entity((t) => ({
    username: t.textId(),
    passwordHash: hidden(t.text()),
    roles: t.json(),
    email: unique(t.text()),
    active: defaultTo(t.bool(), true),
    tenants: t.json(), // string[] — the extra column the built-in handlers ignore
    createdAt: t.int(),
  })),
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
    {
      // Declarative trigger: when a note is created or its `title` changes, the Db
      // write path auto-enqueues a `note-changed` task (atomic with the write) — no
      // ctx.tasks.enqueue in the handler. Runs the side effect off the write path.
      triggers: [trigger({ task: "note-changed", on: { create: true, update: ["title"] } })],
    },
  ),
  // Public-write entity for the anonymous-role + capability-read demo: a guest can
  // create a signup and read one back only by presenting its unguessable `code`.
  signups: Entity((t) => ({
    id: t.id(),
    email: t.text(),
    code: unique(t.text()), // unique constraint (a unique index) — like a unique slug
    status: defaultTo(t.text(), "pending"), // DEFAULT — optional on insert, DB fills it
  })),
  // UUID columns. `id` is a generated UUID primary key (the kvalt pattern); `traceId`
  // is a generated non-PK UUID. Both are minted server-side on insert when omitted
  // (crypto.randomUUID()); a value supplied by the caller is validated (isValidUuid).
  events: Entity((t) => ({
    id: primaryKey(generated(t.uuid())),
    kind: t.text(),
    traceId: generated(t.uuid()),
    // SQL-expression default: filled by the DB with the current UTC timestamp
    // (TEXT, like CURRENT_TIMESTAMP) when the caller omits it. No app-side clock.
    createdAt: defaultTo(t.text(), expr.now()),
  })),
  // Partitioned entity: an append-only audit log living in its OWN Durable Object
  // (partition "audit"), separate from the default-partition `notes`/`users`. The
  // two partitions are independent DOs (different idFromName) sharing one PramenDO
  // class — so they migrate, store, and broadcast in isolation. NOTE: this entity
  // has NO relations on purpose; a relation crossing into a default-partition table
  // would fail validateSchema at boot (proven in test/schema-validate.test.ts).
  auditLog: Entity(
    (t) => ({
      id: t.id(),
      action: t.text(),
      at: t.int(),
    }),
    undefined,
    { partition: "audit" },
  ),
});

// Handlers bound to this schema — ctx.db is fully typed against it.
const { query, mutation } = createApp(schema);

// @pramen/auth: passwordless magic-link login. Delivery goes through `ctx.mail` — on
// Cloudflare that's Cloudflare Email Sending (the `EMAIL`/send_email binding, when a
// MAIL_FROM sender is configured); local/dev captures it instead. We also stash the raw
// token in KV so the e2e suite can complete the login without parsing the email.
const magicLink = createMagicLinkAuth({
  sendEmail: async (ctx, { email, token }) => {
    const appUrl = (ctx.env.APP_URL as string) ?? "http://localhost:8787";
    const link = `${appUrl}/auth?token=${encodeURIComponent(token)}`;
    await ctx.mail.send({
      to: email,
      subject: "Your sign-in link",
      text: `Sign in to pramen: ${link}\n\nThis link expires in 15 minutes and can be used once.`,
      html: `<p><a href="${link}">Sign in to pramen</a></p><p>This link expires in 15 minutes and can be used once.</p>`,
    });
    await ctx.kv.put(`magiclink:${email}`, token, { expirationTtl: 900 }); // dev-only: token for the e2e
  },
});

// User management over the CUSTOM org_accounts table (the multi-tenant pattern):
// the same handlers, pointed at a different table, exposed under prefixed RPC names.
const orgAccounts = createUserHandlers({ table: "org_accounts" });

// CMS collections: register the `lectures` entity as an editable collection. The editor
// discovers it via listCollections and renders a generic list + form (FieldForm over these
// fields) — no page/slug involved. Scalar fields are real columns on the entity.
const collections = [
  collection("lectures", {
    entity: "lectures",
    label: "Lecture",
    icon: "🎓",
    titleField: "title",
    list: ["title", "speaker", "date"],
    orderBy: { column: "date", dir: "desc" },
    fields: [
      { name: "title", type: "text", required: true },
      { name: "speaker", type: "text" },
      { name: "date", type: "date" },
      { name: "abstract", type: "richtext" },
    ],
  }),
];

const handlers = {
  // @pramen/auth: signup / login / me (issue + use HS256 tokens, no third-party IdP).
  ...authHandlers,
  // @pramen/auth: requestMagicLink / loginWithMagicLink (passwordless). The email is
  // sent from the `sendMagicLinkEmail` task (see `tasks` below), off the write path.
  ...magicLink.handlers,
  // @pramen/auth: user management — listUsers / setUserRoles / setUserActive (admin),
  // changeEmail / changePassword (self). Gated by authPolicies() in the ACL below.
  ...userHandlers,
  // @pramen/cms: block/page builder — createBlockType / createContentType / createPage /
  // addBlock / publishPage / schedulePage (editor-gated) + getPage (public content API).
  ...cmsHandlers,
  // @pramen/cms collections: listCollections + collectionList/get/create/update/delete over
  // the registered `lectures` entity (editor-gated). The generic "edit any entity" surface.
  ...createCollectionHandlers(collections),
  // The same handlers over the custom org_accounts table, under prefixed names, plus
  // an app-owned setOrgAccountTenants writing the extra `tenants` column (the Tah
  // setUserTenants analog) — permitted by authPolicies adminWriteFields below.
  listOrgAccounts: orgAccounts.listUsers,
  setOrgAccountRoles: orgAccounts.setUserRoles,
  setOrgAccountTenants: mutation((ctx, input: { username: string; tenants: string[] }) =>
    ctx.db.update("org_accounts", input.username, { tenants: input.tenants }),
  ),
  // Dev-only: lets the e2e suite read the token the demo "emailed". These `__*Inbox`
  // handlers read captured tokens straight from KV (which bypasses the row-ACL), so they
  // gate the CALL with `auth: ["admin"]` — without it any anonymous caller could read
  // another address's magic-link token. Not for production.
  __magicInbox: query(async (ctx, input: { email: string }) => ({ token: await ctx.kv.get(`magiclink:${input.email}`) }), {
    auth: ["admin"],
  }),

  // Deferred side-effect demo: write a note AND enqueue a notification, atomically.
  // The email is sent later by the `notify` task handler (app.tasks), off the write
  // path. A failing enqueue would roll the note back; a `throw` here proves atomicity.
  createNoteAndNotify: mutation(async (ctx, input: { title: string; to: string; fail?: boolean }) => {
    const note = await ctx.db.insert("notes", { title: input.title, body: "", ownerId: String(ctx.identity?.userId ?? "anon"), createdAt: 1 });
    await ctx.tasks.enqueue({ kind: "notify", payload: { to: input.to, title: input.title } });
    if (input.fail) throw new BadRequest("forced failure — note + task must both roll back");
    return note;
  }),
  // Dev-only (admin-gated): read the ctx.mail "inbox" (the dev KvMailAdapter stashes
  // under mail:<to>) — returns the email text the `notify` task sent.
  __notifyInbox: query(
    async (ctx, input: { to: string }) => {
      const raw = (await ctx.kv.get(`mail:${input.to}`)) as string | null;
      return { body: raw ? (JSON.parse(raw).text as string) : null };
    },
    { auth: ["admin"] },
  ),
  // Dev-only (admin-gated): read what the `note-changed` TRIGGER task recorded for a note.
  __noteChangedInbox: query(async (ctx, input: { id: number }) => ({ body: await ctx.kv.get(`note-changed:${input.id}`) }), {
    auth: ["admin"],
  }),

  // ctx.queue (Cloudflare Queues) demo: enqueue a job onto the NATIVE queue. Unlike
  // ctx.tasks (the transactional outbox, atomic with a DB write), a queue send is NOT
  // transactional — it's decoupled, high-throughput fan-out with a consumer (app.queues)
  // that could even live in another Worker. Send addresses the queue by its BINDING name
  // ("JOBS", declared in oblaka.ts). Gated, as it touches ctx.queue directly (bypasses ACL).
  enqueueJob: mutation(
    async (ctx, input: { id: string }) => {
      await ctx.queue.send("JOBS", { id: input.id, tenant: "main" });
      return { queued: input.id };
    },
    { auth: ["admin"] },
  ),
  // Dev-only (admin-gated): read what the queue CONSUMER recorded for a job (proves the
  // produce → consume round-trip end-to-end).
  __jobInbox: query(async (ctx, input: { id: string }) => ({ body: await ctx.kv.get(`job:${input.id}`) }), {
    auth: ["admin"],
  }),
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

  // Demo handler over the app's own `users` entity (distinct from @pramen/auth's
  // auth_users). Named listProfiles to avoid colliding with userHandlers.listUsers.
  listProfiles: query((ctx) => ctx.db.find({ from: "users" })),

  // Relation-aware where: filter users by their notes (hasMany traversal).
  queryUsers: query((ctx, input: { where?: WhereClause<typeof schema, "users"> }) =>
    ctx.db.find({ from: "users", where: input.where }),
  ),

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

  // UUID demo. `id` and `traceId` are omitted on insert, so the runtime mints them
  // (the echoed row carries the generated uuids). Passing an `id` is allowed too, as
  // long as it's a valid uuid — otherwise the write is rejected (400).
  logEvent: mutation(
    (ctx, input: { kind: string; id?: string }) =>
      ctx.db.insert("events", { kind: input.kind, ...(input.id !== undefined ? { id: input.id } : {}) }),
    {
      input: (raw): { kind: string; id?: string } => {
        const o = (raw ?? {}) as Record<string, unknown>;
        if (typeof o.kind !== "string") throw new Error("kind must be a string");
        return { kind: o.kind, id: typeof o.id === "string" ? o.id : undefined };
      },
    },
  ),

  listEvents: query((ctx) => ctx.db.find({ from: "events", orderBy: { column: "id", dir: "asc" } })),

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
        where?: WhereClause<typeof schema, "notes">;
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

  // --- partitioned handlers (run in the "audit" partition DO) ---
  // These are declared with { partition: "audit" }, so the Worker routes them to
  // idFromName(partitionDoName(tenant, "audit")) — a different DO than the default
  // notes/users handlers above. ctx.db here only sees the audit partition's tables.

  // Append an audit entry. Writing to `notes` (default partition) from here would
  // hit the partition guard (BadRequest), since this DO only owns `auditLog`.
  logAudit: mutation(
    (ctx, input: { action: string }) => ctx.db.insert("auditLog", { action: input.action, at: Date.now() }),
    {
      input: (raw): { action: string } => {
        const o = (raw ?? {}) as Record<string, unknown>;
        if (typeof o.action !== "string") throw new Error("action must be a string");
        return { action: o.action };
      },
      partition: "audit",
    },
  ),

  listAudit: query((ctx) => ctx.db.find({ from: "auditLog", orderBy: { column: "id", dir: "desc" } }), {
    partition: "audit",
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
    policy("admin:events:read", "events", "read", allow()),
    policy("admin:events:create", "events", "create", allow()),
    // auditLog lives in the "audit" partition; ACL is partition-agnostic (policies
    // name entities). The audit DO loads this same ACL, so admin can write/read it.
    policy("admin:audit:read", "auditLog", "read", allow()),
    policy("admin:audit:create", "auditLog", "create", allow()),
    // @pramen/auth user management: admin reads (projected — no passwordHash) and
    // updates roles/email/active on any user.
    ...authPolicies().admin,
    // Same, for the custom org_accounts table — distinct `prefix` (unique policy
    // names) and `tenants` added to the read/write fields so the admin can see and
    // set it (powering setOrgAccountTenants).
    ...authPolicies({
      table: "org_accounts",
      prefix: "org",
      adminReadFields: ["username", "roles", "email", "active", "tenants", "createdAt"],
      adminWriteFields: ["roles", "email", "active", "tenants"],
    }).admin,
    // @pramen/cms: full CRUD across the cms_ tables (admin holds the default `admin`
    // editor role, so the CMS editor handlers accept it too).
    ...cmsPolicies().editor,
    // @pramen/cms collections: full CRUD over each registered collection's entity, so the
    // generic collection handlers (which go through ctx.db) are permitted for admin.
    ...collectionPolicies(collections),
  ]),
  // anonymous: applied to callers with NO verified token. A guest may create a
  // signup (public write) and read one back only by presenting its `code`
  // ($input capability) — they cannot enumerate signups or touch notes/users.
  role("anonymous", [
    policy("anon:signups:create", "signups", "create", allow()),
    policy("anon:signups:read", "signups", "read", { where: { code: $input("code") } }),
    // @pramen/cms: guests read PUBLISHED pages + their snapshots only (getPage serves the
    // snapshot; unpublished block rows are never exposed).
    ...cmsPolicies().public,
  ]),
  // @pramen/cms editorial roles: an `editor` can author + submit for review; a `reviewer`
  // can approve/reject/publish. Both need the same CMS data ACL (full CRUD on cms_ tables);
  // the workflow gate is the per-handler `auth` (submit → editor, approve/reject → reviewer).
  // Distinct policy-name prefixes so the grants don't collide with admin's.
  role("editor", [...cmsPolicies({ prefix: "cms-ed" }).editor, ...collectionPolicies(collections, { prefix: "cms-ed" })]),
  role("reviewer", [...cmsPolicies({ prefix: "cms-rev" }).editor]),
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
  // user: the default role @pramen/auth assigns on signup — proves an issued token
  // flows through the verifier + ACL (here: read notes, no body).
  role("user", [
    policy("user:read", "notes", "read", { fields: ["id", "title", "ownerId", "createdAt"] }),
    // @pramen/auth user management: a user reads + changes the email of ONLY its own
    // auth_users row (changePassword is a self-scoped credential op, no policy needed).
    ...authPolicies().self,
  ]),
  // owneronly: ACL `where` that TRAVERSES a relation — read notes whose owner is the
  // caller (`note.owner.id == $identity`). Needs a read grant on the target (users),
  // since a relation filter respects the target's read ACL; here scoped to self.
  role("owneronly", [
    policy("owneronly:read", "notes", "read", { where: { owner: { id: $identity("userId") } } }),
    policy("owneronly:users", "users", "read", { where: { id: $identity("userId") } }),
  ]),
  // orfallback: OR with a marker on a claim that may be absent. Each OR branch is
  // resolved independently, so an unresolvable marker collapses only ITS branch —
  // the literal `title` branch still matches (a "public fallback" pattern).
  role("orfallback", [
    policy("orfallback:read", "notes", "read", {
      where: { OR: [{ ownerId: $identity("ghost") }, { title: "a1" }] },
    }),
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
  // @pramen/cms: public GET /sitemap.xml + /robots.txt (origin derived from the request).
  ...cmsRoutes(),
];

// Deferred side-effect handlers, drained from the outbox after a mutation enqueues.
// A real `notify` would send via Cloudflare Email Sending (ctx.env.EMAIL.send(...));
// this demo stashes the "delivered" message in KV so the e2e suite can read the inbox.
const tasks = {
  notify: async (ctx: HandlerContext, payload: unknown) => {
    const { to, title } = payload as { to: string; title: string };
    // The canonical use: a task sends a notification email via ctx.mail (off the write path).
    await ctx.mail.send({ to, subject: "New note", text: `New note: ${title}` });
  },
  // Fired by the `notes` declarative trigger (create + title change). The payload is
  // the framework's `{ entity, op, id, row }`.
  "note-changed": async (ctx: HandlerContext, payload: unknown) => {
    const { op, id, row } = payload as { op: string; id: number; row: { title: string } };
    await ctx.kv.put(`note-changed:${id}`, `${op}:${row.title}`, { expirationTtl: 900 });
  },
  // @pramen/cms: scheduled publish/unpublish (backing schedulePage), run off the write path.
  ...cmsTasks,
  // @pramen/auth: sendMagicLinkEmail — invokes the app's sendEmail after commit, so a slow
  // transport can't hold the requestMagicLink mutation's storage transaction open.
  ...magicLink.tasks,
};

// Cloudflare Queues consumers, keyed by QUEUE name (the oblaka `Queue` name —
// env-prefixed in remote envs, matched leniently by createPramen().queue). A consumer is
// Worker-level: no ctx.db, so it reaches tenant data via ctx.callPrivileged (the message
// body carries the tenant). Here it just records the job in KV so the e2e can read it back;
// a real one might ctx.callPrivileged into a DO and/or ctx.mail.send a notification.
const queues = {
  "pramen-jobs": async (ctx: QueueContext, message: QueueMessage) => {
    const { id } = message.body as { id: string; tenant: string };
    await ctx.kv.put(`job:${id}`, `done:${id}`, { expirationTtl: 900 });
  },
};

// @pramen/cms code-defined types: declare block + content types in code and have every
// tenant's store converge to them on boot (no manual createContentType). Distinct slugs so
// they don't collide with the ones the cms e2e suite creates over RPC. The suite asserts a
// fresh tenant is already seeded with `seeded_doc` before it creates anything — proving the
// server invokes app.bootstrap after migration on boot.
const seededNote = defineBlockType("seeded_note", [{ name: "body", type: "richtext" }] as const, { name: "Seeded Note" });
const seededDoc = defineContentType("seeded_doc", {
  name: "Seeded Doc",
  fields: [{ name: "summary", type: "textarea" }],
  regions: [{ name: "content", allowedTypes: ["seeded_note"] }],
});

export const app = {
  schema,
  handlers,
  acl,
  routes,
  tasks,
  queues,
  bootstrap: [cmsBootstrap({ blockTypes: [seededNote], contentTypes: [seededDoc] })],
};
