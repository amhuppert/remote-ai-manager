import type { SSEEvent } from "@/types";
import { createLogger } from "./logging";
import { getGlobalSingleton, setGlobalValue } from "./global-singleton";

/** Function signature for broadcasting SSE events. */
export type BroadcastFn = (event: SSEEvent) => void;

const logger = createLogger("sse");
const encoder = new TextEncoder();

/**
 * Use globalThis to store the client Set so it survives Next.js module
 * re-evaluation (HMR, separate route bundles). Without this, the events
 * route and hooks route can end up with different Set instances, meaning
 * broadcast() writes to an empty Set while clients live in another.
 */
const GLOBAL_KEY = "__cc_sse_clients" as const;
const SEQ_KEY = "__cc_sse_seq" as const;
const BUFFER_KEY = "__cc_sse_buffer" as const;

const DEFAULT_BUFFER_SIZE = 256;

interface BufferedFrame {
  seq: number;
  frame: Uint8Array;
}

interface SeqCounter {
  value: number;
}

function getClients(): Set<ReadableStreamDefaultController> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Set<ReadableStreamDefaultController>(),
  );
}

function getSeqCounter(): SeqCounter {
  return getGlobalSingleton<SeqCounter>(SEQ_KEY, () => ({ value: 0 }));
}

function getBuffer(): BufferedFrame[] {
  return getGlobalSingleton<BufferedFrame[]>(BUFFER_KEY, () => []);
}

function getBufferSize(): number {
  const raw = process.env.CC_SSE_REPLAY_BUFFER_SIZE;
  if (raw === undefined) return DEFAULT_BUFFER_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BUFFER_SIZE;
  return parsed;
}

export function addClient(controller: ReadableStreamDefaultController): void {
  getClients().add(controller);
}

export function removeClient(
  controller: ReadableStreamDefaultController,
): void {
  getClients().delete(controller);
}

export function broadcast(event: SSEEvent): void {
  const counter = getSeqCounter();
  counter.value += 1;
  const seq = counter.value;

  const frame = encoder.encode(
    `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );

  const buffer = getBuffer();
  buffer.push({ seq, frame });
  const maxSize = getBufferSize();
  while (buffer.length > maxSize) {
    buffer.shift();
  }

  const clients = getClients();
  if (clients.size === 0) {
    logger.warn("broadcast.no_clients", { eventType: event.type });
    return;
  }

  for (const controller of clients) {
    try {
      controller.enqueue(frame);
    } catch {
      clients.delete(controller);
    }
  }
}

/**
 * Return buffered frame bytes with seq strictly greater than `lastEventId`,
 * ordered ascending by seq. Returns empty when the requested seq is older
 * than the buffer's oldest entry (i.e. the replay window has a gap, so the
 * client cannot safely treat the result as a complete catch-up) or newer
 * than the latest.
 */
export function replayFramesSince(lastEventId: number): Uint8Array[] {
  const buffer = getBuffer();
  if (buffer.length === 0) return [];

  const oldest = buffer[0]!.seq;
  if (oldest > lastEventId + 1) return [];

  const result: Uint8Array[] = [];
  for (const entry of buffer) {
    if (entry.seq > lastEventId) {
      result.push(entry.frame);
    }
  }
  return result;
}

export function getClientCount(): number {
  return getClients().size;
}

/** Reset state for testing — do not use in production */
export function _resetForTesting(): void {
  getClients().clear();
  setGlobalValue<SeqCounter>(SEQ_KEY, { value: 0 });
  setGlobalValue<BufferedFrame[]>(BUFFER_KEY, []);
}
