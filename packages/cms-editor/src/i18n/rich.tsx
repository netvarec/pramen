// Messages with markup in them: `"Create a <dim>new page</dim>"`.
//
// A few titles dim part of themselves, and which part is a matter of the SENTENCE, so it
// cannot be kept in the component: a translation reorders the words and the dimmed phrase
// moves with them. The catalog therefore carries the markup as `<name>…</name>` pairs and the
// call site says what each name renders as. Flat pairs only (no nesting, no attributes), which
// is everything the editor's copy needs, and a parser short enough to read.
//
// Internal, not part of `@pramen/cms-editor/i18n`: it is the one piece that needs React, and
// the public entry stays importable without it.

import { Fragment, type ReactNode } from "react";

const TAG = /<(\w+)>([\s\S]*?)<\/\1>/g;

/** Render `message`, replacing each `<name>…</name>` with `tags[name](…)`. A tag with no
 * renderer is shown as its bare text rather than its markup. */
export function rich(message: string, tags: Readonly<Record<string, (children: string) => ReactNode>>): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of message.matchAll(TAG)) {
    const [whole, name = "", inner = ""] = match;
    const at = match.index ?? 0;
    if (at > last) out.push(message.slice(last, at));
    const render = tags[name];
    out.push(<Fragment key={out.length}>{render ? render(inner) : inner}</Fragment>);
    last = at + whole.length;
  }
  if (last < message.length) out.push(message.slice(last));
  return out.length === 1 ? out[0] : <>{out}</>;
}
