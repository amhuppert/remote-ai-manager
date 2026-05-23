import { createLogger } from "@/lib/logging";

const logger = createLogger("graph-workflow-merge-mutex");

interface MergeMutexKey {
  projectPath: string;
  sessionName: string;
}

export interface PerSessionMergeMutex {
  withMergeMutex<T>(key: MergeMutexKey, fn: () => Promise<T>): Promise<T>;
}

function mutexKey(key: MergeMutexKey): string {
  return `${key.projectPath}::${key.sessionName}`;
}

export function createPerSessionMergeMutex(): PerSessionMergeMutex {
  const tails = new Map<string, Promise<void>>();

  return {
    async withMergeMutex<T>(
      key: MergeMutexKey,
      fn: () => Promise<T>,
    ): Promise<T> {
      const id = mutexKey(key);
      const previous = tails.get(id) ?? Promise.resolve();

      let releaseSlot!: () => void;
      const slot = new Promise<void>((resolve) => {
        releaseSlot = resolve;
      });
      tails.set(id, slot);

      logger.debug("queue", { key: id });

      try {
        await previous;
        logger.debug("acquired", { key: id });
        return await fn();
      } finally {
        if (tails.get(id) === slot) {
          tails.delete(id);
        }
        releaseSlot();
        logger.debug("released", { key: id });
      }
    },
  };
}
