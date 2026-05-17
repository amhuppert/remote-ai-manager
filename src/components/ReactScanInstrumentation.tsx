"use client";

import { useEffect } from "react";
import type { Options } from "react-scan";

type OnRenderCallback = NonNullable<Options["onRender"]>;

interface ReactScanRenderEntry {
  component: string;
  count: number;
  unnecessary: boolean;
  timeMs: number;
  phase: string;
  at: number;
}

declare global {
  interface Window {
    __reactScanReport?: ReactScanRenderEntry[];
    __reactScanReset?: () => void;
  }
}

const PHASE_LABEL: Record<number, string> = {
  1: "mount",
  2: "update",
  4: "unmount",
};

function getComponentName(fiberType: unknown): string {
  if (typeof fiberType === "function") {
    return fiberType.name || "Anonymous";
  }
  if (
    fiberType !== null &&
    typeof fiberType === "object" &&
    "displayName" in fiberType &&
    typeof fiberType.displayName === "string"
  ) {
    return fiberType.displayName;
  }
  if (typeof fiberType === "string") {
    return fiberType;
  }
  return "Unknown";
}

/**
 * Dev-only react-scan instrumentation. Initialises once per page load and
 * pushes each render event to `window.__reactScanReport`. Agents can drive
 * Playwright to call `window.__reactScanReset()` before a flow and read the
 * buffer back via `playwright-cli eval` after. The visual toolbar is left
 * off here — start it on demand with `npx react-scan@latest localhost:3000`
 * in a side process.
 */
export default function ReactScanInstrumentation(): null {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof window === "undefined") return;
    if (window.__reactScanReport !== undefined) return;

    window.__reactScanReport = [];
    window.__reactScanReset = () => {
      window.__reactScanReport = [];
    };

    const onRender: OnRenderCallback = (fiber, renders) => {
      const buffer = window.__reactScanReport;
      if (!buffer) return;
      const name = getComponentName(fiber.type);
      const now = performance.now();
      for (const render of renders) {
        buffer.push({
          component: name,
          count: render.count,
          unnecessary: render.unnecessary ?? false,
          timeMs: render.time ?? 0,
          phase: PHASE_LABEL[render.phase] ?? String(render.phase),
          at: now,
        });
      }
    };

    void import("react-scan").then(({ scan }) => {
      scan({
        enabled: true,
        log: false,
        showToolbar: false,
        showFPS: false,
        showNotificationCount: false,
        trackUnnecessaryRenders: true,
        onRender,
      });
    });
  }, []);

  return null;
}
