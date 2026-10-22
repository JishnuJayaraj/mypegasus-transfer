import type { DocumentType } from "@transfer/domain";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSecretKey,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * Every document file is encrypted by the API before it reaches the store (data-protection.md,
 * document files; ADR-0006): AES-256-GCM under a random 256-bit data key per document, which is
 * wrapped (AES-256-GCM) under a key derived (HKDF-SHA256, `document-encryption:v1`) from
 * DOCUMENT_ENCRYPTION_KEY: a root of its own, because the object store and its backups are
 * another trust domain than the database. `keyId` fingerprints the derived key and is stored
 * with each row, so a file written under another key is refused (`key_unknown`) rather than
 * misread; rotation re-wraps the data keys (a later migration). The additional data binds the
 * format version, document id, participation id and type, so an object or wrapped key copied to
 * another row fails. Object: `TPD1 | nonce | ciphertext | tag`; wrapped key: `nonce | key | tag`.
 * Neither key is logged or returned.
 */
export type DocumentKey = { keyId: string; key: KeyObject };

export type DocumentBinding = { documentId: string; participationId: string; type: DocumentType };

/** What is stored: the object in the file store, the key id and wrapped key on the row. */
export type SealedDocument = { object: Uint8Array; keyId: string; wrappedKey: Uint8Array };

export class DocumentCipherError extends Error {
  constructor(readonly code: "key_unknown" | "integrity_failed") {
    super(`Document decryption failed: ${code}`);
    this.name = "DocumentCipherError";
  }
}

const magic = Buffer.from("TPD1", "latin1");
const nonceLength = 12;
const tagLength = 16;
const keyLength = 32;

export function documentEncryptionKey(root: string): DocumentKey {
  const key = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "document-encryption:v1", 32));
  return {
    keyId: createHash("sha256").update("key-id:").update(key).digest("hex").slice(0, 16),
    key: createSecretKey(key),
  };
}

const additionalData = (purpose: "content" | "key", binding: DocumentBinding) =>
  Buffer.from(
    JSON.stringify(["TPD1", purpose, binding.documentId, binding.participationId, binding.type]),
  );

function seal(key: KeyObject | Buffer, aad: Buffer, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: tagLength });
  cipher.setAAD(aad);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: KeyObject | Buffer, aad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < nonceLength + tagLength) throw new DocumentCipherError("integrity_failed");
  const nonce = sealed.subarray(0, nonceLength);
  const tag = sealed.subarray(sealed.length - tagLength);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: tagLength });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const body = sealed.subarray(nonceLength, sealed.length - tagLength);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DocumentCipherError("integrity_failed");
  }
}

export function encryptDocument(
  key: DocumentKey,
  binding: DocumentBinding,
  content: Uint8Array,
): SealedDocument {
  const dataKey = randomBytes(keyLength);
  try {
    const object = Buffer.concat([
      magic,
      seal(dataKey, additionalData("content", binding), content),
    ]);
    const wrappedKey = seal(key.key, additionalData("key", binding), dataKey);
    return {
      object: new Uint8Array(object),
      keyId: key.keyId,
      wrappedKey: new Uint8Array(wrappedKey),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptDocument(
  key: DocumentKey,
  binding: DocumentBinding,
  sealed: SealedDocument,
): Uint8Array {
  if (sealed.keyId !== key.keyId) throw new DocumentCipherError("key_unknown");
  const wrapped = Buffer.from(sealed.wrappedKey);
  if (wrapped.length !== nonceLength + keyLength + tagLength) {
    throw new DocumentCipherError("integrity_failed");
  }
  const object = Buffer.from(sealed.object);
  if (!object.subarray(0, magic.length).equals(magic)) {
    throw new DocumentCipherError("integrity_failed");
  }
  const dataKey = open(key.key, additionalData("key", binding), wrapped);
  try {
    return new Uint8Array(
      open(dataKey, additionalData("content", binding), object.subarray(magic.length)),
    );
  } finally {
    dataKey.fill(0);
  }
}
