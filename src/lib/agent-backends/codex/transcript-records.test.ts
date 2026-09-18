import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureCodexNativeCursor,
  inspectCodexNativeWindow,
  readCodexTranscriptRecords,
} from "./transcript-records";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function file(bytes: string | Buffer): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cc-codex-transcript-"));
  directories.push(directory);
  const filePath = path.join(directory, "transcript.jsonl");
  await writeFile(filePath, bytes);
  return filePath;
}

async function collect(
  filePath: string,
  maxRecordBytes?: number,
): Promise<unknown[]> {
  const records: unknown[] = [];
  for await (const record of readCodexTranscriptRecords(filePath, {
    maxRecordBytes,
  }))
    records.push(record);
  return records;
}

describe("streaming Codex transcript records", () => {
  it("reads LF records while preserving Unicode separators and multibyte UTF-8 across a chunk boundary", async () => {
    // Prefix places the emoji's four UTF-8 bytes across the 64 KiB read boundary.
    const value = { text: `${"a".repeat(65_526)}🙂\u2028\u2029tail` };
    const final = { type: "codex_instruction_state", hash: "latest" };
    const filePath = await file(
      `${JSON.stringify(value)}\n${JSON.stringify(final)}\n`,
    );
    const records = await collect(filePath);
    expect(records).toHaveLength(2);
    // Compare complete content without a 64 KiB assertion diff on failure.
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(hash(records)).toBe(hash([value, final]));
  });

  it("enforces the cap per record rather than over the file or read chunk", async () => {
    const filePath = await file('"aa"\n"bb"\n"cc"\n');
    expect(await collect(filePath, 4)).toEqual(["aa", "bb", "cc"]);
  });

  it("rejects an oversized unterminated record before parsing it", async () => {
    const filePath = await file(Buffer.alloc(65_537, 0x61));
    await expect(collect(filePath, 65_536)).rejects.toThrow(
      /record.*65536.*byte/i,
    );
  });

  it("yields earlier records before discovering a later malformed record", async () => {
    const filePath = await file('{"first":true}\nmalformed-secret-payload\n');
    const records = readCodexTranscriptRecords(filePath);
    await expect(records.next()).resolves.toEqual({
      value: { first: true },
      done: false,
    });
    await expect(records.next()).rejects.toThrow(/malformed.*record 2/i);
  });

  it("rejects a final record missing its LF even when its JSON is complete", async () => {
    const filePath = await file('{"first":true}\n{"partial":false}');
    await expect(collect(filePath)).rejects.toThrow(/truncated.*record 2/i);
  });

  it("rejects invalid UTF-8 instead of replacing bytes in the stored record", async () => {
    const filePath = await file(
      Buffer.concat([
        Buffer.from('{"text":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    );
    await expect(collect(filePath)).rejects.toThrow(/utf-8.*record 1/i);
  });

  it("surfaces read errors instead of returning an empty history", async () => {
    const filePath = await file("");
    await expect(collect(`${filePath}.missing`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects empty malformed records but accepts an empty transcript", async () => {
    expect(await collect(await file(""))).toEqual([]);
    await expect(collect(await file("\n"))).rejects.toThrow(
      /malformed.*record 1/i,
    );
  });
});

const native = (type: string, turnId?: string) =>
  JSON.stringify({
    type: "event_msg",
    payload: { type, ...(turnId ? { turn_id: turnId } : {}) },
  }) + "\n";

describe("Codex native attempt interval", () => {
  it.each([
    "function_call",
    "custom_tool_call",
    "web_search_call",
    "computer_call",
    "local_shell_call",
    "tool_search_call",
    "image_generation_call",
  ])("detects silent native %s activity", async (type) => {
    const target = await file("");
    const cursor = await captureCodexNativeCursor(target);
    await appendFile(
      target,
      native("task_started", "capture") +
        JSON.stringify({ type: "response_item", payload: { type } }) +
        "\n" +
        native("task_complete", "capture"),
    );
    expect(await inspectCodexNativeWindow(cursor, "capture")).toEqual({
      coverage: "complete",
      observedToolActivity: true,
    });
  });

  it("starts at the aligned byte cursor and detects silent calls only within the matching window", async () => {
    const target = await file("old invalid history\n");
    const cursor = await captureCodexNativeCursor(target);
    expect(cursor.offset).toBe(Buffer.byteLength("old invalid history\n"));
    await appendFile(
      target,
      native("task_started", "other") +
        JSON.stringify({
          type: "response_item",
          payload: { type: "custom_tool_call" },
        }) +
        "\n" +
        native("task_complete", "other") +
        native("task_started", "capture") +
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "capture", cwd: "/scratch" },
        }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", text: "🙂\u2028\u2029" },
        }) +
        "\n" +
        native("task_complete", "capture"),
    );
    expect(await inspectCodexNativeWindow(cursor, "capture")).toEqual({
      coverage: "complete",
      observedToolActivity: false,
    });
    expect(await inspectCodexNativeWindow(cursor, "other")).toEqual({
      coverage: "complete",
      observedToolActivity: true,
    });
    expect((await inspectCodexNativeWindow(cursor, "missing")).coverage).toBe(
      "incomplete",
    );
  });
  it("does not inspect unrelated records after the attempt terminal", async () => {
    const target = await file("");
    const cursor = await captureCodexNativeCursor(target);
    await appendFile(
      target,
      native("task_started", "capture") +
        native("task_complete", "capture") +
        "unrelated partial history",
    );
    expect(await inspectCodexNativeWindow(cursor, "capture")).toEqual({
      coverage: "complete",
      observedToolActivity: false,
    });
  });
  it("refuses an unaligned starting cursor", async () => {
    await expect(
      captureCodexNativeCursor(await file('{"partial":true}')),
    ).rejects.toThrow(/LF/);
  });
  it.each(["malformed\n", '{"partial":true}', native("task_started", "wrong")])(
    "omits incomplete records %s",
    async (suffix) => {
      const target = await file("");
      const cursor = await captureCodexNativeCursor(target);
      await appendFile(target, native("task_started", "capture") + suffix);
      expect((await inspectCodexNativeWindow(cursor, "capture")).coverage).toBe(
        "incomplete",
      );
    },
  );
  it("rejects replaced, truncated and unreadable files", async () => {
    const target = await file('"history"\n');
    const cursor = await captureCodexNativeCursor(target);
    await writeFile(target, "");
    expect((await inspectCodexNativeWindow(cursor, "capture")).coverage).toBe(
      "incomplete",
    );
    await rename(target, target + ".old");
    expect((await inspectCodexNativeWindow(cursor, "capture")).coverage).toBe(
      "incomplete",
    );
    await writeFile(
      target,
      native("task_started", "capture") + native("task_complete", "capture"),
    );
    expect((await inspectCodexNativeWindow(cursor, "capture")).coverage).toBe(
      "incomplete",
    );
  });
  it("enforces cumulative 8 MiB and 2 second bounds and discloses absent facility", async () => {
    expect((await inspectCodexNativeWindow(null, "capture")).coverage).toBe(
      "unavailable",
    );
    const target = await file("");
    const cursor = await captureCodexNativeCursor(target);
    await appendFile(
      target,
      native("task_started", "capture") +
        '"'.concat("a".repeat(8 * 1024 * 1024), '"\n') +
        native("task_complete", "capture"),
    );
    expect((await inspectCodexNativeWindow(cursor, "capture")).coverage).toBe(
      "incomplete",
    );
    await writeFile(
      target,
      native("task_started", "capture") + native("task_complete", "capture"),
    );
    let time = 0;
    expect(
      (
        await inspectCodexNativeWindow(cursor, "capture", {
          now: () => {
            time += 2001;
            return time;
          },
        })
      ).coverage,
    ).toBe("incomplete");
  });
});

it("bounds inspection even when opening or reading a native file stalls", async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<void>();
  let done = false;
  try {
    const pending = inspectCodexNativeWindow(
      { path: "unused", dev: 1, ino: 1, offset: 0 },
      "turn",
      {
        readRecords: async function* () {
          await held.promise;
          yield {};
        },
      },
    ).then((result) => {
      done = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(2001);
    expect(done).toBe(true);
    expect((await pending).coverage).toBe("incomplete");
  } finally {
    held.resolve();
    vi.useRealTimers();
  }
});
