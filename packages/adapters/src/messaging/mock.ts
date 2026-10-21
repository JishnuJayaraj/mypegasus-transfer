import type { Clock } from "../clock/clock";
import {
  DeliveryOutcomeUnknown,
  type DeliveryResult,
  type Mailer,
  type SmsSender,
} from "./messaging";

export type MockDeliveryMode = "sent" | "failed" | "unknown";
export type OutboxMessage =
  | {
      id: string;
      kind: "email";
      to: string;
      subject: string;
      text: string;
      idempotencyKey: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: "sms";
      to: string;
      text: string;
      idempotencyKey: string;
      createdAt: string;
    };

type SafeLog = (fields: { messageId: string }, message: string) => void;

/** Shared process-local development outbox; never used outside the mock adapters. */
export class DevelopmentOutbox {
  readonly #clock: Clock;
  readonly #log: SafeLog;
  readonly #messages: OutboxMessage[] = [];
  readonly #byKey = new Map<string, OutboxMessage>();
  #sequence = 0;
  mode: MockDeliveryMode = "sent";

  constructor(clock: Clock, log: SafeLog = () => undefined) {
    this.#clock = clock;
    this.#log = log;
  }

  list(): readonly OutboxMessage[] {
    return this.#messages.map((message) => ({ ...message }));
  }

  deliver(message: Omit<OutboxMessage, "id" | "createdAt">): DeliveryResult {
    const existing = this.#byKey.get(message.idempotencyKey);
    const stored =
      existing ??
      ({
        ...message,
        id: `mock-message-${++this.#sequence}`,
        createdAt: this.#clock.now().toISOString(),
      } as OutboxMessage);
    if (!existing) {
      this.#byKey.set(stored.idempotencyKey, stored);
      this.#messages.push(stored);
      if (this.#messages.length > 100) {
        const removed = this.#messages.shift()!;
        this.#byKey.delete(removed.idempotencyKey);
      }
      // Deliberately only the opaque id: never destination or message text.
      this.#log({ messageId: stored.id }, "mock message accepted");
    }
    if (this.mode === "unknown") throw new DeliveryOutcomeUnknown();
    return { status: this.mode, messageId: stored.id };
  }
}

export class MockMailer implements Mailer {
  constructor(private readonly outbox: DevelopmentOutbox) {}

  async send(message: Parameters<Mailer["send"]>[0]): Promise<DeliveryResult> {
    return this.outbox.deliver({ kind: "email", ...message });
  }
}

export class MockSmsSender implements SmsSender {
  constructor(private readonly outbox: DevelopmentOutbox) {}

  async send(message: Parameters<SmsSender["send"]>[0]): Promise<DeliveryResult> {
    return this.outbox.deliver({ kind: "sms", ...message });
  }
}
