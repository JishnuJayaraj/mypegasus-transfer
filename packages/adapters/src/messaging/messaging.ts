export type DeliveryResult =
  | { status: "sent"; messageId: string }
  | { status: "failed"; messageId: string };

export interface Mailer {
  send(message: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }): Promise<DeliveryResult>;
}

export interface SmsSender {
  send(message: { to: string; text: string; idempotencyKey: string }): Promise<DeliveryResult>;
}

export class DeliveryOutcomeUnknown extends Error {
  constructor() {
    super("Delivery outcome unknown");
    this.name = "DeliveryOutcomeUnknown";
  }
}
