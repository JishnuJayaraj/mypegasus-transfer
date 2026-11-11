import { assertStorageKey, FileNotFound, type FileStorage, type StoredObject } from "./storage";

/** Process-local storage for tests; copies on the way in and out. */
export class MemoryFileStorage implements FileStorage {
  readonly #objects = new Map<string, Uint8Array>();
  readonly #modified = new Map<string, Date>();

  /** `now` stamps each write (tests pass a clock's). */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async put(key: string, content: Uint8Array): Promise<void> {
    assertStorageKey(key);
    this.#objects.set(key, content.slice());
    this.#modified.set(key, this.now());
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
    this.#modified.delete(key);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    assertStorageKey(prefix);
    return [...this.#modified]
      .filter(([key]) => key.startsWith(`${prefix}/`))
      .map(([key, modifiedAt]) => ({ key, modifiedAt }))
      .toSorted((a, b) => (a.key < b.key ? -1 : 1));
  }

  /** The stored keys (tests). */
  keys(): string[] {
    return [...this.#objects.keys()];
  }
}
