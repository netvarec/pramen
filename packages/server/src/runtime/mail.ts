// ctx.mail — transactional-ish email facade, the same shape as ctx.files: an adapter
// seam (CloudflareEmailAdapter / KvMailAdapter / MemoryMailAdapter) behind a thin
// `Mail` facade, chosen from the environment. Handlers send mail without touching the
// `send_email` binding directly:
//
//   await ctx.mail.send({ to: "u@x.com", subject: "Welcome", text: "…" });
//
// On Cloudflare the transport is Cloudflare Email Sending (the `send_email`/`EMAIL`
// binding, no API keys). With no verified sender configured (local/dev), mail is
// captured instead of sent — to KV (so an e2e/dashboard can read the "inbox") or
// in-memory — so handlers work unchanged off-platform.

import type { Kv } from "./kv";

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailMessage {
  to: string | string[];
  /** Sender. Optional — defaults to MAIL_FROM (a verified address). */
  from?: MailAddress;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string | MailAddress;
}

/** The transport seam. One per backend (Cloudflare Email Sending, a dev stash, …). */
export interface MailAdapter {
  /** Deliver a fully-resolved message (`from` already filled by the facade). */
  send(message: MailMessage & { from: MailAddress }): Promise<void>;
}

/** The `ctx.mail` facade: resolves the sender, validates, and delegates to the adapter. */
export class Mail {
  constructor(
    private readonly adapter: MailAdapter,
    private readonly defaultFrom?: MailAddress,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const to = Array.isArray(message.to) ? message.to : [message.to];
    if (to.length === 0 || to.some((a) => typeof a !== "string" || a.length === 0)) {
      throw new Error("ctx.mail.send: `to` is required");
    }
    if (typeof message.subject !== "string" || message.subject.length === 0) {
      throw new Error("ctx.mail.send: `subject` is required");
    }
    const from = message.from ?? this.defaultFrom;
    if (!from) throw new Error("ctx.mail.send: no sender — set the MAIL_FROM var or pass `from`");
    await this.adapter.send({ ...message, from });
  }
}

/** The Cloudflare `send_email` binding shape (workers binding form: `from` uses `email`). */
export interface SendEmailBinding {
  send(message: {
    to: string | string[];
    from: MailAddress;
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string | MailAddress;
  }): Promise<void>;
}

/** Cloudflare Email Sending — sends via the `send_email` binding (no API keys). The
 * `from` domain must be onboarded (`wrangler email sending enable yourdomain.com`). */
export class CloudflareEmailAdapter implements MailAdapter {
  constructor(private readonly binding: SendEmailBinding) {}
  async send(message: MailMessage & { from: MailAddress }): Promise<void> {
    await this.binding.send({
      to: message.to,
      from: message.from,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
    });
  }
}

/** Dev/test transport: stash the message in KV under `mail:<recipient>` so an e2e suite
 * (or a dashboard) can read the "inbox" instead of really sending. */
export class KvMailAdapter implements MailAdapter {
  constructor(private readonly kv: Kv) {}
  async send(message: MailMessage & { from: MailAddress }): Promise<void> {
    const to = Array.isArray(message.to) ? message.to : [message.to];
    const value = JSON.stringify({ from: message.from, subject: message.subject, text: message.text, html: message.html });
    for (const addr of to) await this.kv.put(`mail:${addr}`, value, { expirationTtl: 900 });
  }
}

/** In-memory transport: captures sent messages (pure; for unit tests). */
export class MemoryMailAdapter implements MailAdapter {
  readonly sent: Array<MailMessage & { from: MailAddress }> = [];
  async send(message: MailMessage & { from: MailAddress }): Promise<void> {
    this.sent.push(message);
  }
}

/** Fail-closed transport: no real sender and no explicit dev-capture opt-in, so a
 * `send` THROWS rather than silently capturing. Prevents a misconfigured production
 * (no MAIL_FROM) from writing security emails — magic-link tokens, resets — into KV
 * instead of delivering them. Mirrors how files fail closed without FILES_SECRET. */
export class UnconfiguredMailAdapter implements MailAdapter {
  async send(): Promise<void> {
    throw new Error(
      "ctx.mail: no transport configured — set MAIL_FROM (with the EMAIL binding) to send, " +
        "or MAIL_CAPTURE=true to capture in dev.",
    );
  }
}

/** Build `ctx.mail` from the environment:
 *  - `EMAIL` binding + `MAIL_FROM` → Cloudflare Email Sending (real send).
 *  - else `MAIL_CAPTURE=true` → capture (KV inbox if a Kv is given, else in-memory) with
 *    a synthetic dev sender — an EXPLICIT dev opt-in, never the production default.
 *  - else → fail closed: a `send` throws (so a missing-MAIL_FROM prod doesn't silently
 *    stash security emails in KV). */
export function createMail(env: Readonly<Record<string, unknown>>, kv?: Kv): Mail {
  const binding = env.EMAIL as SendEmailBinding | undefined;
  const fromAddr = typeof env.MAIL_FROM === "string" && env.MAIL_FROM ? env.MAIL_FROM : undefined;
  if (binding && fromAddr) {
    const name = typeof env.MAIL_FROM_NAME === "string" ? env.MAIL_FROM_NAME : undefined;
    return new Mail(new CloudflareEmailAdapter(binding), { email: fromAddr, name });
  }
  if (env.MAIL_CAPTURE === "true") {
    const devFrom: MailAddress = { email: "dev@pramen.local", name: "pramen (dev)" };
    return new Mail(kv ? new KvMailAdapter(kv) : new MemoryMailAdapter(), devFrom);
  }
  // Sentinel `from` so the facade delegates to the adapter, which throws the clear error.
  return new Mail(new UnconfiguredMailAdapter(), { email: "unconfigured@invalid" });
}
