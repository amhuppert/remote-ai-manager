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
 * registers the Shift+D hotkey, and syncs a data attribute on
 * <html> so CSS can show/hide the Next.js dev indicator.
 * TanStack Query DevTools are toggled via the store in Providers.
 */
export default function DevToolsGate(): React.JSX.Element | null {
  const enabled = useDevToolsEnabled();
  const toggle = useToggleDevTools();
  const hydrate = useHydrateDevTools();

  useEffect(hydrate, [hydrate]);
  useAppHotkey("toggleDevTools", toggle);

  useEffect(() => {
    if (enabled) {
      document.documentElement.setAttribute("data-dev-tools-enabled", "");
    } else {
      document.documentElement.removeAttribute("data-dev-tools-enabled");
    }
  }, [enabled]);

  return null;
}
