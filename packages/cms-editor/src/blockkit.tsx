// Block Kit — rendering a custom admin page the server described as JSON (GitHub #33).
//
// The loop is one round trip per interaction: the editor sends `page_load`, the server
// answers with blocks, the host renders them, a click or a submit goes back, new blocks come
// out. No project JavaScript ever runs here — a block is DATA, and every string in it goes
// through React, so there is no markup path to sanitize on this side. The one attribute that
// is not text (`image.url`) is allow-listed server-side on the way out.
//
// This is the generalization of what `FieldForm` already was. `FieldDefinition[]` is
// "server-described form, host-rendered"; a Block Kit page is the same idea with layout and
// display blocks alongside the inputs, so a project gets a whole SCREEN inside the admin
// chrome instead of a link that opens a second app in a new tab.
//
// The WHOLE page comes back on every interaction. There is no patch protocol on purpose: a
// server that returned only what changed would have to agree with the host about what is
// currently on screen, and the two drift the first time a render depends on data that moved.

import { Button, Heading } from "@podoba/react";
import { useCallback, useEffect, useState } from "react";
import type { Api } from "./api";
import { CONTROL } from "./fields";
import type { AdminBlock, AdminElement, AdminInput, AdminPageResponse, JsonValue } from "./types";

const WRAP = "mx-auto max-w-[1200px] px-7 pb-8 pt-2";

/** Values held for the inputs of one block, keyed by `action_id`. */
type BlockValues = Record<string, JsonValue>;

/** What an interaction hands back to the page: which control fired, and with what. */
interface Fired {
  type: "block_action" | "form_submit";
  action_id: string;
  block_id?: string;
  value?: JsonValue;
  values?: BlockValues;
}

export function AdminPageView({ api, slug, label, onError }: { api: Api; slug: string; label: string; onError: (s: string) => void }) {
  const [res, setRes] = useState<AdminPageResponse | null>(null);
  /**
   * Every input on the page, keyed by `action_id`, held HERE rather than per block.
   *
   * A block's inputs used to be local to it, so an interaction carried only the pressed
   * block's own values — and the shipped `lecture-desk` example is built the way any such
   * page is: a search box in one `actions` block, per-row buttons in another. Pressing a
   * row button sent `values: {}`, the page recomputed its filter as empty, and the table
   * came back UNFILTERED while the search box still showed the term. The three row buttons
   * then addressed three different records than the ones on screen when the user confirmed
   * a destructive action.
   *
   * `action_id` is unique per page by contract (it is what `render` switches on), so one
   * map is the shape the server already assumes. Re-seeded from every response, because the
   * server re-renders the whole page and its `initial_value`s are the authority.
   */
  const [values, setValues] = useState<BlockValues>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<AdminPageResponse["toast"] | null>(null);

  const send = useCallback(
    async (fired?: Fired) => {
      setBusy(true);
      setFailed(false);
      try {
        const next = await api.adminPageInteract({ page: slug, type: fired?.type ?? "page_load", ...(fired ?? {}) });
        setRes(next);
        setValues(seedValues(next.blocks));
        setToast(next.toast ?? null);
      } catch (e) {
        // A failed LOAD leaves nothing to render, so it says so here. A failed action leaves
        // the previous page on screen, which is the right place to be — the banner names
        // what went wrong and nothing was lost.
        setFailed(true);
        onError(String((e as Error).message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [api, slug, onError],
  );

  useEffect(() => { void send(); }, [send]);

  // Toasts are transient by definition. Cleared on a timer rather than on the next
  // interaction so a page that ends in a save does not leave "Saved" sitting there until
  // someone clicks something else.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <div className={WRAP}>
      <div className="mb-6 mt-6 flex items-center gap-3">
        <h1 className="m-0 text-[32px] font-normal leading-[1.1] tracking-[-0.01em] text-fg">{label}</h1>
        {busy ? <span className="text-caption text-fg-subtle">working…</span> : null}
      </div>
      {toast ? (
        <div className={`mb-4 rounded-lg border px-3.5 py-2.5 text-small ${toast.tone === "error" ? "border-danger bg-surface-card text-danger" : toast.tone === "success" ? "border-brand-green bg-brand-green/20 text-fg" : "border-border bg-surface-card text-fg-muted"}`}>
          {toast.text}
        </div>
      ) : null}
      {res === null ? (
        <p className="text-fg-subtle">{failed ? "This screen could not be loaded." : "Loading…"}</p>
      ) : (
        <BlockList
          blocks={res.blocks}
          values={values}
          setValue={(id, v) => setValues((s) => ({ ...s, [id]: v }))}
          disabled={busy}
          // The WHOLE page's inputs ride on every interaction, which is what makes a filter
          // in one block reach a button in another.
          onFire={(f) => void send({ ...f, values })}
        />
      )}
    </div>
  );
}

interface ValueBag {
  values: BlockValues;
  setValue: (actionId: string, v: JsonValue) => void;
}

export function BlockList({ blocks, values, setValue, disabled, onFire }: { blocks: AdminBlock[]; disabled: boolean; onFire: (f: Fired) => void } & ValueBag) {
  return (
    <div className="flex flex-col gap-4">
      {/* Keyed by the block's OWN identity where it has one, not by index. `FormBlock`'s
          comment claims a `block_id` key is what re-seeds its inputs from the server's
          fresh `initial_value`s — and it was right about the requirement and wrong about
          the code, because this line keyed on `i`. A wizard whose step 2 put a different
          form at the same index kept step 1's `values`: every field rendered empty while
          `missing` blocked submit forever, and a typed `secret_input` survived into a later
          interaction. Blocks without an id keep the index; they hold no state. */}
      {blocks.map((block, i) => <BlockView key={blockKey(block, i)} block={block} values={values} setValue={setValue} disabled={disabled} onFire={onFire} />)}
    </div>
  );
}

/** A stable React key for a block. `form` carries a required `block_id`; `actions` may.
 * Prefixed so a block_id can never collide with a bare index from a sibling. */
function blockKey(block: AdminBlock, i: number): string {
  const id = block.type === "form" ? block.block_id : block.type === "actions" ? block.block_id : undefined;
  return id ? `id:${id}` : `${block.type}:${i}`;
}

function BlockView({ block, values, setValue, disabled, onFire }: { block: AdminBlock; disabled: boolean; onFire: (f: Fired) => void } & ValueBag) {
  switch (block.type) {
    case "header":
      return <Heading level={block.level === 3 ? "3" : block.level === 2 ? "2" : "1"} className="font-normal">{block.text}</Heading>;
    case "section":
      // `whitespace-pre-wrap` so a page can lay out a paragraph with line breaks without
      // needing markup — which is the thing this format deliberately does not have.
      return <p className="max-w-[72ch] whitespace-pre-wrap text-sm text-fg">{block.text}</p>;
    case "context":
      return <p className="max-w-[72ch] text-caption text-fg-subtle">{block.text}</p>;
    case "divider":
      return <hr className="border-t border-border" />;
    case "empty":
      return (
        <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
          <p className="text-sm text-fg-muted">{block.text}</p>
          {block.hint ? <p className="mt-1 text-caption text-fg-subtle">{block.hint}</p> : null}
        </div>
      );
    case "fields":
      return (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          {block.fields.map((f, i) => (
            <div key={i} className="contents">
              <span className="text-fg-subtle">{f.label}</span>
              <span className="text-fg">{f.value}</span>
            </div>
          ))}
        </div>
      );
    case "stats":
      return (
        <div className="flex flex-wrap gap-3">
          {block.stats.map((s, i) => (
            <div key={i} className="min-w-[140px] flex-1 rounded-lg border border-border bg-surface-card p-4">
              <div className="text-caption text-fg-subtle">{s.label}</div>
              <div className="mt-1 text-[24px] leading-none text-fg">{s.value}</div>
              {s.hint ? <div className="mt-1 text-caption text-fg-subtle">{s.hint}</div> : null}
            </div>
          ))}
        </div>
      );
    case "table":
      return <TableBlock block={block} />;
    case "image":
      return (
        <figure className="m-0">
          <img src={block.url} alt={block.alt ?? ""} className="max-w-full rounded-lg" />
          {block.caption ? <figcaption className="mt-1 text-caption text-fg-subtle">{block.caption}</figcaption> : null}
        </figure>
      );
    case "columns":
      return (
        <div className="grid gap-4 max-[820px]:grid-cols-1" style={{ gridTemplateColumns: `repeat(${block.columns.length}, minmax(0, 1fr))` }}>
          {block.columns.map((col, i) => <BlockList key={i} blocks={col} values={values} setValue={setValue} disabled={disabled} onFire={onFire} />)}
        </div>
      );
    case "accordion":
      return (
        <details className="rounded-lg border border-border bg-surface-card px-4 py-3" open={block.open}>
          <summary className="cursor-pointer text-sm font-medium text-fg">{block.title}</summary>
          <div className="mt-3">
            <BlockList blocks={block.blocks} values={values} setValue={setValue} disabled={disabled} onFire={onFire} />
          </div>
        </details>
      );
    case "actions":
      return <ActionsBlock block={block} values={values} setValue={setValue} disabled={disabled} onFire={onFire} />;
    case "form":
      return <FormBlock block={block} values={values} setValue={setValue} disabled={disabled} onFire={onFire} />;
    default:
      // An unknown block type comes from a server newer than this editor. Named rather than
      // skipped: a page whose one meaningful block silently vanished looks like missing data.
      return <p className="text-caption text-fg-subtle">[unsupported block: {(block as { type: string }).type}]</p>;
  }
}

function TableBlock({ block }: { block: Extract<AdminBlock, { type: "table" }> }) {
  if (block.rows.length === 0) return <p className="text-sm text-fg-subtle">{block.empty ?? "Nothing here."}</p>;
  return (
    // Wide tables scroll INSIDE their own container; the page must not scroll sideways.
    <div className="overflow-x-auto rounded-lg border border-border bg-surface-card">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {block.columns.map((c) => (
              <th key={c.key} className="border-b border-border px-3 py-2 text-left font-medium text-fg-subtle">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, i) => (
            <tr key={i}>
              {block.columns.map((c) => (
                <td key={c.key} className="border-b border-border px-3 py-2 text-fg">{cell(row[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function ActionsBlock({ block, values, setValue, disabled, onFire }: { block: Extract<AdminBlock, { type: "actions" }>; disabled: boolean; onFire: (f: Fired) => void } & ValueBag) {
  // Inputs read and write the PAGE's value bag, not a local one — see `AdminPageView`.
  // `onFire` attaches the whole bag, so a filter in this block reaches a button in another.
  return (
    <div className="flex flex-wrap items-end gap-3">
      {block.elements.map((el, i) =>
        el.type === "button" ? (
          <Button
            key={i}
            variant={el.style === "primary" ? "primary" : el.style === "danger" ? "ghost" : "secondary"}
            className={el.style === "danger" ? "text-danger" : undefined}
            isDisabled={disabled}
            onPress={() => {
              if (el.confirm && !confirm(el.confirm)) return;
              onFire({ type: "block_action", action_id: el.action_id, block_id: block.block_id, value: el.value ?? null });
            }}
          >
            {el.label}
          </Button>
        ) : (
          <InputView key={el.action_id} input={el} value={values[el.action_id]} onChange={(v) => setValue(el.action_id, v)} disabled={disabled} />
        ),
      )}
    </div>
  );
}

function FormBlock({ block, values, setValue, disabled, onFire }: { block: Extract<AdminBlock, { type: "form" }>; disabled: boolean; onFire: (f: Fired) => void } & ValueBag) {
  // No local state: the page owns the bag and re-seeds it from every response, so a form
  // cannot keep values the server has since replaced. (The `block_id` key in `BlockList` is
  // still what keeps two forms from sharing a React identity.)
  //
  // A toggle is never "missing" — false is an answer.
  const missing = block.fields.filter((f) => f.type !== "toggle" && f.required && isEmpty(values[f.action_id]));
  return (
    <form
      className="flex max-w-[720px] flex-col gap-3 rounded-lg border border-border bg-surface-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (missing.length > 0 || disabled) return;
        onFire({ type: "form_submit", action_id: block.submit.action_id, block_id: block.block_id });
      }}
    >
      {block.fields.map((f) => (
        <InputView key={f.action_id} input={f} value={values[f.action_id]} onChange={(v) => setValue(f.action_id, v)} disabled={disabled} />
      ))}
      <div className="mt-1">
        <Button type="submit" isDisabled={disabled || missing.length > 0}>{block.submit.label}</Button>
        {missing.length > 0 ? (
          <span className="ml-3 text-caption text-fg-subtle">Fill in: {missing.map((f) => f.label ?? f.action_id).join(", ")}</span>
        ) : null}
      </div>
    </form>
  );
}

const isInput = (el: AdminElement): el is AdminInput => el.type !== "button";

/** Every input on a page, in declaration order, including those nested in `columns` and
 * `accordion`. The page seeds its whole value bag from this on every response. */
function collectInputs(blocks: readonly AdminBlock[], out: AdminInput[] = []): AdminInput[] {
  for (const b of blocks) {
    if (b.type === "form") out.push(...b.fields);
    else if (b.type === "actions") out.push(...b.elements.filter(isInput));
    else if (b.type === "columns") for (const col of b.columns) collectInputs(col, out);
    else if (b.type === "accordion") collectInputs(b.blocks, out);
  }
  return out;
}

/** The page's value bag as a fresh response describes it. */
function seedValues(blocks: readonly AdminBlock[]): BlockValues {
  return initialValues(collectInputs(blocks));
}

function initialValues(inputs: readonly AdminInput[]): BlockValues {
  const out: BlockValues = {};
  for (const f of inputs) {
    // A `secret_input` deliberately has no `initial_value` — a stored secret is never echoed
    // back to the browser, so the field starts empty on every render.
    if (f.type === "toggle") out[f.action_id] = f.initial_value ?? false;
    else if (f.type === "number_input") out[f.action_id] = f.initial_value ?? null;
    else if (f.type === "secret_input") out[f.action_id] = "";
    else out[f.action_id] = f.initial_value ?? "";
  }
  return out;
}

const isEmpty = (v: JsonValue | undefined): boolean => v === undefined || v === null || v === "";

function InputView({ input, value, onChange, disabled }: { input: AdminInput; value: JsonValue | undefined; onChange: (v: JsonValue) => void; disabled: boolean }) {
  const label = input.label ? (
    <span className="text-caption text-fg-subtle">
      {input.label}
      {input.type !== "toggle" && input.required ? <span className="text-danger"> *</span> : null}
    </span>
  ) : null;

  if (input.type === "toggle") {
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="text-sm text-fg">{input.label ?? input.action_id}</span>
      </label>
    );
  }

  return (
    <label className="flex min-w-[180px] flex-col gap-1.5">
      {label}
      {input.type === "select" ? (
        <select className={CONTROL} value={typeof value === "string" ? value : ""} disabled={disabled} aria-label={input.label ?? input.action_id} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {input.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : input.type === "number_input" ? (
        <input
          className={CONTROL}
          type="number"
          min={input.min}
          max={input.max}
          placeholder={input.placeholder}
          disabled={disabled}
          aria-label={input.label ?? input.action_id}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      ) : input.type === "text_input" && input.multiline ? (
        <textarea
          className={`${CONTROL} h-auto min-h-24 py-2.5`}
          placeholder={input.placeholder}
          disabled={disabled}
          aria-label={input.label ?? input.action_id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={CONTROL}
          // `secret_input` is a password field AND is never seeded from the server, so a
          // stored secret cannot be read back out of the admin's DOM.
          type={input.type === "secret_input" ? "password" : "text"}
          autoComplete={input.type === "secret_input" ? "new-password" : undefined}
          placeholder={input.placeholder}
          disabled={disabled}
          aria-label={input.label ?? input.action_id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
