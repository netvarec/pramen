// @pramen/cms-editor: what a list screen may say about rows it has not seen yet.
//
// Every list used to derive its header from `rows.length` over a `useState([])`, so "the
// first fetch has not landed", "it landed with nothing" and "it failed" all rendered as "None
// yet". A slow network looked like an empty media library, and a 500 looked like a fresh
// install. The consumer that rebuilds this editor patched `mediaReady`/`usersReady` flags into
// our source to tell them apart; these pin the upstream fix, which is a pure reducer plus a
// pure summary, so the contract is testable without a DOM.

import { describe, expect, test } from "bun:test";
import { t } from "../packages/cms-editor/src/i18n";
import {
  initialPagedList,
  listSummary,
  nullableSummary,
  pagedListReducer,
  type CountWords,
  type PagedListAction,
  type PagedListState,
} from "../packages/cms-editor/src/list-state";
import { mediaCountLabel } from "../packages/cms-editor/src/components";

const files: CountWords = { empty: "None yet", forms: { one: "{count} file", other: "{count} files" } };

function run<T>(actions: PagedListAction<T>[], from: PagedListState<T> = initialPagedList<T>()): PagedListState<T> {
  return actions.reduce(pagedListReducer<T>, from);
}

describe("the header's count", () => {
  test("says nothing about a count while the first page is in flight", () => {
    // The bug itself: zero rows before the answer is not "None yet".
    expect(listSummary("loading", 0, files)).toBe(t("common.loading"));
    // Nor is a stale grid kept on screen during a filter change a count for the new filter.
    expect(listSummary("loading", 12, files)).toBe(t("common.loading"));
  });

  test("an answered empty list is empty", () => {
    expect(listSummary("ready", 0, files)).toBe("None yet");
  });

  test("a failed first page is not an empty list", () => {
    expect(listSummary("failed", 0, files)).toBe(t("common.loadFailed"));
    expect(listSummary("failed", 0, files)).not.toBe(files.empty);
  });

  test("counts, and a full page is not a total", () => {
    expect(listSummary("ready", 1, files)).toBe("1 file");
    expect(listSummary("ready", 7, files)).toBe("7 files");
    expect(listSummary("ready", 60, files, true)).toBe("60+ files");
    // One row with more behind it is not "1 file".
    expect(listSummary("ready", 1, files, true)).toBe("1+ files");
  });

  test("the media header keeps its two different zeros", () => {
    expect(mediaCountLabel("loading", 0, false, true)).toBe(t("common.loading"));
    expect(mediaCountLabel("ready", 0, false, false)).toBe("None yet");
    expect(mediaCountLabel("ready", 0, false, true)).toBe("No matches");
    expect(mediaCountLabel("ready", 60, true, false)).toBe("60+ files");
  });

  test("the nullable form: null is loading unless the fetch failed", () => {
    const menus: CountWords = { empty: "0 menus", forms: { one: "{count} menu", other: "{count} menus" } };
    expect(nullableSummary(null, false, menus)).toBe(t("common.loading"));
    expect(nullableSummary(null, true, menus)).toBe(t("common.loadFailed"));
    expect(nullableSummary([], false, menus)).toBe("0 menus");
    expect(nullableSummary([1, 2], false, menus)).toBe("2 menus");
  });
});

describe("the paged list's transitions", () => {
  test("starts loading, with nothing to count", () => {
    const s = initialPagedList<number>();
    expect(s.phase).toBe("loading");
    expect(s.loading).toBe(true);
    expect(s.rows).toEqual([]);
  });

  test("the first page makes it ready, a full page means there may be more", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2, 3], pageSize: 3 },
    ]);
    expect(s.phase).toBe("ready");
    expect(s.rows).toEqual([1, 2, 3]);
    expect(s.hasMore).toBe(true);
    expect(s.offset).toBe(3);
    expect(s.loading).toBe(false);
  });

  test("an empty first page is ready, not loading", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [], pageSize: 50 },
    ]);
    expect(s.phase).toBe("ready");
    expect(s.hasMore).toBe(false);
  });

  test("load more appends, and a short page is the end", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2], pageSize: 2 },
      { type: "request", gen: 1 },
      { type: "loaded", gen: 1, offset: 2, rows: [3], pageSize: 2 },
    ]);
    expect(s.rows).toEqual([1, 2, 3]);
    expect(s.hasMore).toBe(false);
    expect(s.offset).toBe(3);
  });

  test("a reload of page 0 replaces the rows without going back to loading", () => {
    const ready = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2], pageSize: 50 },
    ]);
    const reloading = pagedListReducer(ready, { type: "request", gen: 1 });
    // The header keeps saying "2 files" until "3 files" is known.
    expect(reloading.phase).toBe("ready");
    expect(reloading.loading).toBe(true);
    const s = pagedListReducer(reloading, { type: "loaded", gen: 1, offset: 0, rows: [0, 1, 2], pageSize: 50 });
    expect(s.rows).toEqual([0, 1, 2]);
  });

  test("a failed first page is failed, and drops rows a kept reset left standing", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2], pageSize: 50 },
      { type: "reset", gen: 2, keepRows: true },
    ]);
    // Kept while the new query is in flight, so a filter bar does not blank...
    expect(s.rows).toEqual([1, 2]);
    expect(s.phase).toBe("loading");
    // ...but they answer the OLD query, so a failure does not get to present them.
    const failed = pagedListReducer(s, { type: "failed", gen: 2 });
    expect(failed.phase).toBe("failed");
    expect(failed.rows).toEqual([]);
    expect(failed.loading).toBe(false);
  });

  test("a failed load-more leaves a ready list ready", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2], pageSize: 2 },
      { type: "request", gen: 1 },
      { type: "failed", gen: 1 },
    ]);
    expect(s.phase).toBe("ready");
    expect(s.rows).toEqual([1, 2]);
    expect(s.loading).toBe(false);
  });

  test("a reset without keepRows clears, so the previous type's rows never sit under the new heading", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2], pageSize: 50 },
      { type: "reset", gen: 2 },
    ]);
    expect(s.rows).toEqual([]);
    expect(s.phase).toBe("loading");
  });

  test("a late answer to an older query is dropped", () => {
    // The debounced search: "ab" is asked, then "abc", and "ab" answers last.
    const s = run<string>([
      { type: "reset", gen: 1 },
      { type: "reset", gen: 2 },
      { type: "loaded", gen: 2, offset: 0, rows: ["abc"], pageSize: 50 },
      { type: "loaded", gen: 1, offset: 0, rows: ["ab", "abx"], pageSize: 50 },
      { type: "failed", gen: 1 },
    ]);
    expect(s.rows).toEqual(["abc"]);
    expect(s.phase).toBe("ready");
  });

  test("a local patch edits the rows on screen", () => {
    const s = run<number>([
      { type: "reset", gen: 1 },
      { type: "loaded", gen: 1, offset: 0, rows: [1, 2, 3], pageSize: 50 },
      { type: "patch", update: (rows) => rows.filter((x) => x !== 2) },
    ]);
    expect(s.rows).toEqual([1, 3]);
  });
});
