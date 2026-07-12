import { createLogger } from "@/lib/logging";

const logger = createLogger("tickets.start");

/**
 * Keyed in-process single-flight for ticket start and delete (single-process
 * runtime). One key per ticket identity serializes the two mutating
 * operations: a start acquires fail-fast (a concurrent start maps to
 * `start_in_progress`), while a delete queues behind whatever holds the key.
 *
 * The lock also answers the attachment-removal deferral questions: while a
 * start holds a ticket's blobs, `isTicketStartActive` is true and
 * `onTicketStartReleased` settles when the hold releases, so deferred blob
 * cleanup runs instead of orphaning.
 */

export function ticketOperationKey(
  projectPath: string,
  number: number,
): string {
  return `${projectPath}::${number}`;
}

export interface TicketStartHold {
  /**
   * Associate the hold with the resolved ticket id (known after the read).
   * At most once per hold — a rebind would strand the first id's waiters.
   */
  bindTicketId(ticketId: string): void;
  release(): void;
}

export interface TicketOperationLock {
  /** Fail-fast start acquisition: null while the key is busy. */
  tryAcquireStart(key: string): TicketStartHold | null;
  /** Queue an operation (delete) behind whatever currently holds the key. */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  isTicketStartActive(ticketId: string): boolean;
  /** Settles once no start holds the ticket (immediately when none does). */
  onTicketStartReleased(ticketId: string): Promise<void>;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function createTicketOperationLock(): TicketOperationLock {
  /** Key → settles when the current holder releases. */
  const busy = new Map<string, Promise<void>>();
  /** Ticket ids bound to in-flight starts, with their release waiters. */
  const activeStartTicketIds = new Map<string, Deferred>();

  function acquire(key: string): () => void {
    const gate = deferred();
    busy.set(key, gate.promise);
    return () => {
      busy.delete(key);
      gate.resolve();
    };
  }

  return {
    tryAcquireStart(key) {
      if (busy.has(key)) {
        return null;
      }
      const releaseKey = acquire(key);
      let boundTicketId: string | null = null;
      let released = false;
      return {
        bindTicketId(ticketId) {
          boundTicketId = ticketId;
          if (!activeStartTicketIds.has(ticketId)) {
            activeStartTicketIds.set(ticketId, deferred());
          }
        },
        release() {
          if (released) return;
          released = true;
          if (boundTicketId !== null) {
            const waiter = activeStartTicketIds.get(boundTicketId);
            activeStartTicketIds.delete(boundTicketId);
            waiter?.resolve();
          }
          releaseKey();
          logger.debug("start.lock_released", { key });
        },
      };
    },

    async runExclusive(key, fn) {
      // Post-await continuations run synchronously up to the next await, so
      // re-checking after each wait makes acquisition race-free.
      for (;;) {
        const current = busy.get(key);
        if (current === undefined) break;
        await current;
      }
      const releaseKey = acquire(key);
      try {
        return await fn();
      } finally {
        releaseKey();
      }
    },

    isTicketStartActive(ticketId) {
      return activeStartTicketIds.has(ticketId);
    },

    onTicketStartReleased(ticketId) {
      const waiter = activeStartTicketIds.get(ticketId);
      return waiter === undefined ? Promise.resolve() : waiter.promise;
    },
  };
}
