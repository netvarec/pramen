// Unit test for the ctx.mail facade + its adapter seam (Cloudflare / KV / memory).

import { describe, expect, test } from "bun:test";
import { Mail, MailgunAdapter, MemoryMailAdapter, KvMailAdapter, createMail } from "../packages/server/src/runtime/mail";
import type { Kv } from "../packages/server/src/runtime/kv";

/** What the Cloudflare Email binding receives from the mail adapter. */
type EmailMessageLike = {
  to?: string | string[];
  from?: { email: string; name?: string };
  subject?: string;
  text?: string;
  html?: string;
};

describe("ctx.mail facade", () => {
  test("resolves the default sender and delegates to the adapter", async () => {
    const adapter = new MemoryMailAdapter();
    const mail = new Mail(adapter, { email: "hi@acme.com", name: "Acme" });
    await mail.send({ to: "a@x.com", subject: "Hi", text: "yo" });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({
      to: "a@x.com",
      from: { email: "hi@acme.com", name: "Acme" },
      subject: "Hi",
      text: "yo",
    });
  });

  test("a per-message `from` overrides the default", async () => {
    const adapter = new MemoryMailAdapter();
    const mail = new Mail(adapter, { email: "default@x.com" });
    await mail.send({ to: "a@x.com", from: { email: "override@x.com" }, subject: "Hi" });
    expect(adapter.sent[0].from).toEqual({ email: "override@x.com" });
  });

  test("throws without a sender, and validates to/subject", async () => {
    await expect(new Mail(new MemoryMailAdapter()).send({ to: "a@x.com", subject: "Hi" })).rejects.toThrow(/sender/);
    const mail = new Mail(new MemoryMailAdapter(), { email: "d@x.com" });
    await expect(mail.send({ to: "", subject: "Hi" })).rejects.toThrow(/to/);
    await expect(mail.send({ to: "a@x.com", subject: "" })).rejects.toThrow(/subject/);
  });

  test("createMail uses Cloudflare Email Sending when EMAIL + MAIL_FROM are present", async () => {
    const sent: EmailMessageLike[] = [];
    const env = {
      EMAIL: { send: async (m: EmailMessageLike) => void sent.push(m) },
      MAIL_FROM: "hi@acme.com",
      MAIL_FROM_NAME: "Acme",
    };
    await createMail(env).send({ to: "a@x.com", subject: "Hi", text: "yo" });
    expect(sent[0]).toMatchObject({ to: "a@x.com", from: { email: "hi@acme.com", name: "Acme" }, subject: "Hi" });
  });

  test("createMail captures to KV only with the explicit MAIL_CAPTURE opt-in", async () => {
    const store = new Map<string, string>();
    const kv = { put: async (k: string, v: string) => void store.set(k, v) } as Kv;
    await createMail({ MAIL_CAPTURE: "true" }, kv).send({ to: ["a@x.com", "b@x.com"], subject: "Hi", text: "yo" });
    expect(JSON.parse(store.get("mail:a@x.com")!)).toMatchObject({ subject: "Hi", text: "yo" });
    expect(store.has("mail:b@x.com")).toBe(true);
  });

  test("createMail FAILS CLOSED when unconfigured (no MAIL_FROM, no MAIL_CAPTURE)", async () => {
    // A misconfigured prod must NOT silently capture security emails into KV.
    const store = new Map<string, string>();
    const kv = { put: async (k: string, v: string) => void store.set(k, v) } as Kv;
    await expect(createMail({}, kv).send({ to: "a@x.com", subject: "Hi", text: "yo" })).rejects.toThrow(/no transport/);
    expect(store.size).toBe(0); // nothing stashed
  });
});

describe("Mailgun transport", () => {
  /** Stand in for `fetch`, recording the one request the adapter makes. */
  function captureFetch(status = 200, body = "{}") {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body, { status });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
  }

  test("posts a form-encoded message to the region's messages endpoint", async () => {
    const f = captureFetch();
    try {
      await new MailgunAdapter("key-123", "mail.acme.com", "https://api.eu.mailgun.net/").send({
        to: ["a@x.com", "b@x.com"],
        from: { email: "hi@acme.com", name: "Acme" },
        subject: "Hi",
        text: "yo",
        replyTo: "reply@acme.com",
      });
    } finally {
      f.restore();
    }
    expect(f.calls).toHaveLength(1);
    // The trailing slash on the base must not become a double slash in the path.
    expect(f.calls[0].url).toBe("https://api.eu.mailgun.net/v3/mail.acme.com/messages");

    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("api:key-123")}`);

    const form = new URLSearchParams(String(f.calls[0].init.body));
    expect(form.get("from")).toBe("Acme <hi@acme.com>");
    // Several recipients are repeated fields, not one joined string.
    expect(form.getAll("to")).toEqual(["a@x.com", "b@x.com"]);
    expect(form.get("subject")).toBe("Hi");
    expect(form.get("text")).toBe("yo");
    expect(form.get("h:Reply-To")).toBe("reply@acme.com");
  });

  test("a rejected send THROWS, carrying Mailgun's reason but never the key", async () => {
    const f = captureFetch(400, '{"message":"to parameter is not a valid address"}');
    try {
      const send = new MailgunAdapter("key-secret", "mail.acme.com").send({
        to: "nope",
        from: { email: "hi@acme.com" },
        subject: "Hi",
      });
      // Throwing is what makes the outbox retry and then dead-letter visibly; a
      // swallowed status would turn a bounced sign-in link into silence.
      await expect(send).rejects.toThrow(/400.*not a valid address/);
      await expect(send).rejects.not.toThrow(/key-secret/);
    } finally {
      f.restore();
    }
  });

  test("createMail prefers Mailgun over the EMAIL binding when both are configured", async () => {
    const f = captureFetch();
    const binding = { send: async () => { throw new Error("the binding must not be used"); } };
    try {
      const mail = createMail({
        EMAIL: binding,
        MAIL_FROM: "hi@acme.com",
        MAIL_FROM_NAME: "Acme",
        MAILGUN_API_KEY: "key-123",
        MAILGUN_DOMAIN: "mail.acme.com",
      } as never);
      await mail.send({ to: "a@x.com", subject: "Hi", text: "yo" });
    } finally {
      f.restore();
    }
    expect(f.calls[0].url).toBe("https://api.mailgun.net/v3/mail.acme.com/messages");
  });

  test("a half-configured Mailgun falls through rather than sending nowhere", async () => {
    // Key but no domain: the binding is still the transport, not a broken Mailgun.
    const sent: unknown[] = [];
    const mail = createMail({
      EMAIL: { send: async (m: unknown) => void sent.push(m) },
      MAIL_FROM: "hi@acme.com",
      MAILGUN_API_KEY: "key-123",
    } as never);
    await mail.send({ to: "a@x.com", subject: "Hi" });
    expect(sent).toHaveLength(1);
  });
});
