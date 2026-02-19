import type { SessionReadyEvent } from "@/types";

const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController>();

export function addClient(controller: ReadableStreamDefaultController): void {
  clients.add(controller);
}

export function removeClient(
  controller: ReadableStreamDefaultController,
): void {
  clients.delete(controller);
}

export function broadcast(event: SessionReadyEvent): void {
  if (clients.size === 0) return;

  const frame = encoder.encode(
    `event: session-ready\ndata: ${JSON.stringify(event)}\n\n`,
  );

  for (const controller of clients) {
    try {
      controller.enqueue(frame);
    } catch {
      clients.delete(controller);
    }
  }
}

export function getClientCount(): number {
  return clients.size;
}

/** Reset state for testing — do not use in production */
export function _resetForTesting(): void {
  clients.clear();
}
