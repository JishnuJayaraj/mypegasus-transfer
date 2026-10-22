import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemFileStorage } from "./filesystem";
import { MemoryFileStorage } from "./memory";
import { fileStorageContract } from "./testing/contract";

const directory = () => mkdtemp(join(tmpdir(), "transfer-storage-"));

fileStorageContract("MemoryFileStorage", async () => new MemoryFileStorage());
fileStorageContract(
  "FilesystemFileStorage",
  async () => new FilesystemFileStorage(await directory()),
);

describe("FilesystemFileStorage", () => {
  const key = "documents/0b5f4b8e-5d8a-4d55-9a57-6f1f0a3c2e11";

  it("lays objects out by key, private to the process owner, without temporary files", async () => {
    const root = await directory();
    await new FilesystemFileStorage(root).put(key, new Uint8Array([1]));
    expect(await readdir(join(root, "documents"))).toEqual([key.split("/")[1]]);
    expect((await stat(join(root, key))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "documents"))).mode & 0o777).toBe(0o700);
  });

  it("passes on errors other than a missing file", async () => {
    const root = await directory();
    const storage = new FilesystemFileStorage(root);
    await storage.put(`${key}/child`, new Uint8Array([1]));
    // The key is a directory now: neither a read nor a replacement can succeed.
    await expect(storage.get(key)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(storage.put(key, new Uint8Array([2]))).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readdir(join(root, "documents"))).toEqual([key.split("/")[1]]);
  });
});

describe("MemoryFileStorage", () => {
  it("lists its keys for tests", async () => {
    const storage = new MemoryFileStorage();
    await storage.put("documents/a", new Uint8Array([1]));
    expect(storage.keys()).toEqual(["documents/a"]);
  });
});
