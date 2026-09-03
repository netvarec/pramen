// Schema-driven field forms: one input per FieldDefinition type, recursively composed for
// group/repeater. Media fields open a picker (upload + choose from the library).

import { Button, Heading, Input, ModalDialog, ModalOverlay, ModalSurface, Text, Textarea } from "@podoba/react";
import { BlockEditor } from "@podoba/react/editor";
import { generateHTML, generateJSON } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { Api } from "./api";
import { isRichTextDoc, richTextToPlainText } from "./rich-text";
import type { FieldDefinition, FieldValue, FieldValues, Media, ReferenceOption, ReferenceResult, RichTextDoc } from "./types";

// Tokenized bare control (podoba's filled-field skin) for the native inputs that
// don't map cleanly onto a podoba primitive (number/date/select/file).
export const CONTROL = "h-10 w-full rounded-lg border border-border bg-surface-card px-4 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-brand-green";

function FieldShell({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-2">
      {/* No label element at all when there is no label — an empty one still occupies a
          row and, with a required marker, showed a stray asterisk above the control. */}
      {label === undefined ? null : <span className="text-sm font-medium text-fg">{label}</span>}
      {children}
    </label>
  );
}

/**
 * `YYYY-MM-DDTHH:MM` in LOCAL time — what <input type="datetime-local"> shows and expects.
 *
 * It is only ever the DISPLAY format. The stored value is always a UTC ISO string,
 * because the server decides "is this published yet?" by comparing against its own clock:
 * storing an editor's wall-clock time made "Publish now" in UTC+2 look two hours in the
 * future, so a row published this way stayed invisible until the clock caught up.
 *
 * Returns "" for anything Date can't parse — a legacy or hand-written column value must
 * not reach the input as `NaN-NaN-NaNTNaN:NaN`, which the browser silently discards.
 */
export function toLocalInput(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` string (local wall clock) -> the UTC ISO instant we store. */
export function fromLocalInput(local: string): string | null {
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function formatWhen(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/**
 * Re-render once the row crosses from "scheduled" to "published".
 *
 * `scheduled` is derived from the clock, so without this a form left open across the
 * scheduled instant keeps claiming "Scheduled for 14:00" well after 14:00. The timeout is
 * clamped to the 32-bit setTimeout ceiling — a longer delay overflows and fires
 * immediately — and `tick` is a dependency so a clamped wait re-arms instead of giving up.
 */
function useTickAt(at: number | null): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const ms = at - Date.now();
    if (ms <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(ms + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [at, tick]);
}

/**
 * The three states a `publish` field can be in, as the decision an editor is making:
 * publish it now, publish it at a chosen time, or take it down.
 *
 * A bare datetime-local input made "publish this" mean "work out the current time and
 * type it in", and "unpublish" mean "clear a text box" — neither of which reads as the
 * action it is.
 *
 * NOTE for the caller: these are <button>s, so this must NOT be rendered inside a
 * <label> — a <button> is labelable, and clicking the label text would forward a click
 * to the first one (publishing the row).
 */
function PublishControl({ value, onChange }: { value: string; onChange: (v: string | null) => void }) {
  const [scheduling, setScheduling] = useState(false);
  // The picker's own text, kept separate from the stored instant. A `datetime-local`
  // reports "" for ANY incomplete state, so deleting the year to retype it would
  // otherwise read as "unpublish" — and the debounced autosave would take the row off
  // the site mid-keystroke. Only an explicit Unpublish clears the stored value.
  const [draft, setDraft] = useState("");
  const published = Boolean(value);
  const at = published ? new Date(value).getTime() : Number.NaN;
  const scheduled = Number.isFinite(at) && at > Date.now();

  useTickAt(scheduled ? at : null);

  const status = !published
    ? { text: "Not published", tone: "text-fg-muted" }
    : scheduled
      ? { text: `Scheduled for ${formatWhen(value)}`, tone: "text-accent-strong" }
      : { text: `Published ${formatWhen(value)}`, tone: "text-fg" };

  const toggleScheduler = () => {
    setDraft(toLocalInput(value));
    setScheduling((s) => !s);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className={`text-sm ${status.tone}`}>{status.text}</span>
      <div className="flex flex-wrap items-center gap-2">
        {/* Also offered while SCHEDULED: taking a scheduled row live early otherwise meant
            hand-typing the current time, the very thing this control exists to remove. */}
        {!published || scheduled ? (
          <Button size="sm" onPress={() => { setScheduling(false); onChange(new Date().toISOString()); }}>
            Publish now
          </Button>
        ) : null}
        <Button variant="secondary" size="sm" onPress={toggleScheduler}>
          {scheduled ? "Change schedule" : published ? "Change time" : "Schedule…"}
        </Button>
        {published ? (
          // Clearing the value is what takes the row off the site — the read policy is
          // scoped to this field being set.
          <Button variant="ghost" size="sm" className="text-danger" onPress={() => { setScheduling(false); onChange(null); }}>
            Unpublish
          </Button>
        ) : null}
      </div>
      {scheduling ? (
        <input
          className={CONTROL}
          type="datetime-local"
          // Shown in the editor's own timezone; stored as UTC. Driven by `draft`, not
          // `value`, so a half-typed date survives instead of snapping back.
          value={draft}
          autoFocus
          onChange={(e) => {
            setDraft(e.target.value);
            const iso = e.target.value ? fromLocalInput(e.target.value) : null;
            if (iso) onChange(iso);
          }}
        />
      ) : null}
    </div>
  );
}

export function FieldForm({ schema, value, onChange, api }: { schema: FieldDefinition[]; value: FieldValues; onChange: (v: FieldValues) => void; api: Api }) {
  const set = (name: string, v: FieldValue) => onChange({ ...value, [name]: v });
  return (
    <div className="flex flex-col gap-4">
      {schema.map((def) => (
        // `siblings` is only read by field types that derive from another field (slug).
        <FieldInput key={def.name} def={def} value={value[def.name]} onChange={(v) => set(def.name, v)} api={api} siblings={value} />
      ))}
    </div>
  );
}

/**
 * `hideLabelAs` renders the field with NO visible label, using the given string as its
 * accessible name instead. The single-field repeater asks for this: the list already
 * carries the name, so repeating it on every row is noise — but an unlabelled input is
 * announced as a bare edit field, so the name has to go somewhere.
 *
 * It cannot be done by passing an empty label: `text`/`url`/`textarea` render through
 * podoba's `Input`/`Textarea`, which emit `<Label>{label}</Label>` unconditionally — an
 * empty label element still claims a flex row and its `gap-3`, and still wins the
 * accessible-name computation via `aria-labelledby`. Those three go through the bare
 * `CONTROL` skin instead, the same way `number`/`date` already do.
 */
function FieldInput({ def, value, onChange, api, hideLabelAs, siblings }: { def: FieldDefinition; value: FieldValue; onChange: (v: FieldValue) => void; api: Api; hideLabelAs?: string; siblings?: FieldValues }) {
  const label: ReactNode = hideLabelAs !== undefined ? undefined : (
    <>
      {def.label ?? def.name} {def.required ? <span className="text-danger">*</span> : null}
    </>
  );
  const asText = (v: FieldValue) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  switch (def.type) {
    case "text":
    case "url": {
      const placeholder = def.type === "url" ? "https://…" : "";
      return hideLabelAs !== undefined ? (
        <input className={CONTROL} type="text" aria-label={hideLabelAs} placeholder={placeholder} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input label={label} value={(value as string) ?? ""} onChange={onChange} placeholder={placeholder} />
      );
    }
    case "textarea":
      return hideLabelAs !== undefined ? (
        <textarea className={`${CONTROL} h-auto min-h-20 py-2.5`} aria-label={hideLabelAs} value={asText(value)} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Textarea label={label} value={asText(value)} onChange={onChange} />
      );
    case "richtext":
      // A rich-text value is a document tree. A legacy HTML string still opens (it seeds
      // the editor as-is) and is upgraded to a doc by the first save.
      return (
        <FieldShell label={label}>
          <RichText value={value as RichTextDoc | string | null} onChange={onChange as (v: RichTextDoc) => void} />
        </FieldShell>
      );
    case "number":
      return (
        <FieldShell label={label}>
          <input className={CONTROL} type="number" aria-label={hideLabelAs} value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
        </FieldShell>
      );
    case "date":
    case "datetime":
      return (
        <FieldShell label={label}>
          <input className={CONTROL} type={def.type === "date" ? "date" : "datetime-local"} aria-label={hideLabelAs} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
        </FieldShell>
      );
    case "slug":
      return (
        <SlugField
          def={def}
          label={label}
          value={typeof value === "string" ? value : ""}
          source={typeof siblings?.[def.from ?? ""] === "string" ? (siblings[def.from ?? ""] as string) : ""}
          onChange={onChange as (v: string) => void}
        />
      );
    case "publish":
      // Deliberately NOT FieldShell: it wraps children in a <label>, whose implicit
      // control would be PublishControl's first <button> ("Publish now") — clicking the
      // label text would then publish the row. Same reason the boolean case opts out.
      return (
        <div className="flex w-full flex-col gap-2">
          <span className="text-sm font-medium text-fg">{label}</span>
          <PublishControl value={typeof value === "string" ? value : ""} onChange={onChange as (v: string | null) => void} />
        </div>
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span className="text-sm text-fg">{def.label ?? def.name}</span>
        </label>
      );
    case "select":
      return (
        <FieldShell label={label}>
          <SelectField def={def} value={value as string | null} onChange={onChange} api={api} ariaLabel={hideLabelAs} />
        </FieldShell>
      );
    case "media":
      return (
        <FieldShell label={label}>
          <MediaField value={value as string | null} onChange={onChange} api={api} />
        </FieldShell>
      );
    case "reference":
      // Deliberately NOT FieldShell: the control is a row of <button>s, and a <label>
      // wrapper would forward a click on the label text to the first one (opening the
      // picker). Same reason `publish` and `boolean` opt out.
      return (
        <div className="flex w-full flex-col gap-2">
          {label === undefined ? null : <span className="text-sm font-medium text-fg">{label}</span>}
          <ReferenceField def={def} value={value} onChange={onChange} api={api} ariaLabel={hideLabelAs} />
        </div>
      );
    case "group":
      return (
        <FieldShell label={label}>
          <div className="rounded-lg border border-border bg-surface-muted p-3.5">
            <FieldForm schema={def.fields ?? []} value={(value as FieldValues) ?? {}} onChange={onChange as (v: FieldValues) => void} api={api} />
          </div>
        </FieldShell>
      );
    case "repeater":
      return <Repeater def={def} value={(value as FieldValues[]) ?? []} onChange={onChange as (v: FieldValues[]) => void} api={api} label={label} />;
    default:
      return null;
  }
}

// --- rich text (WYSIWYG) --------------------------------------------------------------
// The `richtext` field is podoba's Notion-style BlockEditor (Tiptap): `/` slash palette,
// block conversion, inline bubble toolbar.
//
// The STORED value is a document tree (`RichTextDoc`), never HTML. BlockEditor's own
// value contract is an HTML string — its docs call that presentation-only — so the
// conversion happens here, at the boundary, and the HTML never leaves this component:
// seeded from the stored doc on mount, converted back to a doc on every change.
//
// The extension set MUST match BlockEditor's, or a round-trip silently drops whatever
// only its schema knows (task lists, highlights). Kept beside it here for that reason.
const RT_EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true }),
];

/** Parse editor HTML into a document. Never throws: a parse failure yields an empty
 * document rather than taking the render down (this runs on every keystroke). */
function htmlToDoc(html: string): RichTextDoc {
  try {
    return generateJSON(html, RT_EXTENSIONS) as RichTextDoc;
  } catch (e) {
    console.error("pramen/cms-editor: could not parse editor HTML", e);
    return { type: "doc", content: [] };
  }
}

/** Seed HTML for the editor. A legacy HTML string passes through untouched — that is the
 * migration ramp (see `RichText`, which upgrades it on mount).
 *
 * `generateHTML` throws a RangeError for any node or mark outside RT_EXTENSIONS, and this
 * runs in a useState initializer with no ErrorBoundary above it — so an un-normalized
 * document (a custom `richTextSchema`, an import, a bootstrap seed, `ctx.db.exec`) would
 * throw during render and blank the whole SPA, not just this field. Fail to an empty
 * editor and say so instead. */
function docToEditorHtml(value: RichTextDoc | string | null | undefined): string {
  if (typeof value === "string") return value;
  if (!isRichTextDoc(value)) return "";
  try {
    return generateHTML(value, RT_EXTENSIONS);
  } catch (e) {
    console.error("pramen/cms-editor: rich-text document uses nodes this editor cannot render", e);
    return "";
  }
}

export function RichText({ value, onChange }: { value: RichTextDoc | string | null; onChange: (v: RichTextDoc) => void }) {
  // BlockEditor requires its own HTML echoed back VERBATIM — normalising in render would
  // re-seed the document on every keystroke and throw the caret back to the start. So the
  // HTML lives in local state and the doc goes upward.
  const [html, setHtml] = useState(() => docToEditorHtml(value));
  const emitted = useRef<RichTextDoc | null>(null);

  // Upgrade a legacy HTML value to a document AS SOON AS IT OPENS, not on first edit of
  // this field. The server only tolerates a legacy string that is byte-identical to what
  // is stored, and both renderers emit nothing for a string — so a value that is never
  // upgraded stays invisible on the site forever. Converting on mount means any ordinary
  // save (even of a sibling field) writes it back as a document.
  const upgraded = useRef(false);
  useEffect(() => {
    if (upgraded.current || typeof value !== "string" || value === "") return;
    upgraded.current = true;
    const doc = htmlToDoc(value);
    emitted.current = doc;
    onChange(doc);
  }, [value, onChange]);

  // Re-seed only when the parent hands us a doc that is not the one we last emitted —
  // i.e. the form switched to a different block, not our own change coming back around.
  useEffect(() => {
    if (value !== null && value === emitted.current) return;
    setHtml(docToEditorHtml(value));
    // Only the incoming value should re-seed; `html` is this effect's output, not its input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (nextHtml: string) => {
    setHtml(nextHtml);
    const doc = htmlToDoc(nextHtml);
    emitted.current = doc;
    onChange(doc);
  };

  return <BlockEditor value={html} onChange={handleChange} minHeight={180} placeholder="Write, or press '/' for blocks…" />;
}

/**
 * A repeater's items.
 *
 * Two shapes, because a list of one field and a list of six are different things to edit.
 * A SINGLE-field repeater (bullet points) renders one row per item — handle, input,
 * actions — with no card and no field label repeated down the page saying the same word.
 * Anything wider keeps a card, with a header that summarises the item so eight slides are
 * scannable without expanding each one.
 *
 * Reordering is drag-and-drop from the ⠿ handle, mirroring the block canvas. ↑/↓ stay,
 * because dragging is unavailable to keyboard users and awkward on touch.
 */
function Repeater({ def, value, onChange, api, label }: { def: FieldDefinition; value: FieldValues[]; onChange: (v: FieldValues[]) => void; api: Api; label: ReactNode }) {
  const items = Array.isArray(value) ? value : [];
  const fields = def.fields ?? [];
  // One field, and not itself a tall control — the case where the card is pure overhead.
  const compact = fields.length === 1 && !["repeater", "group", "richtext", "media"].includes(fields[0].type);

  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const upd = (i: number, v: FieldValues) => onChange(items.map((it, j) => (j === i ? v : it)));
  const add = () => onChange([...items, {}]);
  const del = (i: number) => onChange(items.filter((_, j) => j !== i));
  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };
  const move = (i: number, d: number) => moveTo(i, i + d);

  const atMax = def.max != null && items.length >= def.max;
  const atMin = def.min != null && items.length <= def.min;

  /**
   * The card header's summary: the item's first bit of human-readable text.
   *
   * Restricted to prose-ish field types on purpose. Taking the first non-empty STRING
   * instead titled every slide with the uuid of its image, which is worse than no summary
   * at all — the point is to tell two rows apart at a glance.
   */
  const summarise = (it: FieldValues): string => {
    const readable = ["text", "textarea", "richtext", "select", "url"];
    for (const f of fields) {
      if (!readable.includes(f.type)) continue;
      const v = it[f.name];
      // A `richtext` value is a document tree, so a string check alone would skip the one
      // prose field an item has — exactly the row this summary exists to distinguish.
      const text = isRichTextDoc(v) ? richTextToPlainText(v) : typeof v === "string" ? v.replace(/<[^>]+>/g, " ") : "";
      const trimmed = text.replace(/\s+/g, " ").trim();
      if (trimmed) return trimmed.slice(0, 80);
    }
    return "";
  };

  const dropZone = (i: number) => ({
    onDragOver: (e: DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      setDrag((d) => (d && d.over !== i ? { ...d, over: i } : d));
    },
    onDrop: (e: DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      moveTo(drag.from, i);
      setDrag(null);
    },
  });

  const handle = (i: number) => (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without a payload, but the payload must be
        // EMPTY: a card-variant drop zone spans the item's rich-text body, and
        // ProseMirror's own `drop` listener (on view.dom, so it runs before React's
        // delegated one — preventDefault here can't stop it) pastes `text/plain` at the
        // cursor. An empty slice leaves the doc equal and PM bails. Same reason the block
        // canvas passes "" (components.tsx).
        e.dataTransfer.setData("text/plain", "");
        setDrag({ from: i, over: i });
      }}
      onDragEnd={() => setDrag(null)}
      className="cursor-grab select-none px-1 text-fg-subtle transition-colors hover:text-fg active:cursor-grabbing"
      title="Drag to reorder"
      aria-hidden
    >⠿</span>
  );

  const rowState = (i: number) =>
    `${drag && drag.over === i && drag.from !== i ? "ring-2 ring-brand-green" : ""} ${drag && drag.from === i ? "opacity-40" : ""}`;

  /**
   * Row actions. Revealed on row hover, on keyboard focus anywhere in the row, and
   * unconditionally where hover doesn't exist.
   *
   * `group/row` is NAMED on purpose: `BlockCard` is also a `group`, and an unnamed
   * `group-hover:` matches ANY `.group` ancestor — hovering the block revealed every
   * row's actions at once. And Tailwind v4 emits `hover:`/`group-hover:` under
   * `@media (hover: hover)`, so on touch (where drag-and-drop doesn't work either)
   * a hover-only affordance leaves no way at all to reorder or delete.
   */
  const ACTIONS_VISIBILITY =
    "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100";

  const actions = (i: number) => (
    <div className="flex shrink-0 items-center">
      <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
      <button type="button" className="px-1.5 text-fg-subtle hover:text-fg disabled:opacity-30" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
      <button type="button" className="px-1.5 text-fg-subtle hover:text-danger disabled:opacity-30" title="Remove" disabled={atMin} onClick={() => del(i)}>✕</button>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-fg">{label}</span>

      {items.length === 0 ? <span className="text-sm text-fg-muted">None yet.</span> : null}

      <div className={`flex flex-col ${compact ? "gap-1" : "gap-2"}`}>
        {items.map((it, i) =>
          compact ? (
            // One row: handle, input, actions.
            <div key={i} className={`group/row flex items-center gap-1 rounded-lg px-1 py-0.5 transition-colors ${rowState(i)}`} {...dropZone(i)}>
              {handle(i)}
              <div className="min-w-0 flex-1">
                {/* No visible label — it would repeat the list's own name down the page
                    ("Bod", "Bod", "Bod"…) — but the input still needs an accessible one,
                    and one that tells the rows apart. */}
                <FieldInput
                  def={fields[0]}
                  hideLabelAs={`${def.label ?? def.name} ${i + 1}`}
                  value={it[fields[0].name]}
                  onChange={(v) => upd(i, { ...it, [fields[0].name]: v })}
                  api={api}
                />
              </div>
              <div className={ACTIONS_VISIBILITY}>{actions(i)}</div>
            </div>
          ) : (
            <div key={i} className={`rounded-lg border border-border bg-surface-muted transition-colors ${rowState(i)}`} {...dropZone(i)}>
              <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
                {handle(i)}
                <span className="text-caption text-fg-subtle">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{summarise(it)}</span>
                {actions(i)}
              </div>
              <div className="p-3.5">
                <FieldForm schema={fields} value={it} onChange={(v) => upd(i, v)} api={api} />
              </div>
            </div>
          ),
        )}
      </div>

      {/* Named, not a bare "+ Add": a content type with several repeaters would otherwise
          render several buttons with identical accessible names. */}
      <Button variant="secondary" size="sm" className="self-start" onPress={add} isDisabled={atMax}>
        + Add {def.label ?? def.name}
      </Button>
    </div>
  );
}

/**
 * Turn a title into a URL segment.
 *
 * Diacritics are decomposed and their marks dropped, so Czech text transliterates the way
 * a reader expects — "Vrátnice výrobního závodu" becomes "vratnice-vyrobniho-zavodu"
 * rather than losing the accented letters entirely.
 */
export function slugify(input: string): string {
  // Trailing trim AFTER the length cap — slicing a hyphen-terminated prefix out of a long
  // title would otherwise leave the slug ending in "-".
  return slugifyInput(input).replace(/-+$/, "");
}

/**
 * Per-keystroke normalization: everything `slugify` does EXCEPT the trailing-hyphen trim.
 *
 * The input is controlled, so anything this strips can never be typed at all — trimming the
 * trailing "-" here would make a separator unenterable (type "my-", `slugify` hands back
 * "my", the value prop never changes, React restores the DOM). The full `slugify` runs on
 * blur instead, once the word is finished.
 */
function slugifyInput(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 80);
}

/**
 * A slug that follows another field while it is untouched.
 *
 * It deliberately stops following the moment the value differs from what it last derived
 * — which includes every row that already has a slug. Renaming a published project must
 * not silently change its URL and break every link to it; "Generate from …" is there for
 * when that IS what you want.
 */
function SlugField({ def, label, value, source, onChange }: { def: FieldDefinition; label: ReactNode; value: string; source: string; onChange: (v: string) => void }) {
  // What this control last wrote. While the field still holds it, the field is "untouched"
  // and free to follow; anything else means a human typed it.
  const derived = useRef<string | null>(null);
  // Whether a human has edited this field. Once true it stays true for the session —
  // emptying the field is an edit, not an invitation to start following again.
  const touched = useRef(false);
  // The source we last saw. Seeded on the first run so merely OPENING a row never derives:
  // a row saved before this field existed has a filled title and an empty slug, and an
  // onChange there marks the block dirty and autosaves something nobody asked for. Only a
  // real change to the source field derives; "Generate from …" covers the rest.
  const lastSource = useRef<string | null>(null);

  useEffect(() => {
    if (!def.from) return;
    const prev = lastSource.current;
    lastSource.current = source;
    if (prev === null || prev === source || !source) return;
    if (touched.current) return;
    // Follow only an empty field or one still holding our own last derivation — an existing
    // slug is a live URL, and renaming its page must not break every link to it.
    if (value !== "" && value !== derived.current) return;
    const next = slugify(source);
    if (next === value) return;
    derived.current = next;
    onChange(next);
  }, [source, value, def.from, onChange]);

  const suggestion = source ? slugify(source) : "";
  const canGenerate = Boolean(suggestion) && suggestion !== value;

  return (
    <FieldShell label={label}>
      <input
        className={CONTROL}
        value={value}
        onChange={(e) => {
          touched.current = true; // typed by hand — stop following from here on
          derived.current = null;
          onChange(slugifyInput(e.target.value));
        }}
        onBlur={() => {
          const clean = slugify(value);
          if (clean !== value) onChange(clean);
        }}
        placeholder={suggestion}
      />
      {canGenerate ? (
        <button
          type="button"
          className="self-start text-caption text-fg-subtle underline hover:text-fg"
          onClick={() => { derived.current = suggestion; touched.current = false; onChange(suggestion); }}
        >
          Generate from {def.from}: {suggestion}
        </button>
      ) : null}
    </FieldShell>
  );
}

// A `select` field. Static `options` render as-is; when `optionsFrom` is set, the options are
// fetched once from that query handler (returns `{ value, label }[]`) — e.g. a live list of
// campaigns — so the editor never has to hardcode or copy identifiers by hand.
function SelectField({ def, value, onChange, api, ariaLabel }: { def: FieldDefinition; value: string | null; onChange: (v: FieldValue) => void; api: Api; ariaLabel?: string }) {
  const [dyn, setDyn] = useState<{ value: string; label: string }[] | null>(null);
  const from = def.optionsFrom;
  useEffect(() => {
    if (!from) return;
    let alive = true;
    api
      .call<{ value: string; label: string }[]>(from)
      .then((r) => { if (alive) setDyn(Array.isArray(r) ? r : []); })
      .catch(() => { if (alive) setDyn([]); });
    return () => { alive = false; };
  }, [from, api]);
  const loading = Boolean(from) && dyn === null;
  const opts = from ? dyn ?? [] : (def.options ?? []).map((o) => ({ value: o, label: o }));
  return (
    <select className={CONTROL} aria-label={ariaLabel} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{loading ? "Načítám…" : "—"}</option>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function MediaField({ value, onChange, api }: { value: string | null; onChange: (v: string | null) => void; api: Api }) {
  const [open, setOpen] = useState(false);
  const [media, setMedia] = useState<Media | null>(null);
  useEffect(() => {
    if (value) api.call<Media | null>("getMedia", { id: value }).then(setMedia).catch(() => setMedia(null));
    else setMedia(null);
  }, [value, api]);
  return (
    <div>
      <div className="flex items-center gap-3 rounded-[14px] border border-transparent bg-surface-card px-[18px] py-3.5">
        {media ? <img className="h-10 w-10 rounded object-cover" src={api.resolve(`/media/${media.file.key}`)} alt="" /> : <span className="text-fg-subtle">no media</span>}
        <span className="flex-1 truncate text-fg-subtle">{media?.file.filename ?? value ?? ""}</span>
        <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>pick</Button>
        {value ? (
          <Button variant="ghost" size="sm" className="text-danger" onPress={() => onChange(null)}>clear</Button>
        ) : null}
      </div>
      {open ? (
        <MediaPicker
          api={api}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            onChange(id);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function MediaPicker({ api, onClose, onPick }: { api: Api; onClose: () => void; onPick: (id: string) => void }) {
  const [media, setMedia] = useState<Media[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const refresh = () => api.listMedia().then(setMedia).catch((e) => setErr(String(e.message ?? e)));
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const upload = async (file: File) => {
    setBusy(true);
    setErr("");
    try {
      const row = await api.uploadMedia(file);
      onPick(row.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
      <ModalSurface className="w-full max-w-[680px] px-9 py-8">
        <ModalDialog className="max-h-[86vh] overflow-auto outline-none">
          <Heading level="1" className="mb-5 font-normal">
            Choose <span className="text-fg-subtle">a file</span> from the library
          </Heading>
          {err ? (
            <div className="my-2 rounded-lg border border-danger bg-surface-card px-3.5 py-2.5 text-small text-danger">{err}</div>
          ) : null}
          <label className="mb-4 flex w-full flex-col gap-2">
            <Text size="small" weight="medium">
              Upload a new file
            </Text>
            <input type="file" className="text-small text-fg-muted" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
            {media.map((m) => (
              <div key={m.id} className="cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-card" onClick={() => onPick(m.id)}>
                {(m.file.contentType ?? "").startsWith("image/") ? <img className="block h-[130px] w-full object-cover" src={api.resolve(`/media/${m.file.key}`)} alt="" /> : <div className="h-[130px] bg-surface-muted" />}
                <div className="truncate px-2 py-1.5 text-caption text-fg-muted">{m.file.filename ?? m.id}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-right">
            <Button variant="ghost" onPress={onClose}>
              close
            </Button>
          </div>
        </ModalDialog>
      </ModalSurface>
    </ModalOverlay>
  );
}

// --- reference ------------------------------------------------------------------------
//
// A pointer to a record that is not this row. `select` + `optionsFrom` already does the
// easy half — fetch `{ value, label }[]` once, render a `<select>` — and stays the right
// answer for twenty campaigns. It has no answer for a thousand records: no search, no
// paging, and no way to render the label of a stored value that is not in the one page it
// fetched, so an existing row shows a uuid.
//
// So this control asks the server two different questions, and the second is the one that
// makes it work on an existing row:
//
//   { search, limit, offset } -> browse / search  (the picker)
//   { ids: [...] }            -> resolve labels   (what the closed control renders)
//
// The stored value stays an opaque id, so the same field points at a pramen row or at a
// record in a system we do not own.

const REFERENCE_PAGE_SIZE = 20;

/** Tolerate a handler that answers with a bare array — the `optionsFrom` shape — so a
 * `select`'s existing options handler can be pointed at a `reference` without a rewrite. */
function asReferenceResult(raw: unknown): ReferenceResult {
  if (Array.isArray(raw)) return { items: raw as ReferenceOption[] };
  const r = raw as ReferenceResult | null;
  return { items: Array.isArray(r?.items) ? r.items : [], hasMore: r?.hasMore };
}

/** Resolve labels for ids that are already stored.
 *
 * Only ever asks for ids it does not already have a label for, and keeps what it has
 * across renders: a repeater of twenty references would otherwise re-resolve every one of
 * them on every keystroke in a sibling field. */
function useReferenceLabels(api: Api, from: string | undefined, ids: readonly string[]): Map<string, ReferenceOption> {
  const [known, setKnown] = useState<Map<string, ReferenceOption>>(() => new Map());
  // The ids, as a stable primitive — an array literal is a new identity every render.
  const key = ids.join(" ");
  useEffect(() => {
    if (!from) return;
    const wanted = key === "" ? [] : key.split(" ");
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length === 0) return;
    let alive = true;
    api
      .call<ReferenceResult>(from, { ids: missing })
      .then((r) => {
        if (!alive) return;
        const items = asReferenceResult(r).items;
        setKnown((prev) => {
          const next = new Map(prev);
          for (const it of items) next.set(it.value, it);
          // An id the handler did not answer for is recorded as UNRESOLVED rather than left
          // missing — otherwise this effect asks for it again on every render, forever, for
          // a record that has been deleted.
          for (const id of missing) if (!next.has(id)) next.set(id, { value: id, label: "" });
          return next;
        });
      })
      .catch(() => {
        if (!alive) return;
        setKnown((prev) => {
          const next = new Map(prev);
          for (const id of missing) if (!next.has(id)) next.set(id, { value: id, label: "" });
          return next;
        });
      });
    return () => { alive = false; };
  }, [api, from, key, known]);
  return known;
}

/** What a stored id renders as while it is being resolved, and after it could not be. */
function referenceLabel(id: string, known: Map<string, ReferenceOption>): { label: string; muted: boolean } {
  const hit = known.get(id);
  if (!hit) return { label: "Loading...", muted: true };
  // An empty label is the recorded "no such record" — show the raw id, because that is the
  // only thing left that identifies what the row points at.
  return hit.label ? { label: hit.label, muted: false } : { label: id, muted: true };
}

function ReferenceField({ def, value, onChange, api, ariaLabel }: { def: FieldDefinition; value: FieldValue; onChange: (v: FieldValue) => void; api: Api; ariaLabel?: string }) {
  const multiple = def.multiple === true;
  // `unknown[]` before filtering: `FieldValue` is a union that INCLUDES array members, so
  // `Array.isArray` narrows to a union of array types and the type-guard overload of
  // `.filter` no longer resolves. The guard below is the real narrowing either way.
  const ids: string[] = multiple
    ? (Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === "string") : [])
    : typeof value === "string" && value !== "" ? [value] : [];
  const known = useReferenceLabels(api, def.referenceFrom, ids);
  const [picking, setPicking] = useState(false);

  const pick = (opt: ReferenceOption) => {
    if (multiple) {
      if (!ids.includes(opt.value)) onChange([...ids, opt.value]);
    } else {
      onChange(opt.value);
      setPicking(false);
    }
  };
  const remove = (id: string) => onChange(multiple ? ids.filter((v) => v !== id) : null);

  // Nothing to pick FROM. Said out loud rather than rendered as an empty control that
  // silently does nothing when clicked — this is a schema mistake, and the person seeing it
  // is the one who can fix it.
  if (!def.referenceFrom) {
    return <span className="text-sm text-danger">This reference field declares no `referenceFrom` handler.</span>;
  }

  return (
    <div className="flex flex-col gap-2">
      {ids.length === 0 ? (
        <span className="text-sm text-fg-muted">Nothing selected.</span>
      ) : (
        <div className="flex flex-col gap-1">
          {ids.map((id) => {
            const { label, muted } = referenceLabel(id, known);
            const hint = known.get(id)?.hint;
            return (
              <div key={id} className="flex items-center gap-2 rounded-[14px] bg-surface-card px-4 py-2.5">
                <span className={`min-w-0 flex-1 truncate text-sm ${muted ? "text-fg-subtle" : "text-fg"}`}>{label}</span>
                {hint ? <span className="shrink-0 text-caption text-fg-subtle">{hint}</span> : null}
                <Button variant="ghost" size="sm" className="text-danger" onPress={() => remove(id)}>remove</Button>
              </div>
            );
          })}
        </div>
      )}
      <Button variant="secondary" size="sm" className="self-start" aria-label={ariaLabel} onPress={() => setPicking(true)}>
        {multiple ? "+ Add" : ids.length > 0 ? "Change" : "Choose"}
      </Button>
      {picking ? (
        <ReferencePicker
          api={api}
          from={def.referenceFrom}
          title={def.label ?? def.name}
          selected={ids}
          multiple={multiple}
          onPick={pick}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function ReferencePicker({ api, from, title, selected, multiple, onPick, onClose }: {
  api: Api;
  from: string;
  title: string;
  selected: readonly string[];
  multiple: boolean;
  onPick: (opt: ReferenceOption) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ReferenceOption[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // Debounced: the fetch keys on `term`, so typing does not fire a request per character.
  const [term, setTerm] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(
    (offset: number) => {
      setLoading(true);
      setErr("");
      return api
        .call<ReferenceResult>(from, { search: term || undefined, limit: REFERENCE_PAGE_SIZE, offset })
        .then((raw) => {
          const r = asReferenceResult(raw);
          setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
          // A handler that omits `hasMore` is taken at its word only when it returned a
          // SHORT page; a full one is assumed to have more — the same rule the page and
          // collection lists use.
          setHasMore(r.hasMore ?? r.items.length === REFERENCE_PAGE_SIZE);
        })
        .catch((e: unknown) => setErr(String((e as Error)?.message ?? e)))
        .finally(() => setLoading(false));
    },
    [api, from, term],
  );

  useEffect(() => { void load(0); }, [load]);

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => !open && onClose()}>
      <ModalSurface className="w-full max-w-[560px] px-9 py-8">
        <ModalDialog className="max-h-[86vh] overflow-auto outline-none">
          <Heading level="1" className="mb-5 font-normal">
            Choose <span className="text-fg-subtle">{title.toLowerCase()}</span>
          </Heading>
          <input
            className={`${CONTROL} mb-3`}
            type="search"
            autoFocus
            placeholder="Search"
            aria-label="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {err ? <div className="mb-2 rounded-lg border border-danger bg-surface-card px-3.5 py-2.5 text-small text-danger">{err}</div> : null}
          <div className="flex flex-col gap-1">
            {items.map((opt) => {
              const already = selected.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  disabled={already}
                  onClick={() => onPick(opt)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-muted disabled:opacity-40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">{opt.label}</span>
                    {opt.hint ? <span className="block truncate text-caption text-fg-subtle">{opt.hint}</span> : null}
                  </span>
                  {already ? <span className="shrink-0 text-caption text-fg-subtle">selected</span> : null}
                </button>
              );
            })}
            {!loading && items.length === 0 ? <p className="px-3 py-2 text-sm text-fg-subtle">Nothing matches.</p> : null}
            {loading ? <p className="px-3 py-2 text-sm text-fg-subtle">Loading...</p> : null}
          </div>
          {hasMore && !loading ? (
            <div className="mt-3 text-center">
              <Button variant="secondary" size="sm" onPress={() => void load(items.length)}>Load more</Button>
            </div>
          ) : null}
          <div className="mt-3 text-right">
            <Button variant="ghost" onPress={onClose}>{multiple ? "done" : "close"}</Button>
          </div>
        </ModalDialog>
      </ModalSurface>
    </ModalOverlay>
  );
}
