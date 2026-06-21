// Error model. Anything that is the *client's* fault carries a status + code and
// a message safe to return. Everything else is logged server-side and surfaced as
// a generic 500 — internal messages / stack traces never reach the client.

export class PramenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PramenError";
  }
}

export class BadRequest extends PramenError {
  constructor(message: string) {
    super(message, 400, "bad_request");
  }
}

/** 401 — the caller is unauthenticated (no/invalid identity). */
export class Unauthorized extends PramenError {
  constructor(message = "authentication required") {
    super(message, 401, "unauthorized");
  }
}

/** 403 — authenticated but not permitted. For handler-level checks; the Db
 * chokepoint raises AclDenied for row/field ACL. */
export class Forbidden extends PramenError {
  constructor(message = "forbidden") {
    super(message, 403, "forbidden");
  }
}

export interface ErrorBody {
  ok: false;
  error: string;
  code: string;
}

function classify(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof PramenError) {
    return { status: err.status, body: { ok: false, error: err.message, code: err.code } };
  }
  console.error("pramen: unhandled error", err);
  return { status: 500, body: { ok: false, error: "internal error", code: "internal" } };
}

export const toResponse = classify;

export function toWsError(id: string, err: unknown): { type: "error"; id: string; error: string; code: string } {
  const { body } = classify(err);
  return { type: "error", id, error: body.error, code: body.code };
}
