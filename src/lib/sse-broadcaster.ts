import type { SessionReadyEvent } from "@/types";

const encoder = new TextEncoder();

/**
 * Use globalThis to store the client Set so it survives Next.js module
 * re-evaluation (HMR, separate route bundles). Without this, the events
 * route and hooks route can end up with different Set instances, meaning
 * broadcast() writes to an empty Set while clients live in another.
 */
const GLOBAL_KEY = "__csm_sse_clients" as const;

function getClients(): Set<ReadableStreamDefaultController> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Set<ReadableStreamDefaultController>();
  }
  return g[GLOBAL_KEY] as Set<ReadableStreamDefaultController>;
}

export function addClient(controller: ReadableStreamDefaultController): void {
  getClients().add(controller);
}

export function removeClient(
  controller: ReadableStreamDefaultController,
): void {
  getClients().delete(controller);
}

export function broadcast(event: SessionReadyEvent): void {
  const clients = getClients();
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
  return getClients().size;
}

/** Reset state for testing — do not use in production */
export function _resetForTesting(): void {
  getClients().clear();
}
