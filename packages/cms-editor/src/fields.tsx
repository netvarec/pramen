// Schema-driven field forms: one input per FieldDefinition type, recursively composed for
// group/repeater. Media fields open a picker (upload + choose from the library).

import { Button, Heading, Input, ModalDialog, ModalOverlay, ModalSurface, Text, Textarea } from "@podoba/react";
import { BlockEditor } from "@podoba/react/editor";
import { useEffect, useState, type ReactNode } from "react";
import type { Api } from "./api";
import type { FieldDefinition, Media } from "./types";

// Tokenized bare control (podoba's filled-field skin) for the native inputs that
// don't map cleanly onto a podoba primitive (number/date/select/file).
const CONTROL = "h-10 w-full rounded-lg border border-border bg-surface-card px-4 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-brand-green";

function FieldShell({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex w-full flex-col gap-2">
      <span className="text-sm font-medium text-fg">{label}</span>
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
 */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` string (local wall clock) → the UTC ISO instant we store. */
function fromLocalInput(local: string): string | null {
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function formatWhen(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
}

/**
 * The three states a `publish` field can be in, as the decision an editor is making:
 * publish it now, publish it at a chosen time, or take it down.
 *
 * A bare datetime-local input made "publish this" mean "work out the current time and
 * type it in", and "unpublish" mean "clear a text box" — neither of which reads as the
 * action it is.
 */
function PublishControl({ value, onChange }: { value: string; onChange: (v: string | null) => void }) {
  const [scheduling, setScheduling] = useState(false);
  const published = Boolean(value);
  const scheduled = published && new Date(value).getTime() > Date.now();

  const status = !published
    ? { text: "Not published", tone: "text-fg-muted" }
    : scheduled
      ? { text: `Scheduled for ${formatWhen(value)}`, tone: "text-accent-strong" }
      : { text: `Published ${formatWhen(value)}`, tone: "text-fg" };

  return (
    <div className="flex flex-col gap-2">
      <span className={`text-sm ${status.tone}`}>{status.text}</span>
      <div className="flex flex-wrap items-center gap-2">
        {published ? null : (
          <Button size="sm" onPress={() => { setScheduling(false); onChange(new Date().toISOString()); }}>
            Publish now
          </Button>
        )}
        <Button variant="secondary" size="sm" onPress={() => setScheduling((s) => !s)}>
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
          // Shown in the editor's own timezone; stored as UTC.
          value={value ? toLocalInput(new Date(value)) : ""}
          autoFocus
          onChange={(e) => onChange(e.target.value ? fromLocalInput(e.target.value) : null)}
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

function FieldInput({ def, value, onChange, api }: { def: FieldDefinition; value: unknown; onChange: (v: unknown) => void; api: Api }) {
  const label: ReactNode = (
    <>
      {def.label ?? def.name} {def.required ? <span className="text-danger">*</span> : null}
    </>
  );
  switch (def.type) {
    case "text":
    case "url":
      return <Input label={label} value={(value as string) ?? ""} onChange={onChange} placeholder={def.type === "url" ? "https://…" : ""} />;
    case "textarea":
      return <Textarea label={label} value={typeof value === "string" ? value : value == null ? "" : JSON.stringify(value)} onChange={onChange} />;
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
          <input className={CONTROL} type="number" value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
        </FieldShell>
      );
    case "date":
    case "datetime":
      return (
        <FieldShell label={label}>
          <input className={CONTROL} type={def.type === "date" ? "date" : "datetime-local"} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
        </FieldShell>
      );
    case "publish":
      return (
        <FieldShell label={label}>
          <PublishControl value={typeof value === "string" ? value : ""} onChange={onChange as (v: string | null) => void} />
        </FieldShell>
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
          <SelectField def={def} value={value as string | null} onChange={onChange} api={api} />
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

function Repeater({ def, value, onChange, api, label }: { def: FieldDefinition; value: Record<string, unknown>[]; onChange: (v: unknown[]) => void; api: Api; label: ReactNode }) {
  const items = Array.isArray(value) ? value : [];
  const upd = (i: number, v: Record<string, unknown>) => onChange(items.map((it, j) => (j === i ? v : it)));
  const add = () => onChange([...items, {}]);
  const del = (i: number) => onChange(items.filter((_, j) => j !== i));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-fg">{label}</span>
      {items.map((it, i) => (
        <div className="rounded-lg border border-border bg-surface-muted p-3.5" key={i}>
          <div className="mb-2 flex justify-end gap-1">
            <Button variant="ghost" size="sm" onPress={() => move(i, -1)}>↑</Button>
            <Button variant="ghost" size="sm" onPress={() => move(i, 1)}>↓</Button>
            <Button variant="ghost" size="sm" className="text-danger" onPress={() => del(i)}>✕</Button>
          </div>
          <FieldForm schema={def.fields ?? []} value={it} onChange={(v) => upd(i, v)} api={api} />
        </div>
      ))}
      <Button variant="secondary" size="sm" className="self-start" onPress={add} isDisabled={def.max != null && items.length >= def.max}>
        + add {def.label ?? def.name}
      </Button>
    </div>
  );
}

// A `select` field. Static `options` render as-is; when `optionsFrom` is set, the options are
// fetched once from that query handler (returns `{ value, label }[]`) — e.g. a live list of
// campaigns — so the editor never has to hardcode or copy identifiers by hand.
function SelectField({ def, value, onChange, api }: { def: FieldDefinition; value: string | null; onChange: (v: unknown) => void; api: Api }) {
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
    <select className={CONTROL} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
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
