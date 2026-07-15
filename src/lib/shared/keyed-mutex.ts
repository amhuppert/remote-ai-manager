/**
 * Keyed serialization mutex: operations sharing the same key run one at a
 * time, in submission order; operations under different keys run
 * concurrently.
 *
 * The mechanism is a per-key promise chain. Each `run(key, fn)` appends `fn`
 * to the key's chain so it starts only after the previously-queued operation
 * for that key has SETTLED (resolved or rejected). A queued operation is never
 * skipped or rejected because its predecessor failed — the chain advances on
 * settlement, not success — so a throwing operation cannot strand the key.
 *
 * The caller observes only its own `fn`'s outcome: `run` resolves with `fn`'s
 * value or rejects with `fn`'s error. Predecessor failures never surface to a
 * successor's caller.
 *
 * The chain entry for a key is deleted once it is the current tail and has
 * settled, so an idle key holds no memory. This is the exact shape that the
 * lane scheduler, the per-session merge mutex, the workflow-envelope store,
 * the workflow task-run dispatcher, and the compaction trigger each
 * hand-rolled before consolidating here.
 *
 * This is an in-memory, single-process primitive: it serializes within one
 * Node process only. Cross-process serialization (e.g. against a file or a
 * shared DB) requires a different mechanism layered on top.
 */

export interface KeyedMutex {
  /**
   * Run `fn` serialized against other calls for the same `key`. Resolves with
   * `fn`'s result (or rejects with its error); a predecessor's failure never
   * affects this call.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** True while any operation for `key` is queued or running. */
  isBusy(key: string): boolean;
  /** Number of keys with an in-flight chain (diagnostics/tests). */
  activeKeyCount(): number;
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<unknown>>();

  function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    // Advance the chain on settlement, not success: a rejected predecessor
    // must still release the key so the next queued operation can start.
    const result = previous.then(
      () => fn(),
      () => fn(),
    );
    // The tail is failure-swallowed so a rejected `result` does not turn into
    // an unhandled rejection when it is only used as a chain link.
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    return result;
  }

  return {
    run,
    isBusy(key) {
      return tails.has(key);
    },
    activeKeyCount() {
      return tails.size;
    },
  };
}
