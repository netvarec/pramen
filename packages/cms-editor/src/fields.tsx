// Schema-driven field forms: one input per FieldDefinition type, recursively composed for
// group/repeater. Media fields open a picker (upload + choose from the library).

import { Button, Heading, Input, ModalDialog, ModalOverlay, ModalSurface, Text, Textarea } from "@podoba/react";
import { BlockEditor } from "@podoba/react/editor";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import type { Api } from "./api";
import type { FieldDefinition, Media } from "./types";

// Tokenized bare control (podoba's filled-field skin) for the native inputs that
// don't map cleanly onto a podoba primitive (number/date/select/file).
const CONTROL = "h-10 w-full rounded-lg border border-border bg-surface-card px-4 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-brand-green";

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
function toLocalInput(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` string (local wall clock) -> the UTC ISO instant we store. */
function fromLocalInput(local: string): string | null {
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function formatWhen(value: string): string {
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

export function FieldForm({ schema, value, onChange, api }: { schema: FieldDefinition[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; api: Api }) {
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });
  return (
    <div className="flex flex-col gap-4">
      {schema.map((def) => (
        <FieldInput key={def.name} def={def} value={value[def.name]} onChange={(v) => set(def.name, v)} api={api} />
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
function FieldInput({ def, value, onChange, api, hideLabelAs }: { def: FieldDefinition; value: unknown; onChange: (v: unknown) => void; api: Api; hideLabelAs?: string }) {
  const label: ReactNode = hideLabelAs !== undefined ? undefined : (
    <>
      {def.label ?? def.name} {def.required ? <span className="text-danger">*</span> : null}
    </>
  );
  const asText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
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
      // A rich-text value is an HTML string (round-trips with the site's set:html
      // renderers). A legacy object value isn't editable here — fall back to raw text.
      return (
        <FieldShell label={label}>
          <RichText value={typeof value === "string" ? value : ""} onChange={onChange as (v: string) => void} />
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
    case "group":
      return (
        <FieldShell label={label}>
          <div className="rounded-lg border border-border bg-surface-muted p-3.5">
            <FieldForm schema={def.fields ?? []} value={(value as Record<string, unknown>) ?? {}} onChange={onChange as (v: Record<string, unknown>) => void} api={api} />
          </div>
        </FieldShell>
      );
    case "repeater":
      return <Repeater def={def} value={(value as Record<string, unknown>[]) ?? []} onChange={onChange as (v: unknown[]) => void} api={api} label={label} />;
    default:
      return null;
  }
}

// --- rich text (WYSIWYG) --------------------------------------------------------------
// The `richtext` field is podoba's Notion-style BlockEditor (Tiptap): `/` slash palette,
// block conversion, inline bubble toolbar. Still an HTML string in/out, so it round-trips
// with existing rich_text content + every set:html renderer — no value migration. The
// server's sanitizeRichText() (@pramen/cms) remains the XSS boundary on write; ProseMirror
// parses HTML to its schema on load, so scripts never survive into the editor either.

export function RichText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <BlockEditor value={value} onChange={onChange} minHeight={180} placeholder="Write, or press '/' for blocks…" />;
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
function Repeater({ def, value, onChange, api, label }: { def: FieldDefinition; value: Record<string, unknown>[]; onChange: (v: unknown[]) => void; api: Api; label: ReactNode }) {
  const items = Array.isArray(value) ? value : [];
  const fields = def.fields ?? [];
  // One field, and not itself a tall control — the case where the card is pure overhead.
  const compact = fields.length === 1 && !["repeater", "group", "richtext", "media"].includes(fields[0].type);

  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  const upd = (i: number, v: Record<string, unknown>) => onChange(items.map((it, j) => (j === i ? v : it)));
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
  const summarise = (it: Record<string, unknown>): string => {
    const readable = ["text", "textarea", "richtext", "select", "url"];
    for (const f of fields) {
      if (!readable.includes(f.type)) continue;
      const v = it[f.name];
      if (typeof v === "string" && v.trim()) return v.replace(/<[^>]+>/g, " ").trim().slice(0, 80);
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

// A `select` field. Static `options` render as-is; when `optionsFrom` is set, the options are
// fetched once from that query handler (returns `{ value, label }[]`) — e.g. a live list of
// campaigns — so the editor never has to hardcode or copy identifiers by hand.
function SelectField({ def, value, onChange, api, ariaLabel }: { def: FieldDefinition; value: string | null; onChange: (v: unknown) => void; api: Api; ariaLabel?: string }) {
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
