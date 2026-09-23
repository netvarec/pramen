/** The keys `gsAdmin` sets, typed as `@pramen/cms-astro`'s `admin` option types them (mutable
 * arrays, so the spread assigns to it without a cast). */
export interface GsAdminConfig {
  layout: "sidebar" | "topbar";
  hideControls: ("mediaSearch" | "mediaFilters" | "relationSearch")[];
}

/** The shell settings GS's admin runs with. See `config.js`. */
export declare const gsAdmin: GsAdminConfig;
