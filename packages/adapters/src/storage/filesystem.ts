import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertStorageKey, FileNotFound, type FileStorage, type StoredObject } from "./storage";

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

  async list(prefix: string): Promise<StoredObject[]> {
    const root = this.#path(prefix);
    const found: StoredObject[] = [];
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const entry of entries) {
      // A write in progress (`<key>.<uuid>.tmp`) is no object yet.
      if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
      const path = join(entry.parentPath, entry.name);
      const key = [prefix, ...path.slice(root.length + 1).split(sep)].join("/");
      found.push({ key, modifiedAt: (await stat(path)).mtime });
    }
    return found.toSorted((a, b) => (a.key < b.key ? -1 : 1));
  }
}
