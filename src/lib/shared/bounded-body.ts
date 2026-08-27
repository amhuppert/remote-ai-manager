export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; receivedBytes: number };

/**
 * Reads a request body while enforcing a byte ceiling, cancelling the source
 * stream the moment the ceiling is crossed — an unbounded upload (or one with
 * a lying content-length) never allocates past the cap.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { ok: false, receivedBytes: received };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
