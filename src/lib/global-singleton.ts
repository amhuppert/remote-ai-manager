/**
 * HMR-safe globalThis singleton accessor.
 *
 * Centralizes the unsafe `globalThis as unknown as Record<string, unknown>` cast
 * so all consumers get type-safe access to lazily-initialized values that
 * survive Next.js HMR reloads.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as unknown as Record<string, any>;

/** Get-or-create a singleton value on globalThis. */
export function getGlobalSingleton<T>(key: string, factory: () => T): T {
  if (!g[key]) {
    g[key] = factory();
  }
  return g[key] as T;
}

/** Read a globalThis value without lazy initialization (undefined if absent). */
export function getGlobalValue<T>(key: string): T | undefined {
  return g[key] as T | undefined;
}

/** Set a globalThis value directly. */
export function setGlobalValue<T>(key: string, value: T): void {
  g[key] = value;
}

/** Delete a globalThis value. */
export function deleteGlobalValue(key: string): void {
  delete g[key];
}
