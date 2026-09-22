// Words the editor says in more than one place.
//
// Grouped here, as plain literals, so that the i18n pass has ONE table to lift instead of
// hunting the same "Close" through a dozen components (and missing the copy that differs by a
// capital letter). Screen-specific copy stays inline next to the screen that says it: a
// catalogue of every string before there is a catalogue mechanism would just be a second
// place to keep in sync.

export const COMMON_COPY = {
  /** The accessible name of every dialog's ✕. podoba defaults it to "Close" already; passing
   * it explicitly is what makes it translatable, since a default inside the design system is
   * a string no host can reach. */
  close: "Close",
  /** A list's header while its first page is in flight. */
  loading: "Loading…",
  /** A list's header when its first page never arrived. The error itself is in the banner;
   * this only has to stop the header from claiming "None yet" about data it never saw. */
  loadFailed: "Not loaded",
  /** The body line under a list whose first page failed, and the button that asks again. */
  loadFailedBody: "This list could not be loaded.",
  retry: "Try again",
  loadMore: "Load more",
} as const;
