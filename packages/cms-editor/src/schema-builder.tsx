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
import { useEffect, useRef, useState } from "react";
import { useUnsavedGuard } from "./app-context";
import type { Api, BlockTypeInput, ContentTypeInput } from "./api";
import { CONTROL, slugify } from "./fields";
import { ROW, ROW_BUTTON, WRAP } from "./chrome";
import { getI18n, useI18n, type TextKey } from "./i18n";
import { rich } from "./i18n/rich";
import { DetailHeader } from "./detail-header";
import { LoadFailed } from "./list-state";
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

/** Each field type's label in the picker. English shows the machine value; the stored value is
 * always the machine value, whatever the label says. */
const FIELD_TYPE_KEYS = {
  text: "fieldSchema.type.text",
  textarea: "fieldSchema.type.textarea",
  richtext: "fieldSchema.type.richtext",
  url: "fieldSchema.type.url",
  number: "fieldSchema.type.number",
  boolean: "fieldSchema.type.boolean",
  date: "fieldSchema.type.date",
  datetime: "fieldSchema.type.datetime",
  publish: "fieldSchema.type.publish",
  slug: "fieldSchema.type.slug",
  media: "fieldSchema.type.media",
  select: "fieldSchema.type.select",
  reference: "fieldSchema.type.reference",
  repeater: "fieldSchema.type.repeater",
  group: "fieldSchema.type.group",
} as const satisfies Record<FieldType, TextKey>;

/** A field type's label, falling back to the machine value for a type this mirror lacks. */
function fieldTypeLabel(type: FieldType): string {
  const key = (FIELD_TYPE_KEYS as Partial<Record<string, TextKey>>)[type];
  return key ? getI18n().t(key) : type;
}


/** A field name: an object key in a `fields` bag and a property name in generated TS. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Turn a label into a usable field name. Not `slugify` — that emits hyphens, which are
 * legal in a URL segment and illegal in an object key you can write as `fields.heading`. */
function fieldNameFrom(label: string): string {
  const parts = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

  const { t } = useI18n();
  const names = schema.map((f) => f.name);
  return (
    <div className="flex flex-col gap-2">
      {schema.length === 0 ? <p className="text-sm text-fg-subtle">{t("fieldSchema.empty")}</p> : null}
      {schema.map((f, i) => (
        <FieldRow
          key={i}
          def={f}
          siblings={names}
          siblingFields={schema}
          index={i}
          count={schema.length}
          depth={depth}
          onChange={(next) => set(i, next)}
          onMove={(d) => move(i, d)}
          onDelete={() => del(i)}
        />
      ))}
      {depth + 1 < MAX_FIELD_DEPTH ? (
        <Button variant="secondary" size="sm" className="self-start" onPress={add}>{t("fieldSchema.add")}</Button>
      ) : (
        <p className="text-caption text-fg-subtle">{t("fieldSchema.maxDepth", { max: MAX_FIELD_DEPTH })}</p>
      )}
    </div>
  );
}

function FieldRow({ def, siblings, siblingFields, index, count, depth, onChange, onMove, onDelete }: {
  def: FieldDefinition;
  siblings: string[];
  siblingFields: FieldDefinition[];
  index: number;
  count: number;
  depth: number;
  onChange: (f: FieldDefinition) => void;
  onMove: (d: number) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
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
          {def.label || def.name} <span className="text-fg-subtle">· {fieldTypeLabel(def.type)}</span>
        </span>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title={t("fieldSchema.moveUp")} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title={t("fieldSchema.moveDown")} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" className="px-1.5 text-fg-subtle hover:text-danger" title={t("common.remove")} onClick={onDelete}>✕</button>
      </div>
      <div className="flex flex-col gap-3 p-3.5">
        <div className="grid grid-cols-3 gap-3 max-[720px]:grid-cols-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("fieldSchema.label")}</span>
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
            <span className="text-caption text-fg-subtle">{t("fieldSchema.name")}</span>
            <input className={CONTROL} value={def.name} onChange={(e) => patch({ name: e.target.value.trim() })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-subtle">{t("fieldSchema.type")}</span>
            <select className={CONTROL} value={def.type} onChange={(e) => retype(e.target.value as FieldType)}>
              {FIELD_TYPES.map((type) => <option key={type} value={type}>{fieldTypeLabel(type)}</option>)}
            </select>
          </label>
        </div>

        {duplicate ? <p className="text-caption text-danger">{t("fieldSchema.duplicate", { name: def.name })}</p> : null}
        {badName ? <p className="text-caption text-danger">{t("fieldSchema.badName")}</p> : null}

        {/* Full width, and under the three-up row: this is the one input here that takes a
            sentence rather than a word, and it is the only place a field's meaning can be
            written down where the person filling it in will read it. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-subtle">{t("fieldSchema.help")}</span>
          <input
            className={CONTROL}
            value={def.description ?? ""}
            placeholder={t("fieldSchema.helpPlaceholder")}
            onChange={(e) => patch({ description: e.target.value || undefined })}
          />
        </label>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={def.required === true} onChange={(e) => patch({ required: e.target.checked || undefined })} />
          <span className="text-sm text-fg">{t("fieldSchema.required")}</span>
        </label>

        {def.type === "select" ? <SelectExtras def={def} patch={patch} /> : null}
        {def.type === "reference" ? <ReferenceExtras def={def} patch={patch} /> : null}
        {def.type === "slug" ? <SlugExtras def={def} siblingFields={siblingFields} patch={patch} /> : null}
        {def.type === "repeater" ? <RepeaterExtras def={def} patch={patch} /> : null}

        {NESTING.includes(def.type) ? (
          <div className="rounded-lg border border-border bg-surface-card p-3.5">
            <p className="mb-2 text-caption text-fg-subtle">{t("fieldSchema.nested")}</p>
            <FieldSchemaEditor schema={def.fields ?? []} onChange={(fields) => patch({ fields })} depth={depth + 1} />
            {(def.fields ?? []).length === 0 ? (
              <p className="mt-2 text-caption text-danger">{t("fieldSchema.nestedNeeded", { type: fieldTypeLabel(def.type) })}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SelectExtras({ def, patch }: { def: FieldDefinition; patch: (p: Partial<FieldDefinition>) => void }) {
  const { t } = useI18n();
  const usingHandler = Boolean(def.optionsFrom);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={usingHandler}
          onChange={(e) => patch(e.target.checked ? { optionsFrom: "", options: undefined } : { optionsFrom: undefined, options: [] })}
        />
        <span className="text-sm text-fg">{t("fieldSchema.optionsFromHandler")}</span>
      </label>
      {usingHandler ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-subtle">{rich(t("fieldSchema.optionsHandler", { shape: "{ value, label }[]" }), { code: (s) => <code>{s}</code> })}</span>
          <input className={CONTROL} value={def.optionsFrom ?? ""} onChange={(e) => patch({ optionsFrom: e.target.value.trim() })} />
        </label>
      ) : (
        <OptionsTextarea options={def.options ?? []} onChange={(options) => patch({ options })} />
      )}
    </div>
  );
}

/**
 * The `select` options list, edited as one-per-line text.
 *
 * The text lives in LOCAL state and the parsed array goes upward. Deriving the textarea's
 * value from the parsed array instead — `options.join("\n")` — made the field unusable:
 * the parse trims and drops empties on every keystroke, so typing a space gave back the
 * same array, the value prop never changed, and React restored the DOM. Space and Enter
 * were erased as typed, which meant no multi-word option and no second option. A `select`
 * could not be authored at all in the builder that introduces it.
 *
 * Re-seeded only when the incoming array is not the one this last emitted — i.e. the form
 * switched to a different field, not our own change coming back around. Same rule the
 * rich-text control uses, for the same reason.
 */
function OptionsTextarea({ options, onChange }: { options: readonly string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(() => options.join("\n"));
  const emitted = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (options === emitted.current) return;
    setText(options.join("\n"));
  }, [options]);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-subtle">{t("fieldSchema.options")}</span>
      <textarea
        className={`${CONTROL} h-auto min-h-20 py-2.5`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = e.target.value.split("\n").map((v) => v.trim()).filter(Boolean);
          emitted.current = parsed;
          onChange(parsed);
        }}
      />
    </label>
  );
}

function ReferenceExtras({ def, patch }: { def: FieldDefinition; patch: (p: Partial<FieldDefinition>) => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-subtle">
          {rich(t("fieldSchema.referenceHandler", { query: "{ search, limit, offset }", ids: "{ ids }" }), { code: (s) => <code>{s}</code> })}
        </span>
        <input className={CONTROL} value={def.referenceFrom ?? ""} onChange={(e) => patch({ referenceFrom: e.target.value.trim() })} />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={def.multiple === true} onChange={(e) => patch({ multiple: e.target.checked || undefined })} />
        <span className="text-sm text-fg">{t("fieldSchema.referenceMultiple")}</span>
      </label>
      {def.referenceFrom ? null : <p className="text-caption text-danger">{t("fieldSchema.referenceNeedsHandler")}</p>}
    </div>
  );
}

function SlugExtras({ def, siblingFields, patch }: { def: FieldDefinition; siblingFields: FieldDefinition[]; patch: (p: Partial<FieldDefinition>) => void }) {
  const { t } = useI18n();
  const sources = siblingFields.filter((f) => f.name !== def.name && SLUG_SOURCES.includes(f.type));
  const types = SLUG_SOURCES.map(fieldTypeLabel).join(" / ");
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption text-fg-subtle">{t("fieldSchema.slugFrom")}</span>
      <select className={CONTROL} value={def.from ?? ""} onChange={(e) => patch({ from: e.target.value || undefined })}>
        <option value="">{t("fieldSchema.slugByHand")}</option>
        {/* Only fields the server will ACCEPT as a source. `SLUG_SOURCES` was declared for
            this check and then used only in the hint below, so the dropdown offered every
            sibling — including a `number` or a `media` — and picking one made the whole type
            unsavable with an error naming a field the author had just been offered. */}
        {sources.map((f) => <option key={f.name} value={f.name}>{f.label ?? f.name}</option>)}
      </select>
      <span className="text-caption text-fg-subtle">
        {sources.length > 0 ? t("fieldSchema.slugSourceHint", { types }) : t("fieldSchema.slugNoSource", { types })}
      </span>
    </label>
  );
}

function RepeaterExtras({ def, patch }: { def: FieldDefinition; patch: (p: Partial<FieldDefinition>) => void }) {
  const { t } = useI18n();
  const num = (v: string) => (v === "" ? undefined : Math.max(0, Math.trunc(Number(v))));
  return (
    <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-subtle">{t("fieldSchema.repeaterMin")}</span>
        <input className={CONTROL} type="number" min={0} value={def.min ?? ""} onChange={(e) => patch({ min: num(e.target.value) })} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-subtle">{t("fieldSchema.repeaterMax")}</span>
        <input className={CONTROL} type="number" min={1} value={def.max ?? ""} onChange={(e) => patch({ max: num(e.target.value) })} />
      </label>
    </div>
  );
}

// --- code-defined types ---------------------------------------------------------------
//
// A type declared with `defineBlockType` / `defineContentType` and reconciled by
// `cmsBootstrap` is flagged `managed`, and the builder shows it read-only. Both surfaces
// listed code-defined and editor-authored types identically before, so the obvious thing to
// do — open one, add a field, hit Save — returned 200 and was reverted at the next cold
// start, orphaning any content authored against the field (GitHub #48). The server now
// refuses that write; this is the half that stops an editor walking into it.

/** The marker on a code-defined row in the overview lists. */
function CodeBadge() {
  const { t } = useI18n();
  return (
    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-caption text-fg-subtle" title={t("schema.codeBadgeTitle")}>
      {t("schema.codeBadge")}
    </span>
  );
}

/** Shown ABOVE a read-only builder, in place of the Save button.
 *
 * Above, not inside: it used to sit within the disabled `<fieldset>`, and `disabled` takes
 * the whole subtree out of the tab order — so a screen-reader user tabbed from "← Types"
 * straight past every control and never reached the one paragraph explaining why the screen
 * was empty. It is also what the fieldset's `aria-describedby` points at. */
function ManagedNotice({ id, what, defineFn, slug, owner }: { id: string; what: string; defineFn: string; slug: string; owner?: string | null }) {
  const { t } = useI18n();
  const message = t("schema.managed.body", {
    what,
    call: `${defineFn}("${slug}", …)`,
    owner: owner && owner !== "cms" ? t("schema.managed.owner", { owner }) : "",
  });
  return (
    <div id={id} className="mb-4 max-w-[860px] rounded-lg border border-border bg-surface-muted px-3.5 py-3 text-small text-fg-muted">
      {rich(message, {
        strong: (s) => <strong className="font-medium text-fg">{s}</strong>,
        code: (s) => <code className="text-fg">{s}</code>,
      })}
    </div>
  );
}

/** The read-only form wrapper. `disabled` on a fieldset disables every native control inside
 * it, so the lock is one attribute rather than a prop threaded through the region / field /
 * default-block editors — none of which would then be able to forget it.
 *
 * It needs the styling too. podoba's controls render their disabled look from
 * `data-[disabled]`, which react-aria sets from its OWN `isDisabled` prop and never from an
 * ancestor fieldset — so the inert form was pixel-identical to a live one, except for the two
 * buttons that happen to carry a `:disabled` class and dimmed while their neighbours did not.
 * An editor clicked into Name, typed, and no characters appeared. The wrapper carries the
 * visual state for everything inside it. */
function ReadOnlyFieldset({ locked, describedBy, label, className, children }: {
  locked: boolean;
  describedBy?: string;
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset
      disabled={locked}
      aria-describedby={locked ? describedBy : undefined}
      className={`m-0 min-w-0 border-0 p-0 ${className} ${locked ? "select-none opacity-60 [&_*]:cursor-not-allowed" : ""}`}
    >
      {/* An unnamed `group` is what a screen reader announces otherwise. */}
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  );
}

// --- the types overview ---------------------------------------------------------------

export function TypesOverview({ api, codeDefinedTypes, onOpenBlockType, onOpenContentType, onError }: {
  api: Api;
  /** `listCmsCapabilities().codeDefinedTypes` — see `CmsCapabilities`. False against an older
   * server, where `managedBy` is absent on every row and means nothing. */
  codeDefinedTypes: boolean;
  onOpenBlockType: (slug: string) => void;
  onOpenContentType: (slug: string) => void;
  onError: (s: string) => void;
}) {
  const [blockTypes, setBlockTypes] = useState<BlockType[] | null>(null);
  const [contentTypes, setContentTypes] = useState<ContentType[] | null>(null);
  // Which of the two fetches failed. Without it a failure left its section on "Loading…"
  // for good, since `null` was the only state a section could be in before its answer.
  const [failed, setFailed] = useState({ block: false, content: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed({ block: false, content: false });
    api.listBlockTypes().then((r) => live && setBlockTypes(r)).catch((e: Error) => {
      if (live) setFailed((f) => ({ ...f, block: true }));
      onError(String(e.message ?? e));
    });
    api.listContentTypes().then((r) => live && setContentTypes(r)).catch((e: Error) => {
      if (live) setFailed((f) => ({ ...f, content: true }));
      onError(String(e.message ?? e));
    });
    return () => { live = false; };
  }, [api, onError, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  const i18n = useI18n();
  const { t } = i18n;

  return (
    <div className={WRAP}>
      <div className="mb-6 mt-6">
        <h1 className="m-0 text-[40px] font-normal leading-[1.1] tracking-[-0.01em]">
          <span className="block text-fg-subtle">{t("schema.titleLead")}</span>
          <span className="block text-fg">{t("schema.titleMain")}</span>
        </h1>
        <p className="mt-3 max-w-[62ch] text-sm text-fg-muted">
          {rich(t("schema.intro"), { strong: (s) => <strong className="font-medium text-fg">{s}</strong> })}
        </p>
      </div>

      <TypeSection
        title={t("schema.blockTypes")}
        empty={t("schema.blockTypesEmpty")}
        rows={blockTypes}
        failed={failed.block}
        onRetry={retry}
        newLabel={t("schema.newBlockType")}
        onNew={() => onOpenBlockType("new")}
        render={(bt) => (
          <button type="button" className={`${ROW} ${ROW_BUTTON}`} key={bt.id} onClick={() => onOpenBlockType(bt.slug)}>
            <span className="w-6 shrink-0 text-center">{bt.icon ?? ""}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{bt.name}</span>
            {codeDefinedTypes && bt.managedBy ? <CodeBadge /> : null}
            <span className="shrink-0 truncate text-fg-subtle">{bt.slug}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{i18n.tp("schema.fieldCount", (bt.fieldsSchema ?? []).length)}</span>
          </button>
        )}
      />

      <TypeSection
        title={t("schema.contentTypes")}
        empty={t("schema.contentTypesEmpty")}
        rows={contentTypes}
        failed={failed.content}
        onRetry={retry}
        newLabel={t("schema.newContentType")}
        onNew={() => onOpenContentType("new")}
        render={(ct) => (
          <button type="button" className={`${ROW} ${ROW_BUTTON}`} key={ct.id} onClick={() => onOpenContentType(ct.slug)}>
            <span className="min-w-0 flex-1 truncate font-medium">{ct.name}</span>
            {codeDefinedTypes && ct.managedBy ? <CodeBadge /> : null}
            <span className="shrink-0 truncate text-fg-subtle">{ct.slug}</span>
            <span className="shrink-0 text-caption text-fg-subtle">{i18n.tp("schema.regionCount", (ct.regions ?? []).length)}</span>
          </button>
        )}
      />
    </div>
  );
}

function TypeSection<T>({ title, empty, rows, failed, onRetry, newLabel, onNew, render }: {
  title: string;
  empty: string;
  rows: T[] | null;
  failed: boolean;
  onRetry: () => void;
  newLabel: string;
  onNew: () => void;
  render: (row: T) => React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center gap-3">
        <Heading level="2" className="font-normal">{title}</Heading>
        <Button variant="secondary" size="sm" onPress={onNew}>{newLabel}</Button>
      </div>
      {rows === null && failed ? (
        <LoadFailed onRetry={onRetry} />
      ) : rows === null ? (
        <p className="text-fg-subtle">{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-fg-subtle">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2">{rows.map(render)}</div>
      )}
    </section>
  );
}

// --- block-type editor ----------------------------------------------------------------

/** The `aria-describedby` target linking a locked fieldset to its explanation. */
const NOTICE_ID = "cms-managed-notice";

/** Empty-string-to-null, for the optional text columns. */
const orNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());

export function BlockTypeEditor({ api, codeDefinedTypes, typeDeletion, slug, onSaved, onDeleted, onBack, backHref, onError }: {
  api: Api;
  /** See `TypesOverview`. */
  codeDefinedTypes: boolean;
  typeDeletion: boolean;
  onDeleted: () => void;
  /** `"new"` creates; anything else loads that block type by slug. */
  slug: string;
  onSaved: (slug: string) => void;
  onBack: () => void;
  /** Where `onBack` goes, as an href: the detail header's way back, for a theme that renders it as a link. */
  backHref: string;
  onError: (s: string) => void;
}) {
  const { t } = useI18n();
  const isNew = slug === "new";
  const [draft, setDraft] = useState<BlockTypeInput>({ name: "", slug: "", fieldsSchema: [] });
  const [id, setId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  // Whether the slug still follows the name. Only ever true for a NEW type: an existing
  // slug is a registry key a front end maps to a component, and the server refuses to
  // change it anyway.
  const [slugFollows, setSlugFollows] = useState(isNew);
  // The draft as it was loaded (or empty, for a new type). Dirty is a comparison against
  // this rather than a flag every mutation has to remember to set.
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify({ name: "", slug: "", fieldsSchema: [] }));
  useUnsavedGuard(JSON.stringify(draft) !== baseline);

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
        setOwner(bt.managedBy ?? null);
        const loaded: BlockTypeInput = {
          name: bt.name,
          slug: bt.slug,
          description: bt.description ?? null,
          icon: bt.icon ?? null,
          category: bt.category ?? null,
          fieldsSchema: bt.fieldsSchema ?? [],
        };
        setDraft(loaded);
        setBaseline(JSON.stringify(loaded));
      })
      // `missing` as well as the error toast: without it the failed load fell through to an
      // EDITABLE, un-badged, empty form for what may well be a code-defined type — a screen
      // asserting the opposite of the truth, whose Save then 400s on a null id.
      .catch((e: Error) => { if (live) setMissing(true); onError(String(e.message ?? e)); })
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
        setBaseline(JSON.stringify(draft)); // saved — the guard stands down
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!id || !confirm(t("blockType.deleteConfirm", { name: draft.name }))) return;
    setBusy(true);
    try {
      await api.deleteBlockType(id);
      setBaseline(JSON.stringify(draft));
      onDeleted();
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{t("blockType.unknown", { slug })}</p></div>;
  if (loading) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{t("common.loading")}</p></div>;

  // An owner means nothing on a server that does not declare the capability.
  const locked = codeDefinedTypes && owner !== null;

  return (
    <div className={WRAP}>
      <DetailHeader title={isNew ? t("blockType.new") : draft.name} parent={t("schema.parent")} href={backHref} onBack={onBack}>
        {locked ? <CodeBadge /> : null}
      </DetailHeader>
      {locked ? <ManagedNotice id={NOTICE_ID} what={t("schema.managed.blockType")} defineFn="defineBlockType" slug={draft.slug} owner={owner} /> : null}
      <ReadOnlyFieldset locked={locked} describedBy={NOTICE_ID} label={t("blockType.formLabel")} className="flex max-w-[860px] flex-col gap-4">
        {ok ? <div className="rounded-lg border border-brand-green bg-brand-green/20 px-3.5 py-2.5 text-small text-fg">{t("schema.savedFlash")}</div> : null}
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <Input
            label={t("schema.name")}
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name, ...(slugFollows ? { slug: slugify(name) } : {}) }))}
          />
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">{t("schema.slug")} {isNew ? null : <span className="text-fg-subtle">{t("schema.slugFixed")}</span>}</span>
            <input
              className={CONTROL}
              value={draft.slug}
              disabled={!isNew}
              onChange={(e) => { setSlugFollows(false); setDraft((d) => ({ ...d, slug: e.target.value.trim() })); }}
            />
            <span className="text-caption text-fg-subtle">
              {isNew
                ? t("blockType.slugHelpNew")
                : t("blockType.slugHelpFixed")}
            </span>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">{t("blockType.icon")}</span>
            <input className={CONTROL} value={draft.icon ?? ""} placeholder={t("blockType.iconPlaceholder")} onChange={(e) => setDraft((d) => ({ ...d, icon: orNull(e.target.value) }))} />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">{t("blockType.category")}</span>
            <input className={CONTROL} value={draft.category ?? ""} placeholder={t("blockType.categoryPlaceholder")} onChange={(e) => setDraft((d) => ({ ...d, category: orNull(e.target.value) }))} />
          </label>
        </div>
        <Textarea label={t("blockType.description")} value={draft.description ?? ""} onChange={(v) => setDraft((d) => ({ ...d, description: orNull(v) }))} />

        <div>
          <Heading level="2" className="mb-2 font-normal">{t("blockType.fields")}</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            {t("blockType.fieldsHelp")}
          </p>
          <FieldSchemaEditor schema={draft.fieldsSchema ?? []} onChange={(fieldsSchema) => setDraft((d) => ({ ...d, fieldsSchema }))} />
        </div>

        {locked ? null : (
          <div className="mt-2 flex gap-2">
            <Button onPress={save} isDisabled={busy || draft.name.trim() === "" || draft.slug.trim() === ""}>
              {busy ? t("common.saving") : isNew ? t("common.create") : t("common.save")}
            </Button>
            {!isNew && typeDeletion && <Button variant="ghost" onPress={remove} isDisabled={busy}>{t("schema.deleteType")}</Button>}
          </div>
        )}
      </ReadOnlyFieldset>
    </div>
  );
}

// --- content-type editor --------------------------------------------------------------

export function ContentTypeEditor({ api, codeDefinedTypes, typeDeletion, slug, onSaved, onDeleted, onBack, backHref, onError }: {
  api: Api;
  /** See `TypesOverview`. */
  codeDefinedTypes: boolean;
  typeDeletion: boolean;
  onDeleted: () => void;
  slug: string;
  onSaved: (slug: string) => void;
  onBack: () => void;
  /** Where `onBack` goes, as an href: the detail header's way back, for a theme that renders it as a link. */
  backHref: string;
  onError: (s: string) => void;
}) {
  const { t } = useI18n();
  const i18n = useI18n();
  const isNew = slug === "new";
  // The one region a new type starts with. Its label is stored with the type, so it is written
  // in the editor's language; the name is a key and stays `content`.
  const [initial] = useState<ContentTypeInput>(() => ({ name: "", slug: "", regions: [{ name: "content", label: t("contentType.defaultRegionLabel"), allowedTypes: null }], fieldsSchema: [], defaultBlocks: [] }));
  const [draft, setDraft] = useState<ContentTypeInput>(initial);
  const [id, setId] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [blockTypes, setBlockTypes] = useState<BlockType[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [slugFollows, setSlugFollows] = useState(isNew);
  const [baseline, setBaseline] = useState<string>(() => JSON.stringify(initial));
  useUnsavedGuard(JSON.stringify(draft) !== baseline);

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
        setOwner(ct.managedBy ?? null);
        const loaded: ContentTypeInput = {
          name: ct.name,
          slug: ct.slug,
          regions: ct.regions ?? [],
          fieldsSchema: ct.fieldsSchema ?? [],
          defaultBlocks: ct.defaultBlocks ?? [],
        };
        setDraft(loaded);
        setBaseline(JSON.stringify(loaded));
      })
      // See the block-type builder: a failed load must not render an editable empty form.
      .catch((e: Error) => { if (live) setMissing(true); onError(String(e.message ?? e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, slug, isNew, onError]);

  const save = async () => {
    // A rename leaves default blocks pointing at the old name. Reconciled HERE, once, rather
    // than on every keystroke: the server refuses an unmatched region, so this is the last
    // moment it can be fixed without the author losing work they can still see on screen.
    const orphaned = (draft.defaultBlocks ?? []).filter((b) => !regions.some((r) => r.name === b.region));
    if (orphaned.length > 0) {
      const names = [...new Set(orphaned.map((b) => b.region))].join(", ");
      if (!confirm(i18n.tp("contentType.orphanedConfirm", orphaned.length, { names }))) return;
      setDraft((d) => ({ ...d, defaultBlocks: (d.defaultBlocks ?? []).filter((b) => regions.some((r) => r.name === b.region)) }));
      return; // The author saves again against the cleaned draft — nothing is dropped unseen.
    }
    setBusy(true);
    try {
      if (isNew) {
        const created = await api.createContentType(draft);
        onSaved(created.slug);
      } else {
        await api.updateContentType(id!, { name: draft.name, regions: draft.regions, fieldsSchema: draft.fieldsSchema, defaultBlocks: draft.defaultBlocks });
        setBaseline(JSON.stringify(draft));
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!id || !confirm(t("contentType.deleteConfirm", { name: draft.name }))) return;
    setBusy(true);
    try {
      await api.deleteContentType(id);
      setBaseline(JSON.stringify(draft));
      onDeleted();
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  if (missing) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{t("contentType.unknown", { slug })}</p></div>;
  if (loading) return <div className={WRAP}><p className="pt-8 text-fg-subtle">{t("common.loading")}</p></div>;

  const regions = draft.regions ?? [];
  const locked = codeDefinedTypes && owner !== null;
  return (
    <div className={WRAP}>
      <DetailHeader title={isNew ? t("contentType.new") : draft.name} parent={t("schema.parent")} href={backHref} onBack={onBack}>
        {locked ? <CodeBadge /> : null}
      </DetailHeader>
      {locked ? <ManagedNotice id={NOTICE_ID} what={t("schema.managed.contentType")} defineFn="defineContentType" slug={draft.slug} owner={owner} /> : null}
      <ReadOnlyFieldset locked={locked} describedBy={NOTICE_ID} label={t("contentType.formLabel")} className="flex max-w-[860px] flex-col gap-5">
        {ok ? <div className="rounded-lg border border-brand-green bg-brand-green/20 px-3.5 py-2.5 text-small text-fg">{t("schema.savedFlash")}</div> : null}
        <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
          <Input
            label={t("schema.name")}
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name, ...(slugFollows ? { slug: slugify(name) } : {}) }))}
          />
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-fg">{t("schema.slug")} {isNew ? null : <span className="text-fg-subtle">{t("schema.slugFixed")}</span>}</span>
            <input
              className={CONTROL}
              value={draft.slug}
              disabled={!isNew}
              onChange={(e) => { setSlugFollows(false); setDraft((d) => ({ ...d, slug: e.target.value.trim() })); }}
            />
            <span className="text-caption text-fg-subtle">
              {isNew ? t("contentType.slugHelpNew") : t("contentType.slugHelpFixed")}
            </span>
          </label>
        </div>

        <div>
          <Heading level="2" className="mb-2 font-normal">{t("contentType.regions")}</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            {t("contentType.regionsHelp")}
          </p>
          <RegionsEditor
            regions={regions}
            blockTypes={blockTypes}
            onChange={(next) => setDraft((d) => ({ ...d, regions: next }))}
            // Pruning happens on REMOVE only, never on an arbitrary change. It used to run
            // on every `onChange` — and the region-name input fires that per keystroke, so
            // typing the first character of a rename made every default block in that region
            // point at a name that no longer existed and deleted them all. They never came
            // back when the rename finished, and saving persisted the loss with no warning.
            onRegionRemoved={(name) => setDraft((d) => ({
              ...d,
              defaultBlocks: (d.defaultBlocks ?? []).filter((b) => b.region !== name),
            }))}
          />
        </div>

        <div>
          <Heading level="2" className="mb-2 font-normal">{t("contentType.pageFields")}</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            {t("contentType.pageFieldsHelp")}
          </p>
          <FieldSchemaEditor schema={draft.fieldsSchema ?? []} onChange={(fieldsSchema) => setDraft((d) => ({ ...d, fieldsSchema }))} />
        </div>

        <div>
          <Heading level="2" className="mb-2 font-normal">{t("contentType.defaultBlocks")}</Heading>
          <p className="mb-3 max-w-[62ch] text-caption text-fg-subtle">
            {t("contentType.defaultBlocksHelp")}
          </p>
          <DefaultBlocksEditor
            blocks={draft.defaultBlocks ?? []}
            regions={regions}
            blockTypes={blockTypes}
            onChange={(defaultBlocks) => setDraft((d) => ({ ...d, defaultBlocks }))}
          />
        </div>

        {locked ? null : (
          <div className="flex gap-2">
            <Button onPress={save} isDisabled={busy || draft.name.trim() === "" || draft.slug.trim() === "" || regions.length === 0}>
              {busy ? t("common.saving") : isNew ? t("common.create") : t("common.save")}
            </Button>
            {!isNew && typeDeletion && <Button variant="ghost" onPress={remove} isDisabled={busy}>{t("schema.deleteType")}</Button>}
            {regions.length === 0 ? <p className="mt-2 text-caption text-danger">{t("contentType.needsRegion")}</p> : null}
          </div>
        )}
      </ReadOnlyFieldset>
    </div>
  );
}

function RegionsEditor({ regions, blockTypes, onChange, onRegionRemoved }: {
  regions: RegionDefinition[];
  blockTypes: BlockType[];
  onChange: (r: RegionDefinition[]) => void;
  /** Fired when a region is DELETED, so the caller can drop its default blocks. Deliberately
   * separate from `onChange`: a rename is not a removal, and treating it as one is what
   * deleted an author's default blocks one keystroke into editing a name. */
  onRegionRemoved: (name: string) => void;
}) {
  const { t } = useI18n();
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
              <span className="text-caption text-fg-subtle">{t("regions.name")}</span>
              <input className={CONTROL} value={r.name} onChange={(e) => set(i, { ...r, name: e.target.value.trim() })} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-caption text-fg-subtle">{t("regions.label")}</span>
              <input className={CONTROL} value={r.label ?? ""} placeholder={r.name} onChange={(e) => set(i, { ...r, label: e.target.value || undefined })} />
            </label>
            <button
              type="button"
              className="px-2 py-2 text-fg-subtle hover:text-danger"
              title={t("regions.remove")}
              onClick={() => { onChange(regions.filter((_, j) => j !== i)); onRegionRemoved(r.name); }}
            >✕</button>
          </div>
          <p className="mb-1.5 text-caption text-fg-subtle">
            {t("regions.allowed")} {r.allowedTypes === null || r.allowedTypes === undefined ? <span className="text-fg">{t("regions.allowedAny")}</span> : null}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {blockTypes.length === 0 ? <span className="text-caption text-fg-subtle">{t("regions.noBlockTypes")}</span> : null}
            {blockTypes.map((bt) => (
              <label key={bt.slug} className="flex items-center gap-1.5">
                <input type="checkbox" checked={(r.allowedTypes ?? []).includes(bt.slug)} onChange={() => toggle(i, bt.slug)} />
                <span className="text-sm text-fg">{bt.name}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <Button variant="secondary" size="sm" className="self-start" onPress={add}>{t("regions.add")}</Button>
    </div>
  );
}

function DefaultBlocksEditor({ blocks, regions, blockTypes, onChange }: {
  blocks: DefaultBlockDefinition[];
  regions: RegionDefinition[];
  blockTypes: BlockType[];
  onChange: (b: DefaultBlockDefinition[]) => void;
}) {
  const { t } = useI18n();
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
              <span className="text-caption text-fg-subtle">{t("defaultBlocks.region")}</span>
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
              <span className="text-caption text-fg-subtle">{t("defaultBlocks.blockType")}</span>
              <select className={CONTROL} value={b.blockTypeSlug} onChange={(e) => set(i, { ...b, blockTypeSlug: e.target.value })}>
                {options.map((bt) => <option key={bt.slug} value={bt.slug}>{bt.name}</option>)}
              </select>
            </label>
            <button type="button" className="px-2 py-2 text-fg-subtle hover:text-danger" title={t("common.remove")} onClick={() => onChange(blocks.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}
      <Button variant="secondary" size="sm" className="self-start" onPress={add} isDisabled={regions.length === 0 || blockTypes.length === 0}>{t("defaultBlocks.add")}</Button>
    </div>
  );
}
