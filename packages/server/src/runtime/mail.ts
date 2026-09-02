// ctx.mail — transactional-ish email facade, the same shape as ctx.files: an adapter
// seam (CloudflareEmailAdapter / KvMailAdapter / MemoryMailAdapter) behind a thin
// `Mail` facade, chosen from the environment. Handlers send mail without touching the
// `send_email` binding directly:
//
//   await ctx.mail.send({ to: "u@x.com", subject: "Welcome", text: "…" });
//
// Two real transports. Cloudflare Email Sending (the `send_email`/`EMAIL` binding) needs
// no API keys, but it can only send FROM a domain that is a zone in the same account,
// and on some accounts only TO addresses verified in Email Routing — which rules it out
// whenever the recipients are ordinary people. Mailgun is the way out of both: an HTTP
// API, any recipient, at the cost of a key. Configure it and it wins.
//
// With neither configured (local/dev), mail is captured instead of sent — to KV (so an
// e2e/dashboard can read the "inbox") or in-memory — so handlers work unchanged
// off-platform.

import type { Kv } from "./kv";
import type { EnvBag } from "../sdk/handlers";

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

/** Mailgun — an HTTP transport, for when Cloudflare Email Sending cannot be used.
 *
 * Worth the key for one reason: Cloudflare will only send from a domain that is a zone
 * in the same account, and some accounts additionally refuse any recipient that is not a
 * verified destination in Email Routing ("destination address is not a verified
 * address"). That is workable for a handful of operators and hopeless for real users.
 * Mailgun asks the domain be verified once, then delivers to anyone.
 *
 * A non-2xx THROWS, deliberately: `ctx.mail.send` is normally called from a task, and a
 * throw is what makes the outbox retry and then dead-letter visibly. Swallowing the
 * status would turn a bounced sign-in link into silence. The response body rides along
 * in the message because Mailgun's 400s are specific and worth reading ("not a valid
 * address", "domain not found"); the key never does. */
export class MailgunAdapter implements MailAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly domain: string,
    /** `https://api.eu.mailgun.net` for an EU-region account; the two are separate
     * deployments and a key from one 401s against the other. */
    private readonly apiBase: string = "https://api.mailgun.net",
  ) {}

  async send(message: MailMessage & { from: MailAddress }): Promise<void> {
    const body = new URLSearchParams();
    body.set("from", message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email);
    for (const to of Array.isArray(message.to) ? message.to : [message.to]) body.append("to", to);
    body.set("subject", message.subject);
    if (message.text) body.set("text", message.text);
    if (message.html) body.set("html", message.html);
    if (message.replyTo) {
      const r = message.replyTo;
      body.set("h:Reply-To", typeof r === "string" ? r : r.name ? `${r.name} <${r.email}>` : r.email);
    }

    const res = await fetch(`${this.apiBase.replace(/\/+$/, "")}/v3/${encodeURIComponent(this.domain)}/messages`, {
      method: "POST",
      headers: {
        // `api` is the literal username Mailgun expects; the key is the password.
        authorization: `Basic ${btoa(`api:${this.apiKey}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`mailgun: send failed (${res.status})${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    }
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
      "ctx.mail: no transport configured — set MAIL_FROM with either the EMAIL binding " +
        "or MAILGUN_API_KEY + MAILGUN_DOMAIN to send, or MAIL_CAPTURE=true to capture in dev.",
    );
  }
}

/** Build `ctx.mail` from the environment:
 *  - `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` + `MAIL_FROM` → Mailgun (real send).
 *  - else `EMAIL` binding + `MAIL_FROM` → Cloudflare Email Sending (real send).
 *  - else `MAIL_CAPTURE=true` → capture (KV inbox if a Kv is given, else in-memory) with
 *    a synthetic dev sender — an EXPLICIT dev opt-in, never the production default.
 *  - else → fail closed: a `send` throws (so a missing-MAIL_FROM prod doesn't silently
 *    stash security emails in KV).
 *
 * Mailgun outranks the binding on purpose. The binding tends to be present because the
 * infrastructure declares it, whereas an API key is only ever there because somebody put
 * it there — so when both exist, the key is the newer decision. */
export function createMail(env: EnvBag, kv?: Kv): Mail {
  const binding = env.EMAIL as SendEmailBinding | undefined;
  const fromAddr = typeof env.MAIL_FROM === "string" && env.MAIL_FROM ? env.MAIL_FROM : undefined;
  const str = (k: string): string | undefined =>
    typeof env[k] === "string" && (env[k] as string) ? (env[k] as string) : undefined;
  const name = typeof env.MAIL_FROM_NAME === "string" ? env.MAIL_FROM_NAME : undefined;

  const mailgunKey = str("MAILGUN_API_KEY");
  const mailgunDomain = str("MAILGUN_DOMAIN");
  if (mailgunKey && mailgunDomain && fromAddr) {
    return new Mail(new MailgunAdapter(mailgunKey, mailgunDomain, str("MAILGUN_API_BASE")), {
      email: fromAddr,
      name,
    });
  }
  if (binding && fromAddr) {
    return new Mail(new CloudflareEmailAdapter(binding), { email: fromAddr, name });
  }
  if (env.MAIL_CAPTURE === "true") {
    const devFrom: MailAddress = { email: "dev@pramen.local", name: "pramen (dev)" };
    return new Mail(kv ? new KvMailAdapter(kv) : new MemoryMailAdapter(), devFrom);
  }
  // Sentinel `from` so the facade delegates to the adapter, which throws the clear error.
  return new Mail(new UnconfiguredMailAdapter(), { email: "unconfigured@invalid" });
}
