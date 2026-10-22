import { assertStorageKey, FileNotFound, type FileStorage } from "./storage";

/** Process-local storage for tests; copies on the way in and out. */
export class MemoryFileStorage implements FileStorage {
  readonly #objects = new Map<string, Uint8Array>();

  async put(key: string, content: Uint8Array): Promise<void> {
    assertStorageKey(key);
    this.#objects.set(key, content.slice());
  }

  async get(key: string): Promise<Uint8Array> {
    assertStorageKey(key);
    const content = this.#objects.get(key);
    if (!content) throw new FileNotFound();
    return content.slice();
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    this.#objects.delete(key);
  }

  /** The stored keys (tests). */
  keys(): string[] {
    return [...this.#objects.keys()];
  }
}
