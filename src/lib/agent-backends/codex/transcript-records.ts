import { createReadStream } from "node:fs";

export const CODEX_TRANSCRIPT_RECORD_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface CodexTranscriptReadOptions {
  maxRecordBytes?: number;
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
  const stream = createReadStream(filePath, {
    highWaterMark: READ_CHUNK_BYTES,
  });
  const chunks: AsyncIterable<unknown> = stream;
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let buffer = Buffer.alloc(0);
  let recordBytes = 0;
  let recordNumber = 1;
  try {
    for await (const chunk of chunks) {
      if (!Buffer.isBuffer(chunk))
        throw new Error("Codex transcript reader received non-byte input");
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
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
    if (recordBytes > 0)
      throw new Error(
        `Truncated Codex transcript record ${recordNumber}: missing LF delimiter`,
      );
  } finally {
    stream.destroy();
  }
}
