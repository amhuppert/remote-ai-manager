import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWriteFile,
  atomicWriteJson,
  type AtomicFileHandle,
  type AtomicWriteFileOps,
} from "./atomic-write-json";

describe("atomic-write-json", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cc-atomic-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes JSON pretty-printed with a trailing structure round-trip", async () => {
    const target = path.join(dir, "value.json");
    const value = { a: 1, nested: { b: ["x", "y"] } };

    await atomicWriteJson(target, value);

    const raw = await readFile(target, "utf-8");
    expect(JSON.parse(raw)).toEqual(value);
    // Pretty-printed with 2-space indent (matches the pre-consolidation writers).
    expect(raw).toBe(JSON.stringify(value, null, 2));
  });

  it("creates missing parent directories", async () => {
    const target = path.join(dir, "deep", "nested", "value.json");
    await atomicWriteJson(target, { ok: true });
    expect(existsSync(target)).toBe(true);
  });

  it("overwrites an existing file with the new contents", async () => {
    const target = path.join(dir, "value.json");
    await atomicWriteJson(target, { v: 1 });
    await atomicWriteJson(target, { v: 2 });
    expect(JSON.parse(await readFile(target, "utf-8"))).toEqual({ v: 2 });
  });

  it("leaves no temp file behind after a successful write", async () => {
    const target = path.join(dir, "value.json");
    await atomicWriteJson(target, { ok: true });
    const entries = await readdir(dir);
    expect(entries).toEqual(["value.json"]);
  });

  it("atomicWriteFile writes arbitrary string contents verbatim", async () => {
    const target = path.join(dir, "script.mjs");
    const contents = "#!/usr/bin/env node\nconsole.log('hi');\n";
    await atomicWriteFile(target, contents);
    expect(await readFile(target, "utf-8")).toBe(contents);
  });

  it("removes the temp file and rethrows when the write fails", async () => {
    // A directory path as the target makes the rename fail with a non-empty
    // directory / EISDIR; the temp write happens against `<dir>.tmp.*`, so
    // assert cleanup there.
    const target = path.join(dir, "subdir");
    await atomicWriteJson(path.join(target, "seed.json"), { seed: true });

    await expect(atomicWriteFile(target, "boom")).rejects.toThrow();

    const stranded = (await readdir(dir)).filter((e) =>
      e.startsWith("subdir.tmp."),
    );
    expect(stranded).toEqual([]);
  });

  it("two concurrent same-target writes each use a distinct temp and neither ENOENT-fails", async () => {
    // The finding: a PID+timestamp temp name collides for two writes in one
    // tick, so both truncate the same temp file and one rename ENOENT-fails.
    // With exclusive-create + randomUUID, each write must claim a distinct
    // temp path and complete without error.
    const target = path.join(dir, "hot.json");

    const results = await Promise.allSettled([
      atomicWriteJson(target, { writer: "a" }),
      atomicWriteJson(target, { writer: "b" }),
    ]);

    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    // Only the target survives; no temp detritus, no ENOENT casualty.
    const entries = await readdir(dir);
    expect(entries).toEqual(["hot.json"]);

    // Last rename wins; the visible contents are one of the two writers'.
    const parsed = JSON.parse(await readFile(target, "utf-8")) as {
      writer: string;
    };
    expect(["a", "b"]).toContain(parsed.writer);
  });

  it("each write derives a unique temp path even within a single tick", async () => {
    const target = path.join(dir, "value.json");
    const openedTemps: string[] = [];
    const ops = recordingOps({ onOpenExclusive: (p) => openedTemps.push(p) });

    // Kick off both without awaiting between them so `randomUUID` — not a
    // millisecond clock — is what distinguishes the temp names.
    await Promise.all([
      atomicWriteFile(target, "a", ops),
      atomicWriteFile(target, "b", ops),
    ]);

    expect(openedTemps).toHaveLength(2);
    expect(new Set(openedTemps).size).toBe(2);
    for (const tmp of openedTemps) {
      expect(tmp.startsWith(`${target}.tmp.`)).toBe(true);
    }
  });

  it("invokes fsync(file) then rename then fsync(dir) in order", async () => {
    const target = path.join(dir, "value.json");
    const order: string[] = [];
    const ops = recordingOps({
      onFileSync: () => order.push("file.sync"),
      onRename: () => order.push("rename"),
      onDirSync: () => order.push("dir.sync"),
    });

    await atomicWriteFile(target, "durable", ops);

    expect(order).toEqual(["file.sync", "rename", "dir.sync"]);
  });

  it("fsyncs every newly-created ancestor bottom-up after the rename", async () => {
    const firstCreatedDir = path.join(dir, "new");
    const targetDir = path.join(firstCreatedDir, "nested");
    const target = path.join(targetDir, "value.json");
    const syncedDirs: string[] = [];
    const ops = recordingOps({
      onOpenDir: (openedDir) => syncedDirs.push(openedDir),
    });

    await atomicWriteFile(target, "durable", ops);

    expect(syncedDirs).toEqual([targetDir, firstCreatedDir, dir]);
  });

  it("propagates a genuine fsync failure from a newly-created ancestor", async () => {
    const target = path.join(dir, "new", "nested", "value.json");
    const ops = recordingOps({
      onDirSync: (openedDir) => {
        if (openedDir === dir) {
          throw Object.assign(new Error("ancestor disk I/O error"), {
            code: "EIO",
          });
        }
      },
    });

    await expect(atomicWriteFile(target, "durable", ops)).rejects.toMatchObject(
      {
        code: "EIO",
      },
    );
  });

  it("keeps writing until every byte has reached the temp file", async () => {
    const contents = "abcdef";
    const writtenChunks: Buffer[] = [];
    let writeCalls = 0;
    const partialHandle = {
      async write(value: string | Uint8Array) {
        writeCalls += 1;
        const bytes = Buffer.from(value);
        const chunk = bytes.subarray(0, Math.min(2, bytes.byteLength));
        writtenChunks.push(Buffer.from(chunk));
        return { bytesWritten: chunk.byteLength };
      },
      async sync() {},
      async close() {},
    };
    const dirHandle = {
      async write() {
        return { bytesWritten: 0 };
      },
      async sync() {},
      async close() {},
    };
    const ops = {
      async mkdir() {},
      dirExists() {
        return true;
      },
      async openExclusive() {
        return partialHandle;
      },
      async openDir() {
        return dirHandle;
      },
      async rename() {},
      async unlink() {},
    } satisfies AtomicWriteFileOps;

    await atomicWriteFile("/virtual/value.json", contents, ops);

    expect(Buffer.concat(writtenChunks).toString("utf-8")).toBe(contents);
    expect(writeCalls).toBeGreaterThan(1);
  });

  it("propagates a genuine directory-fsync I/O failure", async () => {
    const target = path.join(dir, "value.json");
    const ops = recordingOps({
      onDirSync: () => {
        throw Object.assign(new Error("disk I/O error"), { code: "EIO" });
      },
    });

    await expect(atomicWriteFile(target, "ok", ops)).rejects.toMatchObject({
      code: "EIO",
    });
    expect(await readFile(target, "utf-8")).toBe("ok");
  });

  it("swallows a directory-fsync rejection (unsupported platform) after a successful rename", async () => {
    const target = path.join(dir, "value.json");
    const ops = recordingOps({
      onDirSync: () => {
        throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      },
    });

    // Rename already landed the file; a rejected dir fsync must not fail the write.
    await expect(atomicWriteFile(target, "ok", ops)).resolves.toBeUndefined();
    expect(await readFile(target, "utf-8")).toBe("ok");
  });
});

interface RecordingHooks {
  onOpenExclusive?: (tmpPath: string) => void;
  onOpenDir?: (dir: string) => void;
  onFileSync?: () => void;
  onRename?: () => void;
  onDirSync?: (dir: string) => void;
}

/**
 * Wraps the real file operations so tests can observe ordering / temp-path
 * selection and inject a directory-fsync failure — without mocking any internal
 * module. Every op still hits the real filesystem, so behavior stays honest:
 * the file must genuinely be created, synced, renamed, and readable afterward.
 */
function recordingOps(hooks: RecordingHooks): AtomicWriteFileOps {
  return {
    async mkdir(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true });
    },
    dirExists(dir: string): boolean {
      return existsSync(dir);
    },
    async openExclusive(tmpPath: string): Promise<AtomicFileHandle> {
      hooks.onOpenExclusive?.(tmpPath);
      const handle = await open(tmpPath, "wx");
      return {
        async write(contents: Uint8Array): Promise<{ bytesWritten: number }> {
          const result = await handle.write(contents);
          return { bytesWritten: result.bytesWritten };
        },
        async sync(): Promise<void> {
          hooks.onFileSync?.();
          await handle.sync();
        },
        close(): Promise<void> {
          return handle.close();
        },
      };
    },
    async openDir(dir: string): Promise<AtomicFileHandle> {
      hooks.onOpenDir?.(dir);
      const handle = await open(dir, "r");
      return {
        write(): Promise<{ bytesWritten: number }> {
          return Promise.resolve({ bytesWritten: 0 });
        },
        async sync(): Promise<void> {
          hooks.onDirSync?.(dir);
          await handle.sync();
        },
        close(): Promise<void> {
          return handle.close();
        },
      };
    },
    async rename(from: string, to: string): Promise<void> {
      hooks.onRename?.();
      await rename(from, to);
    },
    unlink(target: string): Promise<void> {
      return unlink(target);
    },
  };
}
