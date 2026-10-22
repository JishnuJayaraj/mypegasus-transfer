import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertStorageKey, FileNotFound, type FileStorage } from "./storage";

/**
 * Storage in a local directory for development and e2e (`STORAGE_DIR`, default
 * `.data/documents`, git-ignored, outside the web root). Directories `0700`, files `0600`; a
 * write goes to a temporary file first and is renamed, so a reader never sees half an object.
 */
export class FilesystemFileStorage implements FileStorage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    assertStorageKey(key);
    return join(this.#root, ...key.split("/"));
  }

  async put(key: string, content: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileNotFound();
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}
