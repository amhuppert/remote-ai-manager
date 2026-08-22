import { useCallback, useSyncExternalStore } from "react";

/**
 * Tracks whether a media query currently matches.
 *
 * The viewport is an external store, so it is read through
 * `useSyncExternalStore` rather than mirrored into state by an effect: the
 * match is never a render behind, and there is no cascading render on mount.
 * SSR-safe — the server snapshot is always `false`.
 */
export function useMediaQueryMatch(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
