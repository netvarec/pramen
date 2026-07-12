// Schema-driven field forms: one input per FieldDefinition type, recursively composed for
// group/repeater. Media fields open a picker (upload + choose from the library).

import { useEffect, useRef, useState } from "react";
import type { Api } from "./api";
import type { FieldDefinition, Media } from "./types";

export function FieldForm({ schema, value, onChange, api }: { schema: FieldDefinition[]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; api: Api }) {
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });
  return (
    <>
      {schema.map((def) => (
        <FieldInput key={def.name} def={def} value={value[def.name]} onChange={(v) => set(def.name, v)} api={api} />
      ))}
    </>
  );
}

function FieldInput({ def, value, onChange, api }: { def: FieldDefinition; value: unknown; onChange: (v: unknown) => void; api: Api }) {
  const label = (
    <span className="lbl">
      {def.label ?? def.name} {def.required ? <span className="req">*</span> : null}
    </span>
  );
  switch (def.type) {
    case "text":
    case "url":
      return (
        <label className="field">
          {label}
          <input value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={def.type === "url" ? "https://…" : ""} />
        </label>
      );
    case "textarea":
      return (
        <label className="field">
          {label}
          <textarea value={typeof value === "string" ? value : value == null ? "" : JSON.stringify(value)} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    case "richtext":
      // A rich-text value is an HTML string (round-trips with the site's set:html
      // renderers). A legacy object value isn't editable here — fall back to raw text.
      return (
        <div className="field">
          {label}
          <RichText value={typeof value === "string" ? value : ""} onChange={onChange as (v: string) => void} />
        </div>
      );
    case "number":
      return (
        <label className="field">
          {label}
          <input type="number" value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
        </label>
      );
    case "date":
    case "datetime":
      return (
        <label className="field">
          {label}
          <input type={def.type === "date" ? "date" : "datetime-local"} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)} />
        </label>
      );
    case "boolean":
      return (
        <label className="field checkbox">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          <span>{def.label ?? def.name}</span>
        </label>
      );
    case "select":
      return (
        <label className="field">
          {label}
          <select value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">—</option>
            {(def.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      );
    case "media":
      return (
        <label className="field">
          {label}
          <MediaField value={value as string | null} onChange={onChange} api={api} />
        </label>
      );
    case "group":
      return (
        <div className="field">
          {label}
          <div className="group">
            <FieldForm schema={def.fields ?? []} value={(value as Record<string, unknown>) ?? {}} onChange={onChange as (v: Record<string, unknown>) => void} api={api} />
          </div>
        </div>
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
    <div className="rt">
      <div className="rt-toolbar">
        {RT_TOOLS.map((t) => (
          // preventDefault on mousedown keeps the editor's selection while the button is clicked.
          <button key={t.label} type="button" className="sm ghost" title={t.title} onMouseDown={(e) => e.preventDefault()} onClick={() => t.run(exec)}>
            {t.label}
          </button>
        ))}
      </div>
      <div ref={ref} className="rt-editor" contentEditable suppressContentEditableWarning data-placeholder="Write…" onInput={emit} onBlur={emit} onPaste={onPaste} />
    </div>
  );
}

function Repeater({ def, value, onChange, api, label }: { def: FieldDefinition; value: Record<string, unknown>[]; onChange: (v: unknown[]) => void; api: Api; label: React.ReactNode }) {
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
    <div className="field">
      {label}
      {items.map((it, i) => (
        <div className="repeater-item" key={i}>
          <div className="ih">
            <button type="button" className="ghost sm" onClick={() => move(i, -1)}>
              ↑
            </button>
            <button type="button" className="ghost sm" onClick={() => move(i, 1)}>
              ↓
            </button>
            <button type="button" className="ghost sm danger" onClick={() => del(i)}>
              ✕
            </button>
          </div>
          <FieldForm schema={def.fields ?? []} value={it} onChange={(v) => upd(i, v)} api={api} />
        </div>
      ))}
      <button type="button" className="sm" onClick={add} disabled={def.max != null && items.length >= def.max}>
        + add {def.label ?? def.name}
      </button>
    </div>
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
      <div className="row" style={{ cursor: "default" }}>
        {media ? <img src={api.resolve(`/media/${media.file.key}`)} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4 }} /> : <span className="muted">no media</span>}
        <span className="grow muted">{media?.file.filename ?? value ?? ""}</span>
        <button type="button" className="sm" onClick={() => setOpen(true)}>
          pick
        </button>
        {value ? (
          <button type="button" className="sm ghost danger" onClick={() => onChange(null)}>
            clear
          </button>
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
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          Choose <span className="dim">a file</span> from the library
        </h2>
        {err ? <div className="banner err">{err}</div> : null}
        <label className="field">
          <span className="lbl">Upload a new file</span>
          <input type="file" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <div className="media-grid">
          {media.map((m) => (
            <div key={m.id} className="media-cell" onClick={() => onPick(m.id)}>
              {(m.file.contentType ?? "").startsWith("image/") ? <img src={api.resolve(`/media/${m.file.key}`)} alt="" /> : <div style={{ height: 70 }} />}
              <div className="fn">{m.file.filename ?? m.id}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, textAlign: "right" }}>
          <button className="ghost" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}
