import { createLogger } from "@/lib/logging";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";

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
  const mutex = createKeyedMutex();

  return {
    withMergeMutex<T>(key: MergeMutexKey, fn: () => Promise<T>): Promise<T> {
      const id = mutexKey(key);
      logger.debug("queue", { key: id });
      return mutex.run(id, async () => {
        logger.debug("acquired", { key: id });
        try {
          return await fn();
        } finally {
          logger.debug("released", { key: id });
        }
      });
    },
  };
}
