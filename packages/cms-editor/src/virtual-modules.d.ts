// The Bun plugin (`@buzola/bun-plugin`) resolves `virtual:buzola/routes` at build time,
// re-exporting from the generated `buzola.gen.ts`. This declaration lets tsc resolve the
// same import against the committed generated file.
declare module "virtual:buzola/routes" {
  export { pageRegistry, routes } from "./buzola.gen";
}
