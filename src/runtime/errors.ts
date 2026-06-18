// Error model. Anything that is the *client's* fault carries a status + code and
// a message safe to return. Everything else is logged server-side and surfaced as
// a generic 500 — internal messages / stack traces never reach the client.

export class MrakError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "MrakError";
  }
}

export class BadRequest extends MrakError {
  constructor(message: string) {
    super(message, 400, "bad_request");
  }
}

export interface ErrorBody {
  ok: false;
  error: string;
  code: string;
}

function classify(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof MrakError) {
    return { status: err.status, body: { ok: false, error: err.message, code: err.code } };
  }
  console.error("mrak: unhandled error", err);
  return { status: 500, body: { ok: false, error: "internal error", code: "internal" } };
}

export const toResponse = classify;

export function toWsError(id: string, err: unknown): { type: "error"; id: string; error: string; code: string } {
  const { body } = classify(err);
  return { type: "error", id, error: body.error, code: body.code };
}
