// Unit test for the ctx.mail facade + its adapter seam (Cloudflare / KV / memory).

import { describe, expect, test } from "bun:test";
import { Mail, MemoryMailAdapter, KvMailAdapter, createMail } from "../packages/server/src/runtime/mail";

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
    const sent: unknown[] = [];
    const env = {
      EMAIL: { send: async (m: unknown) => void sent.push(m) },
      MAIL_FROM: "hi@acme.com",
      MAIL_FROM_NAME: "Acme",
    };
    await createMail(env).send({ to: "a@x.com", subject: "Hi", text: "yo" });
    expect(sent[0]).toMatchObject({ to: "a@x.com", from: { email: "hi@acme.com", name: "Acme" }, subject: "Hi" });
  });

  test("createMail captures to KV only with the explicit MAIL_CAPTURE opt-in", async () => {
    const store = new Map<string, string>();
    const kv = { put: async (k: string, v: string) => void store.set(k, v) } as unknown as ConstructorParameters<
      typeof KvMailAdapter
    >[0];
    await createMail({ MAIL_CAPTURE: "true" }, kv).send({ to: ["a@x.com", "b@x.com"], subject: "Hi", text: "yo" });
    expect(JSON.parse(store.get("mail:a@x.com")!)).toMatchObject({ subject: "Hi", text: "yo" });
    expect(store.has("mail:b@x.com")).toBe(true);
  });

  test("createMail FAILS CLOSED when unconfigured (no MAIL_FROM, no MAIL_CAPTURE)", async () => {
    // A misconfigured prod must NOT silently capture security emails into KV.
    const store = new Map<string, string>();
    const kv = { put: async (k: string, v: string) => void store.set(k, v) } as unknown as ConstructorParameters<
      typeof KvMailAdapter
    >[0];
    await expect(createMail({}, kv).send({ to: "a@x.com", subject: "Hi", text: "yo" })).rejects.toThrow(/no transport/);
    expect(store.size).toBe(0); // nothing stashed
  });
});
