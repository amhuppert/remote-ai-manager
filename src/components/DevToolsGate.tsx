"use client";

import { useEffect } from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import {
  useDevToolsEnabled,
  useToggleDevTools,
  useHydrateDevTools,
} from "@/stores/dev-tools-visibility.store";

/**
 * Hydrates the dev-tools-visibility store from localStorage,
 * registers the Shift+D hotkey, and conditionally renders children
 * (dev tool panels) only when enabled.
 */
export default function DevToolsGate({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element | null {
  const enabled = useDevToolsEnabled();
  const toggle = useToggleDevTools();
  const hydrate = useHydrateDevTools();

  useEffect(hydrate, [hydrate]);
  useAppHotkey("toggleDevTools", toggle);

  if (!enabled) return null;
  return <>{children}</>;
}
