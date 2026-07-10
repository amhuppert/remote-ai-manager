"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Gates cache- or browser-backed state until after hydration. The server and
 * the client's hydration render both receive `false`; React then re-renders
 * with the live client snapshot without replacing the server tree.
 */
export function useClientStateReady(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
