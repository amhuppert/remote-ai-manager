import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexTranscriptRecords } from "./transcript-records";

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
