// What a list screen knows about its rows, as opposed to the rows themselves.
//
// Every list in the editor used to hold its rows as `useState<T[]>([])` and derive the
// header from `rows.length`. An empty array is three different facts wearing one value: the
// first fetch has not landed, it landed with nothing, or it failed. All three rendered as
// "None yet" / "0 files" / "No users yet", so a slow network looked like an empty library and
// a 500 looked like a fresh install. The one consumer that rebuilds this editor patched
// `mediaReady` and `usersReady` flags into our source to tell them apart, and the same fix had
// already been made (and lost) once before in that repo, which is what fixing it on the wrong
// side of the package boundary buys.
//
// So the state is a phase plus rows, the transitions are a pure reducer (tested in
// `test/cms-editor-list-state.test.ts`), and `usePagedList` is the one place the fetch
// bookkeeping lives for the paged lists: pages, collection rows, media, users and the media
// picker.

import { Button } from "@podoba/react";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { COMMON_COPY } from "./copy";

/**
 * `loading`: the first page of the CURRENT query is in flight, so nothing on screen may
 * claim a count. `ready`: it arrived (possibly empty, which is now a real answer).
 * `failed`: it never arrived; the error is reported elsewhere, the header must not say
 * "None yet" about data it never saw.
 *
 * A failed "Load more" does not demote a ready list: the rows already shown are still true.
 */
export type ListPhase = "loading" | "ready" | "failed";

export interface PagedListState<T> {
  rows: T[];
  phase: ListPhase;
  /** A full page came back, so there is probably more. A short one is definitely the end. */
  hasMore: boolean;
  /** Where the next "Load more" starts: the number of rows fetched for this query so far. */
  offset: number;
  /** Any request (first page, reload or load-more) of the current query is in flight. */
  loading: boolean;
  /** Which query the rows belong to. Bumped by `reset`; a response for an older one is
   * dropped, so a slow answer to a previous filter cannot land on top of the current one. */
  gen: number;
}

export type PagedListAction<T> =
  /** A new query (a different type, filter, search). `keepRows` leaves the old rows on screen
   * until the new ones replace them, which is what a filter bar wants; a screen whose heading
   * has already changed (a different content type) clears them instead. */
  | { type: "reset"; gen: number; keepRows?: boolean }
  | { type: "request"; gen: number }
  | { type: "loaded"; gen: number; offset: number; rows: T[]; pageSize: number }
  | { type: "failed"; gen: number }
  /** A local edit to rows already shown (a saved alt text, a deleted file). */
  | { type: "patch"; update: (rows: T[]) => T[] };

export function initialPagedList<T>(): PagedListState<T> {
  return { rows: [], phase: "loading", hasMore: false, offset: 0, loading: true, gen: 0 };
}

export function pagedListReducer<T>(state: PagedListState<T>, action: PagedListAction<T>): PagedListState<T> {
  switch (action.type) {
    case "reset":
      return {
        rows: action.keepRows ? state.rows : [],
        phase: "loading",
        hasMore: false,
        offset: 0,
        loading: true,
        gen: action.gen,
      };
    case "request":
      if (action.gen !== state.gen) return state;
      return state.loading ? state : { ...state, loading: true };
    case "loaded": {
      if (action.gen !== state.gen) return state;
      const rows = action.offset === 0 ? action.rows : [...state.rows, ...action.rows];
      return {
        ...state,
        rows,
        phase: "ready",
        hasMore: action.rows.length === action.pageSize,
        offset: action.offset + action.rows.length,
        loading: false,
      };
    }
    case "failed":
      if (action.gen !== state.gen) return state;
      // A failed load-more leaves a ready list as it was. A failed FIRST page drops whatever a
      // `keepRows` reset left standing: those rows answer the previous query, and with no
      // answer to this one they would be a count and a grid for a filter nobody has now.
      if (state.phase === "ready") return { ...state, loading: false };
      return { ...state, rows: [], hasMore: false, offset: 0, loading: false, phase: "failed" };
    case "patch":
      return { ...state, rows: action.update(state.rows) };
  }
}

export interface PagedList<T> extends PagedListState<T> {
  /** Fetch the next page of the current query. */
  loadMore: () => void;
  /** Fetch page 0 of the current query again (after an upload, a create), keeping the phase:
   * the header goes on saying "3 files" until "4 files" is known, rather than flashing
   * "Loading…" over a list that is still there. After a failure it is the retry. */
  reload: () => void;
  /** Edit the rows on screen without a round trip. */
  patch: (update: (rows: T[]) => T[]) => void;
}

/**
 * A paged list, fetched through `fetchPage`.
 *
 * `fetchPage` IS the query: memoize it on whatever the query depends on, and a new identity
 * resets the list and fetches page 0. That is the same contract the hand-written lists had
 * through their `load` callbacks, so the call sites read the same; what moves in here is the
 * phase, the stale-response guard and the offset arithmetic, which each copy had its own
 * version of (and the media library had no stale guard at all, on a debounced search box).
 */
export function usePagedList<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  pageSize: number,
  /** Given the failure's message; a screen passes its banner setter straight in. */
  onError: (message: string) => void,
  opts: { keepRowsOnReset?: boolean } = {},
): PagedList<T> {
  const [state, dispatch] = useReducer(pagedListReducer<T>, undefined, initialPagedList<T>);
  // The authoritative generation. The reducer holds a copy for dropping stale responses, but a
  // `load` issued in the same tick as a `reset` cannot read the reducer's new state yet.
  const gen = useRef(0);
  // Read through refs so a parent re-rendering with a fresh `onError` arrow does not count as
  // a new query and refetch.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const offsetRef = useRef(0);
  offsetRef.current = state.offset;
  const keepRows = opts.keepRowsOnReset ?? false;

  const load = useCallback(
    (offset: number) => {
      const g = gen.current;
      dispatch({ type: "request", gen: g });
      fetchPage(offset, pageSize).then(
        (rows) => dispatch({ type: "loaded", gen: g, offset, rows, pageSize }),
        (e) => {
          dispatch({ type: "failed", gen: g });
          // A stale query's failure is not news: the screen has moved on from it.
          if (g === gen.current) onErrorRef.current(e instanceof Error ? e.message : String(e));
        },
      );
    },
    [fetchPage, pageSize],
  );

  useEffect(() => {
    gen.current += 1;
    dispatch({ type: "reset", gen: gen.current, keepRows });
    load(0);
    // `keepRows` is a per-screen constant; only a new query should reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const loadMore = useCallback(() => load(offsetRef.current), [load]);
  const reload = useCallback(() => load(0), [load]);
  const patch = useCallback((update: (rows: T[]) => T[]) => dispatch({ type: "patch", update }), []);
  return { ...state, loadMore, reload, patch };
}

/** How a count is worded on one screen. Supplied per screen because the noun is the screen's
 * ("1 account", "3 files", a collection's own labels) and guessing plurals is how "+ New
 * Articles" happens. */
export interface CountWords {
  /** Said when the answer is zero ("None yet", or "No matches" under a filter). */
  empty: string;
  one: string;
  /** Given the number already formatted, with a trailing "+" when there may be more. */
  many: (n: string) => string;
}

/**
 * The header's summary of a list: a count only once there is one to give.
 *
 * `hasMore` makes "50" into "50+", since a full page is not a total. A single row that may
 * have more behind it is "1+" in the plural rather than "1 file", which would be a claim.
 */
export function listSummary(phase: ListPhase, count: number, words: CountWords, hasMore = false): string {
  if (phase === "loading") return COMMON_COPY.loading;
  if (phase === "failed" && count === 0) return COMMON_COPY.loadFailed;
  if (count === 0) return words.empty;
  if (count === 1 && !hasMore) return words.one;
  return words.many(`${count}${hasMore ? "+" : ""}`);
}

/** The same question for a list held as `T[] | null` (null = not answered yet), which is how
 * the unpaged furniture screens keep theirs. `failed` is separate because they used to turn a
 * failure into `[]`, i.e. into "0 menus". */
export function nullableSummary<T>(rows: readonly T[] | null, failed: boolean, words: CountWords): string {
  return listSummary(rows !== null ? "ready" : failed ? "failed" : "loading", rows?.length ?? 0, words);
}

/** The body line for a list whose first page failed: says so, and offers the retry. Without
 * it the empty-state copy ("No pages yet. Create one.") rendered under the error banner and
 * contradicted it. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-fg-subtle">{COMMON_COPY.loadFailedBody}</p>
      <Button variant="secondary" size="sm" onPress={onRetry}>{COMMON_COPY.retry}</Button>
    </div>
  );
}
