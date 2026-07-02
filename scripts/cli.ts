#!/usr/bin/env bun
// In-repo entry for the pramen CLI (`bun run pramen <command>`). The implementation
// lives in the published package at packages/server/src/cli.ts so consumers get it as
// the `pramen` bin of @pramen/server; this wrapper just runs it against the workspace
// source. Importing the module executes its top-level `main()`.
import "../packages/server/src/cli";
