import { describe, expect, it } from "vitest";
import {
  decryptDocument,
  DocumentCipherError,
  documentEncryptionKey,
  encryptDocument,
  type DocumentBinding,
  type SealedDocument,
} from "./document-encryption";

const key = documentEncryptionKey("d".repeat(32));
const binding: DocumentBinding = {
  documentId: "0b5f4b8e-5d8a-4d55-9a57-6f1f0a3c2e11",
  participationId: "6a1f3c2e-9b7d-4e5f-8a2b-1c3d4e5f6a7b",
  type: "cv",
};
const content = new Uint8Array(
  Buffer.from("%PDF-1.7\nSynthetic CV of Erika Beispiel, Musterstraße 1\n%%EOF\n", "utf8"),
);

const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof DocumentCipherError ? error.code : error;
  }
  return "decrypted";
};

describe("document encryption (data-protection.md, document files)", () => {
  it("derives its own key and a 64-bit key id, never the field key", () => {
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(documentEncryptionKey("d".repeat(32)).keyId).toBe(key.keyId);
    expect(documentEncryptionKey("e".repeat(32)).keyId).not.toBe(key.keyId);
    // The key material doesn't serialise into a log line.
    expect(JSON.stringify(key)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("round-trips with a fresh data key and nonce per document", () => {
    const sealed = encryptDocument(key, binding, content);
    expect(sealed.keyId).toBe(key.keyId);
    expect(sealed.wrappedKey).toHaveLength(60);
    expect(decryptDocument(key, binding, sealed)).toEqual(content);
    const again = encryptDocument(key, binding, content);
    expect(Buffer.from(again.object).equals(Buffer.from(sealed.object))).toBe(false);
    expect(Buffer.from(again.wrappedKey).equals(Buffer.from(sealed.wrappedKey))).toBe(false);
    expect(decryptDocument(key, binding, encryptDocument(key, binding, new Uint8Array()))).toEqual(
      new Uint8Array(),
    );
  });

  it("lays the object out as TPD1 | nonce | ciphertext | tag, with no plaintext in it", () => {
    const { object } = encryptDocument(key, binding, content);
    const bytes = Buffer.from(object);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("TPD1");
    expect(bytes).toHaveLength(4 + 12 + content.length + 16);
    for (const plain of ["%PDF", "Erika", "Musterstraße", binding.documentId]) {
      expect(bytes.includes(plain)).toBe(false);
    }
  });

  it("fails on a changed byte anywhere in the object or the wrapped key", () => {
    const sealed = encryptDocument(key, binding, content);
    for (const index of [0, 4, 16, 20, sealed.object.length - 1]) {
      const object = sealed.object.slice();
      object[index]! ^= 1;
      expect(failure(() => decryptDocument(key, binding, { ...sealed, object }))).toBe(
        "integrity_failed",
      );
    }
    const wrappedKey = sealed.wrappedKey.slice();
    wrappedKey[20]! ^= 1;
    expect(failure(() => decryptDocument(key, binding, { ...sealed, wrappedKey }))).toBe(
      "integrity_failed",
    );
  });

  it("fails on a truncated object or wrapped key", () => {
    const sealed = encryptDocument(key, binding, content);
    const truncated: SealedDocument[] = [
      { ...sealed, object: sealed.object.subarray(0, 31) },
      { ...sealed, object: new Uint8Array() },
      { ...sealed, wrappedKey: sealed.wrappedKey.subarray(0, 59) },
    ];
    for (const broken of truncated) {
      expect(failure(() => decryptDocument(key, binding, broken))).toBe("integrity_failed");
    }
  });

  it.each([
    ["document id", { documentId: "1b5f4b8e-5d8a-4d55-9a57-6f1f0a3c2e11" }],
    ["participation id", { participationId: "7a1f3c2e-9b7d-4e5f-8a2b-1c3d4e5f6a7b" }],
    ["type", { type: "participant_upload" }],
  ] as const)("fails for another %s: an object copied to another row", (_name, change) => {
    const sealed = encryptDocument(key, binding, content);
    expect(failure(() => decryptDocument(key, { ...binding, ...change }, sealed))).toBe(
      "integrity_failed",
    );
  });

  it("refuses another key as key_unknown, and a forged key id on the tag", () => {
    const sealed = encryptDocument(key, binding, content);
    const other = documentEncryptionKey("e".repeat(32));
    expect(failure(() => decryptDocument(other, binding, sealed))).toBe("key_unknown");
    expect(failure(() => decryptDocument(other, binding, { ...sealed, keyId: other.keyId }))).toBe(
      "integrity_failed",
    );
  });

  it("names the failure, never the document or its content", () => {
    const sealed = encryptDocument(key, binding, content);
    const error = (() => {
      try {
        decryptDocument(key, { ...binding, type: "participant_upload" }, sealed);
      } catch (e) {
        return e as Error;
      }
    })()!;
    expect(error.message).toBe("Document decryption failed: integrity_failed");
    expect(error.message).not.toContain(binding.documentId);
  });
});
