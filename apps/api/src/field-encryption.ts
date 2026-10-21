import { createHash, hkdfSync } from "node:crypto";

/**
 * The key of the encrypted self-service fields (ADR-0002, encryption): derived (HKDF-SHA256,
 * `field-encryption:v1`) from FIELD_ENCRYPTION_KEY and passed to the database functions as a bind
 * parameter per call, never `set_config`. `keyId` is a fingerprint of it, stored with each row,
 * so a value written under another key is refused rather than misread (rotation is a later
 * migration). Neither is logged or returned.
 */
export type FieldKey = { key: string; keyId: string };

export function fieldEncryptionKey(root: string): FieldKey {
  const key = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "field-encryption:v1", 32));
  return {
    key: key.toString("hex"),
    keyId: createHash("sha256").update("key-id:").update(key).digest("hex").slice(0, 16),
  };
}
