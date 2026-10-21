import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/clock";
import { DeliveryOutcomeUnknown } from "./messaging";
import { DevelopmentOutbox, MockMailer, MockSmsSender } from "./mock";

const clock = () => new ManualClock(new Date("2026-10-20T12:00:00.000Z"));

describe("mock messaging adapters", () => {
  it("deduplicates by provider idempotency key and logs only the message id", async () => {
    const log = vi.fn<(fields: { messageId: string }, message: string) => void>();
    const outbox = new DevelopmentOutbox(clock(), log);
    const mailer = new MockMailer(outbox);
    const message = {
      to: "person@example.invalid",
      subject: "Synthetic invitation",
      text: "secret text",
      idempotencyKey: "activation-code-id",
    };
    expect(await mailer.send(message)).toEqual({ status: "sent", messageId: "mock-message-1" });
    expect(await mailer.send(message)).toEqual({ status: "sent", messageId: "mock-message-1" });
    expect(outbox.list()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith({ messageId: "mock-message-1" }, "mock message accepted");
    expect(JSON.stringify(log.mock.calls)).not.toContain(message.to);
    expect(JSON.stringify(log.mock.calls)).not.toContain(message.text);
  });

  it("models definitive failure and accepted-but-unknown outcomes", async () => {
    const outbox = new DevelopmentOutbox(clock());
    const sms = new MockSmsSender(outbox);
    outbox.mode = "failed";
    await expect(
      sms.send({ to: "+4915100000000", text: "code", idempotencyKey: "failed" }),
    ).resolves.toMatchObject({ status: "failed" });
    outbox.mode = "unknown";
    await expect(
      sms.send({ to: "+4915100000001", text: "code", idempotencyKey: "unknown" }),
    ).rejects.toBeInstanceOf(DeliveryOutcomeUnknown);
    expect(outbox.list().map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "failed",
      "unknown",
    ]);
  });

  it("keeps only the latest one hundred messages", async () => {
    const outbox = new DevelopmentOutbox(clock());
    const sms = new MockSmsSender(outbox);
    for (let i = 0; i < 101; i++) {
      await sms.send({ to: "+4915100000000", text: "synthetic", idempotencyKey: `key-${i}` });
    }
    expect(outbox.list()).toHaveLength(100);
    expect(outbox.list()[0]?.idempotencyKey).toBe("key-1");
  });
});
