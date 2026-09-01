const tails = new Map<string, Promise<void>>();

export interface DefinitionMutationCoordinator {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export function createDefinitionMutationCoordinator(): DefinitionMutationCoordinator {
  return {
    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const predecessor = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = predecessor.then(() => current);
      tails.set(key, tail);

      await predecessor;
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

export const definitionMutationCoordinator =
  createDefinitionMutationCoordinator();
