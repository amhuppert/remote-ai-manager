import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { z } from "zod";

export const CODEX_TRANSCRIPT_RECORD_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface CodexTranscriptReadOptions {
  maxRecordBytes?: number;
  startOffset?: number;
  maxTotalBytes?: number;
  deadline?: number;
  now?: () => number;
  identity?: CodexNativeCursor;
}

/** Reads native transcript envelopes without retaining the conversation history. */
export async function* readCodexTranscriptRecords(
  filePath: string,
  options: CodexTranscriptReadOptions = {},
): AsyncGenerator<unknown> {
  const maxRecordBytes =
    options.maxRecordBytes ?? CODEX_TRANSCRIPT_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new Error(
      "Codex transcript record byte limit must be a positive safe integer",
    );
  }
  const now = options.now ?? Date.now;
  const checkDeadline = () => {
    if (options.deadline !== undefined && now() >= options.deadline)
      throw new Error("Codex transcript inspection deadline exceeded");
  };
  checkDeadline();
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  const initial = await handle.stat();
  const start = options.startOffset ?? 0;
  if (
    !initial.isFile() ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start > initial.size ||
    (options.identity &&
      (initial.dev !== options.identity.dev ||
        initial.ino !== options.identity.ino))
  ) {
    await handle.close();
    throw new Error("Codex transcript identity or offset changed");
  }
  if (start > 0) {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, start - 1);
    if (byte[0] !== 0x0a) {
      await handle.close();
      throw new Error("Codex transcript cursor requires LF boundary");
    }
  }
  const stream = handle.createReadStream({
    start,
    highWaterMark: READ_CHUNK_BYTES,
  });
  const timer =
    options.deadline === undefined
      ? null
      : setTimeout(
          () =>
            stream.destroy(
              new Error("Codex transcript inspection deadline exceeded"),
            ),
          Math.max(0, options.deadline - now()),
        );
  let totalBytes = 0;
  const chunks: AsyncIterable<unknown> = stream;
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let buffer = Buffer.alloc(0);
  let recordBytes = 0;
  let recordNumber = 1;
  try {
    for await (const chunk of chunks) {
      if (!Buffer.isBuffer(chunk))
        throw new Error("Codex transcript reader received non-byte input");
      checkDeadline();
      let offset = 0;
      while (offset < chunk.length) {
        checkDeadline();
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        totalBytes += end - offset + (newline < 0 ? 0 : 1);
        if (totalBytes > (options.maxTotalBytes ?? Infinity))
          throw new Error("Codex transcript cumulative byte limit exceeded");
        const length = recordBytes + end - offset;
        if (length > maxRecordBytes) {
          throw new Error(
            `Codex transcript record ${recordNumber} exceeds its ${maxRecordBytes} byte limit`,
          );
        }
        // Geometric growth bounds metadata and avoids copying a growing record on every read.
        if (length > buffer.length) {
          const grown = Buffer.allocUnsafe(
            Math.min(
              maxRecordBytes,
              Math.max(length, buffer.length * 2, READ_CHUNK_BYTES),
            ),
          );
          buffer.copy(grown, 0, 0, recordBytes);
          buffer = grown;
        }
        chunk.copy(buffer, recordBytes, offset, end);
        recordBytes = length;
        if (newline < 0) break;
        let text: string;
        try {
          text = utf8.decode(buffer.subarray(0, recordBytes));
        } catch {
          throw new Error(
            `Invalid UTF-8 in Codex transcript record ${recordNumber}`,
          );
        }
        let record: unknown;
        try {
          record = JSON.parse(text);
        } catch {
          throw new Error(`Malformed Codex transcript record ${recordNumber}`);
        }
        recordBytes = 0;
        recordNumber += 1;
        offset = newline + 1;
        yield record;
      }
    }
    checkDeadline();
    if (recordBytes > 0)
      throw new Error(
        `Truncated Codex transcript record ${recordNumber}: missing LF delimiter`,
      );
  } finally {
    if (timer !== null) clearTimeout(timer);
    stream.destroy();
    try {
      const final = await stat(filePath);
      if (
        final.dev !== initial.dev ||
        final.ino !== initial.ino ||
        final.size < start + totalBytes
      )
        throw new Error("Codex transcript replaced or truncated");
    } finally {
      await handle.close();
    }
  }
}

export interface CodexNativeCursor {
  path: string;
  dev: number;
  ino: number;
  offset: number;
}
export type CodexNativeWindow = {
  coverage: "complete" | "unavailable" | "incomplete";
  observedToolActivity: boolean;
};
export async function captureCodexNativeCursor(
  path: string,
): Promise<CodexNativeCursor> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Codex native path is not a file");
    if (info.size > 0) {
      const byte = Buffer.alloc(1);
      await handle.read(byte, 0, 1, info.size - 1);
      if (byte[0] !== 0x0a)
        throw new Error("Codex native cursor requires LF boundary");
    }
    return { path, dev: info.dev, ino: info.ino, offset: info.size };
  } finally {
    await handle.close();
  }
}
export async function inspectCodexNativeWindow(
  cursor: CodexNativeCursor | null,
  turnId: string,
  options: {
    maxBytes?: number;
    deadline?: number;
    now?: () => number;
    readRecords?: typeof readCodexTranscriptRecords;
  } = {},
): Promise<CodexNativeWindow> {
  if (!cursor) return { coverage: "unavailable", observedToolActivity: false };
  const now = options.now ?? Date.now;
  const deadline = Math.min(options.deadline ?? Infinity, now() + 2000);
  let active = false;
  let complete = false;
  let observedToolActivity = false;
  const envelope = z.object({
    type: z.string(),
    payload: z.looseObject({
      type: z.string().optional(),
      turn_id: z.string().optional(),
    }),
  });
  const inspect = async (): Promise<CodexNativeWindow> => {
    try {
      for await (const record of (
        options.readRecords ?? readCodexTranscriptRecords
      )(cursor.path, {
        startOffset: cursor.offset,
        identity: cursor,
        maxTotalBytes: Math.min(options.maxBytes ?? Infinity, 8 * 1024 * 1024),
        maxRecordBytes: 8 * 1024 * 1024,
        deadline,
        now,
      })) {
        const parsed = envelope.safeParse(record);
        if (!parsed.success) throw new Error("Malformed native envelope");
        const { type, payload } = parsed.data;
        if ((type === "event_msg" || type === "response_item") && !payload.type)
          throw new Error("Missing native record type");
        if (type === "event_msg" && payload.type === "task_started") {
          if (active) throw new Error("Overlapping native attempt");
          active = payload.turn_id === turnId;
          if (active && complete) throw new Error("Duplicate native attempt");
        } else if (
          type === "event_msg" &&
          ["task_complete", "turn_aborted"].includes(payload.type ?? "")
        ) {
          if (active) {
            if (payload.turn_id !== turnId)
              throw new Error("Mismatched native terminal");
            complete = true;
            active = false;
            break;
          }
        } else if (
          active &&
          (payload.turn_id === undefined || payload.turn_id === turnId)
        ) {
          if (payload.type?.endsWith("_call")) observedToolActivity = true;
        }
      }
      return {
        coverage: complete && !active ? "complete" : "incomplete",
        observedToolActivity,
      };
    } catch {
      return { coverage: "incomplete", observedToolActivity };
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      inspect(),
      new Promise<CodexNativeWindow>((resolve) => {
        timer = setTimeout(
          () => resolve({ coverage: "incomplete", observedToolActivity }),
          Math.max(0, deadline - now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
