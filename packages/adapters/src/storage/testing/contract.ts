import { describe, expect, it } from "vitest";
import { FileNotFound, type FileStorage } from "../storage";

/** The behaviour every `FileStorage` implementation shares (ADR-0006, contract tests). */
export function fileStorageContract(name: string, create: () => Promise<FileStorage>): void {
  describe(`${name} (FileStorage contract)`, () => {
    const key = "documents/0b5f4b8e-5d8a-4d55-9a57-6f1f0a3c2e11";
    const content = new Uint8Array([0x54, 0x50, 0x44, 0x31, 0x00, 0xff, 0x10]);

    it("returns the exact bytes it stored", async () => {
      const storage = await create();
      await storage.put(key, content);
      expect(await storage.get(key)).toEqual(content);
    });

    it("keeps its own copy of the bytes", async () => {
      const storage = await create();
      const mutable = content.slice();
      await storage.put(key, mutable);
      mutable[0] = 0;
      const read = await storage.get(key);
      read[1] = 0;
      expect(await storage.get(key)).toEqual(content);
    });

    it("replaces an object stored under the same key", async () => {
      const storage = await create();
      await storage.put(key, content);
      await storage.put(key, new Uint8Array([1, 2, 3]));
      expect(await storage.get(key)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("stores an empty object", async () => {
      const storage = await create();
      await storage.put(key, new Uint8Array());
      expect(await storage.get(key)).toEqual(new Uint8Array());
    });

    it("throws FileNotFound for a missing key and after a delete", async () => {
      const storage = await create();
      await expect(storage.get(key)).rejects.toBeInstanceOf(FileNotFound);
      await storage.put(key, content);
      await storage.delete(key);
      await expect(storage.get(key)).rejects.toBeInstanceOf(FileNotFound);
    });

    it("deletes a missing key without an error", async () => {
      const storage = await create();
      await expect(storage.delete(key)).resolves.toBeUndefined();
      await storage.put(key, content);
      await storage.delete(key);
      await expect(storage.delete(key)).resolves.toBeUndefined();
    });

    it.each(["", "../secret", "documents/../../etc", "/absolute", "Documents/A", "a//b", "a/"])(
      "refuses the key %j without repeating it",
      async (bad) => {
        const storage = await create();
        for (const call of [
          () => storage.put(bad, content),
          () => storage.get(bad),
          () => storage.delete(bad),
        ]) {
          const error = await call().then(
            () => null,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toBe("Invalid storage key");
        }
      },
    );
  });
}
