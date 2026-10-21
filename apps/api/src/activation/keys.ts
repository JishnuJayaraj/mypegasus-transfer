import { CROCKFORD_ALPHABET } from "@transfer/domain";
import { createHmac, hkdfSync, randomBytes } from "node:crypto";

const derive = (secret: string, context: string) =>
  Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), context, 32));

export const activationCodeKey = (secret: string) => derive(secret, "activation-code:v1");
export const deliveryAddressKey = (secret: string) => derive(secret, "delivery-address:v1");
export const oneTimeCodeKey = (secret: string) => derive(secret, "one-time-code:v1");

/** Twelve independent uniform 5-bit symbols: 60 bits of cryptographic randomness (D12). */
export function generateActivationCode(): string {
  return [...randomBytes(12)].map((byte) => CROCKFORD_ALPHABET[byte & 31]).join("");
}

export const keyedHash = (key: Buffer, value: string): string =>
  createHmac("sha256", key).update(value).digest("hex");
