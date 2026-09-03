// Authoring the SCHEMA behind pages: block types and content types.
//
// The editor could author pages and blocks but not the block types and content types those
// depend on, so a fresh CMS could not be bootstrapped from the editor at all — the empty
// state said as much ("Define block types + a content type first (via the API/admin)") and
// the only way through was to curl `createBlockType` / `createContentType`. The handlers
// were already there and already editor-gated; this is the surface over them (GitHub #9).
//
// It is the INVERSE of `fields.tsx`. That renders a `FieldDefinition[]` as a form to fill
// in; this edits the `FieldDefinition[]` itself. The two share the type list, so a field
// type that exists here is one `FieldForm` can render — `FIELD_TYPES` below is the mirror
// of the server's own list, which is what keeps that true.

import { Button, Heading, Input, Textarea } from "@podoba/react";
import { useEffect, useState } from "react";
import type { Api, BlockTypeInput, ContentTypeInput } from "./api";
import { CONTROL, slugify } from "./fields";
import type { BlockType, ContentType, DefaultBlockDefinition, FieldDefinition, FieldType, RegionDefinition } from "./types";

/** Every field type the CMS knows — the editor's mirror of `FIELD_TYPES` in @pramen/cms.
 *
 * A mirror rather than an import: the editor is a standalone browser app with no
 * server-package dependency. The server validates an authored schema against its own copy
 * (`normalizeFieldSchema`), so a drift here is a 400 naming the type, not a silently stored
 * field nothing renders. */
export const FIELD_TYPES: readonly FieldType[] = [
  "text", "textarea", "richtext", "url", "number", "boolean", "date", "datetime",
  "publish", "slug", "media", "select", "reference", "repeater", "group",
];

/** Mirror of `MAX_FIELD_DEPTH` in @pramen/cms. Enforced here too so the "+ Add field"
 * button disappears at the limit rather than offering an edit the save will reject. */
const MAX_FIELD_DEPTH = 5;

/** Types that nest a further schema. */
const NESTING: readonly FieldType[] = ["group", "repeater"];

/** The text-ish types a `slug` may follow — same list the server checks. */
const SLUG_SOURCES: readonly FieldType[] = ["text", "textarea", "select", "url"];

const WRAP = "mx-auto max-w-[1200px] px-7 pb-8 pt-2";

/** A field name: an object key in a `fields` bag and a property name in generated TS. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Turn a label into a usable field name. Not `slugify` — that emits hyphens, which are
 * legal in a URL segment and illegal in an object key you can write as `fields.heading`. */
function fieldNameFrom(label: string): string {
  const parts = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (parts.length === 0) return "";
  const [first, ...rest] = parts;
  const camel = first.toLowerCase() + rest.map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join("");
  return FIELD_NAME.test(camel) ? camel : `f${camel}`;
}

// --- the field-schema editor ----------------------------------------------------------

/**
 * Edit one `FieldDefinition[]`.
 *
 * Recursive, mirroring `FieldForm`: a `group`/`repeater` field renders another one of these
 * for its own `fields`. `depth` exists only to stop offering "+ Add field" past the nesting
 * cap the server enforces — a control that always produced a 400 would be worse than none.
 */
export function FieldSchemaEditor({ schema, onChange, depth = 0 }: { schema: FieldDefinition[]; onChange: (s: FieldDefinition[]) => void; depth?: number }) {
  const set = (i: number, f: FieldDefinition) => onChange(schema.map((x, j) => (j === i ? f : x)));
  const del = (i: number) => onChange(schema.filter((_, j) => j !== i));
  const move = (i: number, d: number) => {
    const to = i + d;
    if (to < 0 || to >= schema.length) return;
    const next = schema.slice();
    const [moved] = next.splice(i, 1);
    next.splice(to, 0, moved!);
    onChange(next);
  };
  const add = () => {
    // A unique placeholder name, so adding two fields in a row does not immediately trip the
    // duplicate-name check with nothing typed yet.
    let n = schema.length + 1;
    while (schema.some((f) => f.name === `field${n}`)) n++;
    onChange([...schema, { name: `field${n}`, type: "text" }]);
  };

  const names = schema.map((f) => f.name);
  return (
    <div className="flex flex-col gap-2">
      {schema.length === 0 ? <p className="text-sm text-fg-subtle">No fields yet.</p> : null}
      {schema.map((f, i) => (
        <FieldRow
          key={i}
          def={f}
          siblings={names}
          index={i}
          count={schema.length}
          depth={depth}
          onChange={(next) => set(i, next)}
          onMove={(d) => move(i, d)}
          onDelete={() => del(i)}
        />
      ))}
      {depth + 1 < MAX_FIELD_DEPTH ? (
        <Button variant="secondary" size="sm" className="self-start" onPress={add}>+ Add field</Button>
      ) : (
        <p className="text-caption text-fg-subtle">Fields cannot nest deeper than {MAX_FIELD_DEPTH} levels.</p>
      )}
    </div>
  );
}

function FieldRow({ def, siblings, index, count, depth, onChange, onMove, onDelete }: {
  def: FieldDefinition;
  siblings: string[];
  index: number;
  count: number;
  depth: number;
  onChange: (f: FieldDefinition) => void;
  onMove: (d: number) => void;
  onDelete: () => void;
}) {
  const patch = (p: Partial<FieldDefinition>) => onChange({ ...def, ...p });
  const duplicate = siblings.filter((n) => n === def.name).length > 1;
  const badName = def.name !== "" && !FIELD_NAME.test(def.name);

  /**
   * Switching a field's TYPE drops the keys the old type owned.
   *
   * Carrying them would store a `select`'s `options` on a field that is now `text`, which
   * the server strips anyway — but worse, switching back would silently resurrect the old
   * options after the author thought they were gone. `name`/`label`/`required` are the
   * type-independent half and survive.
   */
  const retype = (type: FieldType) => {
    const next: FieldDefinition = { name: def.name, type };
    if (def.label) next.label = def.label;
    if (def.required) next.required = true;
    if (NESTING.includes(type)) next.fields = NESTING.includes(def.type) ? def.fields ?? [] : [];
    onChange(next);
  };

  return (
    <div className="rounded-lg border border-border bg-surface-muted">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-caption text-fg-subtle">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {def.label || def.name} <span className="text-fg-subtle">· {def.type}</span>
        </span>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title="Move up" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-danger" title="Remove" onClick={onDelete}>✕</button>
      </div>
      <div className="flex flex-col gap-3 p-3.5">
        <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Label</span>
            <input
              className={CONTROL}
              value={def.label ?? ""}
              placeholder={def.name}
              onChange={(e) => {
                const label = e.target.value;
                // The name follows the label only while it is still the untouched
                // placeholder. A name that has been set is a stored key: renaming it orphans
                // every value already written under the old one, which is exactly the
                // "silently rewriting a slug" trap the slug control avoids.
                const derived = /^field\d+$/.test(def.name) ? fieldNameFrom(label) : "";
                patch(derived ? { label, name: derived } : { label });
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Name (the stored key)</span>
            <input className={CONTROL} value={def.name} onChange={(e) => patch({ name: e.target.value.trim() })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">Type</span>
            <select className={CONTROL} value={def.type} onChange={(e) => retype(e.target.value as FieldType)}>
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>

        {duplicate ? <p className="text-caption text-danger">Two fields here are called “{def.name}” — they would write the same key, and one could never be saved.</p> : null}
        {badName ? <p className="text-caption text-danger">A name must start with a letter or underscore and hold only letters, digits and underscores.</p> : null}

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={def.required === true} onChange={(e) => patch({ required: e.target.checked || undefined })} />
          <span className="text-sm text-fg">Required</span>
        </label>

        {def.type === "select" ? <SelectExtras def={def} patch={patch} /> : null}
        {def.type === "reference" ? <ReferenceExtras def={def} patch={patch} /> : null}
        {def.type === "slug" ? <SlugExtras def={def} siblings={siblings} patch={patch} /> : null}
        {def.type === "repeater" ? <RepeaterExtras def={def} patch={patch} /> : null}

        {NESTING.includes(def.type) ? (
          <div className="rounded-lg border border-border bg-surface-card p-3.5">
            <p className="mb-2 text-caption text-fg-subtle">Nested fields</p>
            <FieldSchemaEditor schema={def.fields ?? []} onChange={(fields) => patch({ fields })} depth={depth + 1} />
            {(def.fields ?? []).length === 0 ? (
              <p className="mt-2 text-caption text-danger">A {def.type} needs at least one nested field.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SelectExtras({ def, patch }: { def: FieldDefinition; patch: (p: Partial<FieldDefinition>) => void }) {
  const usingHandler = Boolean(def.optionsFrom);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={usingHandler}
          onChange={(e) => patch(e.target.checked ? { optionsFrom: "", options: undefined } : { optionsFrom: undefined, options: [] })}
        />
        <span className="text-sm text-fg">Fetch the options from a query handler</span>
      </label>
      {usingHandler ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-subtle">Handler name (returns <code>{"{ value, label }[]"}</code>)</span>
          <input className={CONTROL} value={def.optionsFrom ?? ""} onChange={(e) => patch({ optionsFrom: e.target.value.trim() })} />
        </label>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-subtle">Options, one per line</span>
          <textarea
            className={`${CONTROL} h-auto min-h-20 py-2.5`}
            value={(def.options ?? []).join("\n")}
            onChange={(e) => patch({ options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
          />
        </label>
      )}
    </div>
  );
}

function ReferenceExtras({ def, patch }: { def: FieldDefinition; patch: (p: Partial<FieldDefinition>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-subtle">
          Handler name — answers <code>{"{ search, limit, offset }"}</code> and <code>{"{ ids }"}</code>
        </span>
        <input className={CONTROL} value={def.referenceFrom ?? ""} onChange={(e) => patch({ referenceFrom: e.target.value.trim() })} />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={def.multiple === true} onChange={(e) => patch({ multiple: e.target.checked || undefined })} />
        <span className="text-sm text-fg">Allow several</span>
      </label>
      {def.referenceFrom ? null : <p className="text-caption text-danger">A reference needs a handler to resolve it.</p>}
    </div>
  );
}

function SlugExtras({ def, siblings, patch }: { def: FieldDefinition; siblings: string[]; patch: (p: Partial<FieldDefinition>) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-subtle">Derived from (a text field beside it — optional)</span>
      <select className={CONTROL} value={def.from ?? ""} onChange={(e) => patch({ from: e.target.value || undefined })}>
        <option value="">— typed by hand —</option>
        {siblings.filter((n) => n !== def.name).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <span className="text-caption text-fg-subtle">The source must be a {SLUG_SOURCES.join(" / ")} field.</span>
    </label>
  );
}

function RepeaterExtras({ def, patch }: { def: FieldDefinition; patch: (p: Partial<FieldDefinition>) => void }) {
  const num = (v: string) => (v === "" ? undefined : Math.max(0, Math.trunc(Number(v))));
  return (
    <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-subtle">Minimum items</span>
        <input className={CONTROL} type="number" min={0} value={def.min ?? ""} onChange={(e) => patch({ min: num(e.target.value) })} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-subtle">Maximum items</span>
        <input className={CONTROL} type="number" min={1} value={def.max ?? ""} onChange={(e) => patch({ max: num(e.target.value) })} />
      </label>
    </div>
  );
}

// --- the types overview ---------------------------------------------------------------

export function TypesOverview({ api, onOpenBlockType, onOpenContentType, onError }: {
  api: Api;
  onOpenBlockType: (slug: string) => void;
  onOpenContentType: (slug: string) => void;
  onError: (s: string) => void;
}) {
  const [blockTypes, setBlockTypes] = useState<BlockType[] | null>(null);
  const [contentTypes, setContentTypes] = useState<ContentType[] | null>(null);

  useEffect(() => {
    let live = true;
    api.listBlockTypes().then((r) => live && setBlockTypes(r)).catch((e: Error) => onError(String(e.message ?? e)));
    api.listContentTypes().then((r) => live && setContentTypes(r)).catch((e: Error) => onError(String(e.message ?? e)));
    return () => { live = false; };
  }, [api, onError]);

  return (
    <div className={WRAP}>
      <div className="mb-6 mt-6">
        <h1 className="m-0 text-[40px] font-normal leading-[1.1] tracking-[-0.01em]">
          <span className="block text-fg-subtle">The shape of</span>
          <span className="block text-fg">this site</span>
        </h1>
        <p className="mt-3 max-w-[62ch] text-sm text-fg-muted">
          A <strong className="font-medium text-fg">block type</strong> is a set of fields an editor fills in.
          A <strong className="font-medium text-fg">content type</strong> is a kind of page: the regions it has, and which block types may go in each.
          Nothing can be authored until there is one of each.
        </p>
      </div>

      <TypeSection
        title="Block types"
        empty="No block types yet. A page is built from these, so start here."
        rows={blockTypes}
        newLabel="+ New block type"
        onNew={() => onOpenBlockType("new")}
        render={(bt) => (
          <div className={"flex cursor-pointer items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5 hover:bg-surface-muted"} key={bt.id} onClick={() => onOpenBlockType(bt.slug)}>
            <span className="w-6 shrink-0 text-center">{bt.icon ?? ""}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{bt.name}</span>
            <span className="shrink-0 truncate text-fg-subtle">{bt.slug}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{(bt.fieldsSchema ?? []).length} field(s)</span>
          </div>
        )}
      />

      <TypeSection
        title="Content types"
        empty="No content types yet. A page needs one — it is what declares the regions blocks go into."
        rows={contentTypes}
        newLabel="+ New content type"
        onNew={() => onOpenContentType("new")}
        render={(ct) => (
          <div className={"flex cursor-pointer items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5 hover:bg-surface-muted"} key={ct.id} onClick={() => onOpenContentType(ct.slug)}>
            <span className="min-w-0 flex-1 truncate font-medium">{ct.name}</span>
            <span className="shrink-0 truncate text-fg-subtle">{ct.slug}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{(ct.regions ?? []).length} region(s)</span>
          </div>
        )}
      />
    </div>
  );
}

function TypeSection<T>({ title, empty, rows, newLabel, onNew, render }: {
  title: string;
  empty: string;
  rows: T[] | null;
  newLabel: string;
  onNew: () => void;
  render: (row: T) => React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center gap-3">
        <Heading level="2" className="font-normal">{title}</Heading>
        <Button variant="secondary" size="sm" onPress={onNew}>{newLabel}</Button>
      </div>
      {rows === null ? (
        <p className="text-fg-subtle">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-fg-subtle">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2">{rows.map(render)}</div>
      )}
    </section>
  );
}

// --- block-type editor ----------------------------------------------------------------

/** Empty-string-to-null, for the optional text columns. */
const orNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());

export function BlockTypeEditor({ api, slug, onSaved, onBack, onError }: {
  api: Api;
  /** `"new"` creates; anything else loads that block type by slug. */
  slug: string;
  onSaved: (slug: string) => void;
  onBack: () => void;
  onError: (s: string) => void;
}) {
  const isNew = slug === "new";
  const [draft, setDraft] = useState<BlockTypeInput>({ name: "", slug: "", fieldsSchema: [] });
  const [id, setId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  // Whether the slug still follows the name. Only ever true for a NEW type: an existing
  // slug is a registry key a front end maps to a component, and the server refuses to
  // change it anyway.
  const [slugFollows, setSlugFollows] = useState(isNew);

  useEffect(() => {
    if (isNew) return;
    let live = true;
    setLoading(true);
    api
      .listBlockTypes()
      .then((all) => {
        if (!live) return;
        const bt = all.find((b) => b.slug === slug);
        if (!bt) { setMissing(true); return; }
        setId(bt.id);
        setDraft({
          name: bt.name,
          slug: bt.slug,
          description: bt.description ?? null,
          icon: bt.icon ?? null,
          category: bt.category ?? null,
          fieldsSchema: bt.fieldsSchema ?? [],
        });
      })
      .catch((e: Error) => onError(String(e.message ?? e)))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, slug, isNew, onError]);

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const created = await api.createBlockType(draft);
        onSaved(created.slug);
      } else {
        // `slug` is deliberately not sent: it is the stable key, and the server ignores it
        // on an update. Sending it would suggest to a reader that renaming works.
        await api.updateBlockType(id!, { name: draft.name, description: draft.description, icon: draft.icon, category: draft.category, fieldsSchema: draft.fieldsSchema });
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Unknown block type: {slug}</p></div>;
  if (loading) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Loading…</p></div>;

  return (
    <div className={WRAP}>
      <div className="mb-4 mt-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={onBack}>← Types</Button>
        <h1 className="text-[22px] font-normal text-fg">{isNew ? "New block type" : draft.name}</h1>
      </div>
      <div className="flex max-w-[860px] flex-col gap-4">
        {ok ? <div className="rounded-lg border border-brand-green bg-brand-green/20 px-3.5 py-2.5 text-small text-fg">saved</div> : null}
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <Input
            label="Name"
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name, ...(slugFollows ? { slug: slugify(name) } : {}) }))}
          />
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">Slug {isNew ? null : <span className="text-fg-subtle">(fixed)</span>}</span>
            <input
              className={CONTROL}
              value={draft.slug}
              disabled={!isNew}
              onChange={(e) => { setSlugFollows(false); setDraft((d) => ({ ...d, slug: e.target.value.trim() })); }}
            />
            <span className="text-caption text-fg-subtle">
              {isNew
                ? "The key a front end maps to a component. Lowercase letters, digits, hyphens or underscores."
                : "A block type's slug is its registry key — renaming it would orphan every block of this type."}
            </span>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">Icon</span>
            <input className={CONTROL} value={draft.icon ?? ""} placeholder="e.g. 🖼" onChange={(e) => setDraft((d) => ({ ...d, icon: orNull(e.target.value) }))} />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">Category</span>
            <input className={CONTROL} value={draft.category ?? ""} placeholder="e.g. Layout" onChange={(e) => setDraft((d) => ({ ...d, category: orNull(e.target.value) }))} />
          </label>
        </div>
        <Textarea label="Description" value={draft.description ?? ""} onChange={(v) => setDraft((d) => ({ ...d, description: orNull(v) }))} />

        <div>
          <Heading level="2" className="mb-2 font-normal">Fields</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            These are what an editor fills in for every block of this type. Removing one leaves the values already
            written under its name in the store, but nothing will render or edit them.
          </p>
          <FieldSchemaEditor schema={draft.fieldsSchema ?? []} onChange={(fieldsSchema) => setDraft((d) => ({ ...d, fieldsSchema }))} />
        </div>

        <div className="mt-2">
          <Button onPress={save} isDisabled={busy || draft.name.trim() === "" || draft.slug.trim() === ""}>
            {busy ? "Saving…" : isNew ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- content-type editor --------------------------------------------------------------

export function ContentTypeEditor({ api, slug, onSaved, onBack, onError }: {
  api: Api;
  slug: string;
  onSaved: (slug: string) => void;
  onBack: () => void;
  onError: (s: string) => void;
}) {
  const isNew = slug === "new";
  const [draft, setDraft] = useState<ContentTypeInput>({ name: "", slug: "", regions: [{ name: "content", label: "Content", allowedTypes: null }], fieldsSchema: [], defaultBlocks: [] });
  const [id, setId] = useState<string | null>(null);
  const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [slugFollows, setSlugFollows] = useState(isNew);

  useEffect(() => {
    let live = true;
    api.listBlockTypes().then((r) => live && setBlockTypes(r)).catch(() => setBlockTypes([]));
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    if (isNew) return;
    let live = true;
    setLoading(true);
    api
      .listContentTypes()
      .then((all) => {
        if (!live) return;
        const ct = all.find((c) => c.slug === slug);
        if (!ct) { setMissing(true); return; }
        setId(ct.id);
        setDraft({
          name: ct.name,
          slug: ct.slug,
          regions: ct.regions ?? [],
          fieldsSchema: ct.fieldsSchema ?? [],
          defaultBlocks: ct.defaultBlocks ?? [],
        });
      })
      .catch((e: Error) => onError(String(e.message ?? e)))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, slug, isNew, onError]);

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const created = await api.createContentType(draft);
        onSaved(created.slug);
      } else {
        await api.updateContentType(id!, { name: draft.name, regions: draft.regions, fieldsSchema: draft.fieldsSchema, defaultBlocks: draft.defaultBlocks });
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Unknown content type: {slug}</p></div>;
  if (loading) return <div className={WRAP}><p className="pt-8 text-fg-subtle">Loading…</p></div>;

  const regions = draft.regions ?? [];
  return (
    <div className={WRAP}>
      <div className="mb-4 mt-2 flex items-center gap-3">
        <Button variant="ghost" size="sm" onPress={onBack}>← Types</Button>
        <h1 className="text-[22px] font-normal text-fg">{isNew ? "New content type" : draft.name}</h1>
      </div>
      <div className="flex max-w-[860px] flex-col gap-5">
        {ok ? <div className="rounded-lg border border-brand-green bg-brand-green/20 px-3.5 py-2.5 text-small text-fg">saved</div> : null}
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <Input
            label="Name"
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name, ...(slugFollows ? { slug: slugify(name) } : {}) }))}
          />
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">Slug {isNew ? null : <span className="text-fg-subtle">(fixed)</span>}</span>
            <input
              className={CONTROL}
              value={draft.slug}
              disabled={!isNew}
              onChange={(e) => { setSlugFollows(false); setDraft((d) => ({ ...d, slug: e.target.value.trim() })); }}
            />
            <span className="text-caption text-fg-subtle">
              {isNew ? "A URL segment: lowercase letters, digits and single hyphens." : "This slug addresses the type's own page list — renaming it would break every link to it."}
            </span>
          </label>
        </div>

        <div>
          <Heading level="2" className="mb-2 font-normal">Regions</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            A region is a named slot on the page. The allow-list decides what may be placed there; leave it empty for “any block type”.
          </p>
          <RegionsEditor
            regions={regions}
            blockTypes={blockTypes}
            onChange={(next) => setDraft((d) => ({
              ...d,
              regions: next,
              // A default block into a region that no longer exists is refused by the server,
              // so it is dropped HERE rather than left to fail the save with a message about
              // a region the author has just deleted on purpose.
              defaultBlocks: (d.defaultBlocks ?? []).filter((b) => next.some((r) => r.name === b.region)),
            }))}
          />
        </div>

        <div>
          <Heading level="2" className="mb-2 font-normal">Page fields</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            Structured data on the page itself, beside its blocks — a lead image, a byline, a category.
          </p>
          <FieldSchemaEditor schema={draft.fieldsSchema ?? []} onChange={(fieldsSchema) => setDraft((d) => ({ ...d, fieldsSchema }))} />
        </div>

        <div>
          <Heading level="2" className="mb-2 font-normal">Default blocks</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            Created automatically in a region when a page of this type is created.
          </p>
          <DefaultBlocksEditor
            blocks={draft.defaultBlocks ?? []}
            regions={regions}
            blockTypes={blockTypes}
            onChange={(defaultBlocks) => setDraft((d) => ({ ...d, defaultBlocks }))}
          />
        </div>

        <div>
          <Button onPress={save} isDisabled={busy || draft.name.trim() === "" || draft.slug.trim() === "" || regions.length === 0}>
            {busy ? "Saving…" : isNew ? "Create" : "Save"}
          </Button>
          {regions.length === 0 ? <p className="mt-2 text-caption text-danger">A content type needs at least one region.</p> : null}
        </div>
      </div>
    </div>
  );
}

function RegionsEditor({ regions, blockTypes, onChange }: { regions: RegionDefinition[]; blockTypes: BlockType[]; onChange: (r: RegionDefinition[]) => void }) {
  const set = (i: number, r: RegionDefinition) => onChange(regions.map((x, j) => (j === i ? r : x)));
  const add = () => {
    let n = regions.length + 1;
    while (regions.some((r) => r.name === `region${n}`)) n++;
    onChange([...regions, { name: `region${n}`, allowedTypes: null }]);
  };
  const toggle = (i: number, slug: string) => {
    const r = regions[i]!;
    const current = r.allowedTypes ?? [];
    const next = current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug];
    // An EMPTY allow-list means "none", which is a region nothing can go in. The server
    // normalizes that to "any" rather than storing it; matching here keeps the checkbox
    // state honest instead of showing all-unchecked and saving as all-allowed.
    set(i, { ...r, allowedTypes: next.length > 0 ? next : null });
  };
  return (
    <div className="flex flex-col gap-2">
      {regions.map((r, i) => (
        <div key={i} className="rounded-lg border border-border bg-surface-muted p-3.5">
          <div className="mb-3 grid grid-cols-[1fr_1fr_auto] items-end gap-3 max-[720px]:grid-cols-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">Name (the key blocks are placed under)</span>
              <input className={CONTROL} value={r.name} onChange={(e) => set(i, { ...r, name: e.target.value.trim() })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">Label</span>
              <input className={CONTROL} value={r.label ?? ""} placeholder={r.name} onChange={(e) => set(i, { ...r, label: e.target.value || undefined })} />
            </label>
            <button type="button" className="px-2 py-2 text-fg-subtle hover:text-danger" title="Remove region" onClick={() => onChange(regions.filter((_, j) => j !== i))}>✕</button>
          </div>
          <p className="mb-1.5 text-caption text-fg-subtle">
            Allowed block types {r.allowedTypes === null || r.allowedTypes === undefined ? <span className="text-fg">— any</span> : null}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {blockTypes.length === 0 ? <span className="text-caption text-fg-subtle">No block types defined yet.</span> : null}
            {blockTypes.map((bt) => (
              <label key={bt.slug} className="flex items-center gap-1.5">
                <input type="checkbox" checked={(r.allowedTypes ?? []).includes(bt.slug)} onChange={() => toggle(i, bt.slug)} />
                <span className="text-sm text-fg">{bt.name}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <Button variant="secondary" size="sm" className="self-start" onPress={add}>+ Add region</Button>
    </div>
  );
}

function DefaultBlocksEditor({ blocks, regions, blockTypes, onChange }: {
  blocks: DefaultBlockDefinition[];
  regions: RegionDefinition[];
  blockTypes: BlockType[];
  onChange: (b: DefaultBlockDefinition[]) => void;
}) {
  const set = (i: number, b: DefaultBlockDefinition) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const allowedIn = (region: string): BlockType[] => {
    const allowed = regions.find((r) => r.name === region)?.allowedTypes;
    return allowed ? blockTypes.filter((bt) => allowed.includes(bt.slug)) : blockTypes;
  };
  const add = () => {
    const region = regions[0]?.name ?? "";
    onChange([...blocks, { region, blockTypeSlug: allowedIn(region)[0]?.slug ?? "" }]);
  };
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => {
        const options = allowedIn(b.region);
        return (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-3 rounded-lg border border-border bg-surface-muted p-3.5 max-[720px]:grid-cols-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">Region</span>
              <select
                className={CONTROL}
                value={b.region}
                onChange={(e) => {
                  const region = e.target.value;
                  // Moving to a region whose allow-list excludes the current block type
                  // would be refused on save, so the type is re-picked here — the author's
                  // intent is "this region", not "this pair".
                  const still = allowedIn(region).some((bt) => bt.slug === b.blockTypeSlug);
                  set(i, { ...b, region, blockTypeSlug: still ? b.blockTypeSlug : allowedIn(region)[0]?.slug ?? "" });
                }}
              >
                {regions.map((r) => <option key={r.name} value={r.name}>{r.label ?? r.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">Block type</span>
              <select className={CONTROL} value={b.blockTypeSlug} onChange={(e) => set(i, { ...b, blockTypeSlug: e.target.value })}>
                {options.map((bt) => <option key={bt.slug} value={bt.slug}>{bt.name}</option>)}
              </select>
            </label>
            <button type="button" className="px-2 py-2 text-fg-subtle hover:text-danger" title="Remove" onClick={() => onChange(blocks.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}
      <Button variant="secondary" size="sm" className="self-start" onPress={add} isDisabled={regions.length === 0 || blockTypes.length === 0}>+ Add default block</Button>
    </div>
  );
}
