// Schema-driven field forms: one input per FieldDefinition type, recursively composed for
// group/repeater. Media fields open a picker (upload + choose from the library).

import { Button, Input, Textarea } from "@podoba/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
// A dependency-free contentEditable editor. Emits an HTML string, so it round-trips with
// existing rich_text content and every set:html renderer — no value migration, no bundled
// ProseMirror. TipTap is the upgrade path if tables/embeds are ever needed.

const RT_TOOLS: Array<{ label: string; title: string; run: (exec: (c: string, a?: string) => void) => void }> = [
  { label: "B", title: "Bold", run: (x) => x("bold") },
  { label: "I", title: "Italic", run: (x) => x("italic") },
  { label: "H2", title: "Heading", run: (x) => x("formatBlock", "H2") },
  { label: "H3", title: "Subheading", run: (x) => x("formatBlock", "H3") },
  { label: "¶", title: "Paragraph", run: (x) => x("formatBlock", "P") },
  { label: "• List", title: "Bulleted list", run: (x) => x("insertUnorderedList") },
  { label: "1. List", title: "Numbered list", run: (x) => x("insertOrderedList") },
  { label: "Link", title: "Add link", run: (x) => {
    const raw = window.prompt("Link URL (https://, mailto:, /path)", "https://");
    if (!raw) return;
    const url = safeLinkUrl(raw);
    if (!url) { window.alert("Only http(s), mailto, tel, or relative (/, #) links are allowed."); return; }
    x("createLink", url);
  } },
  { label: "Unlink", title: "Remove link", run: (x) => x("unlink") },
  { label: "Clear", title: "Clear formatting", run: (x) => x("removeFormat") },
];

/** Allow-list for a link href: http(s), mailto, tel, or a relative/anchor path.
 * The prefix allow-list inherently rejects `javascript:`/`data:`/`vbscript:` (they
 * don't match), so a bare script URL never reaches execCommand. */
function safeLinkUrl(raw: string): string | null {
  const url = raw.trim();
  return /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(url) ? url : null;
}

/** NOTE: this is cosmetic paste-cleaning, NOT a security boundary. It cannot be relied
 * on for XSS defense — an editor-role caller can POST any `richtext` value straight to
 * the RPC handler, never touching this editor. Stored-XSS is prevented on the SERVER by
 * sanitizeRichText() in @pramen/cms on write (which also covers raw writes / imports).
 * Here we just tidy obviously-unwanted markup so the editor doesn't render junk. */
function scrubHtml(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"');
}

export function RichText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string>("");

  // Sync only EXTERNAL changes (e.g. switching blocks) into the DOM — never on our own
  // keystrokes, or the caret jumps to the start on every character.
  useEffect(() => {
    const el = ref.current;
    if (el && value !== last.current) {
      // Scrub on load too — content may have entered the store via raw writes or imports,
      // not just this editor. contentEditable requires innerHTML; scrubHtml strips
      // scripts / inline handlers / javascript: URLs first.
      el.innerHTML = scrubHtml(value || "");
      last.current = value || "";
    }
  }, [value]);

  const emit = () => {
    const html = scrubHtml(ref.current?.innerHTML ?? "");
    last.current = html;
    onChange(html);
  };
  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };
  // Paste as plain text — avoids importing Word/Docs style-junk into the HTML.
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-card">
      <div className="flex flex-wrap gap-0.5 border-b border-border bg-surface-muted px-2 py-1.5">
        {RT_TOOLS.map((t) => (
          // preventDefault on mousedown keeps the editor's selection while the button is clicked.
          <button key={t.label} type="button" className="rounded border-0 bg-transparent px-2.5 py-0.5 text-xs text-fg-muted hover:bg-surface-card hover:text-fg" title={t.title} onMouseDown={(e) => e.preventDefault()} onClick={() => t.run(exec)}>
            {t.label}
          </button>
        ))}
      </div>
      <div
        ref={ref}
        className="prose prose-sm min-h-[180px] max-w-none px-4 py-3.5 text-sm leading-relaxed text-fg outline-none empty:before:text-fg-subtle empty:before:content-[attr(data-placeholder)]"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write…"
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
      />
    </div>
  );
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,15,5,0.28)] p-6" onClick={onClose}>
      <div className="max-h-[86vh] w-full max-w-[680px] overflow-auto rounded-panel border border-border bg-surface-card px-9 py-8 shadow-[0_24px_60px_rgba(30,20,10,0.12)]" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-[28px] font-normal text-fg">Choose <span className="text-fg-subtle">a file</span> from the library</h2>
        {err ? <div className="my-2 rounded-lg border border-danger bg-surface-card px-3.5 py-2.5 text-[13px] text-danger">{err}</div> : null}
        <label className="mb-4 flex w-full flex-col gap-2">
          <span className="text-sm font-medium text-fg">Upload a new file</span>
          <input type="file" className="text-sm text-fg-muted" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
          {media.map((m) => (
            <div key={m.id} className="cursor-pointer overflow-hidden rounded-lg border border-border bg-surface-card" onClick={() => onPick(m.id)}>
              {(m.file.contentType ?? "").startsWith("image/") ? <img className="block h-[130px] w-full object-cover" src={api.resolve(`/media/${m.file.key}`)} alt="" /> : <div className="h-[130px] bg-surface-muted" />}
              <div className="truncate px-2 py-1.5 text-[11px] text-fg-muted">{m.file.filename ?? m.id}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 text-right">
          <Button variant="ghost" onPress={onClose}>close</Button>
        </div>
      </div>
    </div>
  );
}
