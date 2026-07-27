"use client";

import { useHotkeySnapshot } from "./HotkeyProvider";
import { formatHotkeyDisplay } from "@/lib/shared/hotkeys";

export interface HotkeyAwaitingHUDPresentationProps {
  readonly prefix?: readonly string[];
  readonly attached?: boolean;
}

export function HotkeyAwaitingHUDPresentation({
  prefix = [],
  attached = true,
}: HotkeyAwaitingHUDPresentationProps): React.JSX.Element {
  const prefixLabel =
    prefix.length > 0 ? ` · ${formatHotkeyDisplay(prefix.join(">"))}` : "";

  return (
    <div
      className={
        attached
          ? "pointer-events-none absolute right-0 bottom-full left-0 z-20 mb-xs flex justify-end"
          : "pointer-events-none flex w-full justify-end"
      }
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex w-full items-center justify-between gap-md rounded-md border border-amber-dim bg-bg-raised px-sm py-xs font-mono text-[0.68rem] tracking-[0.06em] text-amber shadow-lg sm:w-auto"
      >
        <span>APP SHORTCUT{prefixLabel} · awaiting key</span>
        <span className="shrink-0 text-text-tertiary">Esc cancels</span>
      </div>
    </div>
  );
}

export function HotkeyAwaitingHUD({
  promptId,
}: {
  readonly promptId: string;
}): React.JSX.Element | null {
  const snapshot = useHotkeySnapshot();
  if (snapshot.mode !== "one-shot" || snapshot.promptId !== promptId) {
    return null;
  }

  return <HotkeyAwaitingHUDPresentation prefix={snapshot.prefix} />;
}

export function GlobalHotkeyHUD(): React.JSX.Element | null {
  const snapshot = useHotkeySnapshot();
  if (snapshot.mode !== "leader") return null;

  return (
    <div className="pointer-events-none fixed inset-x-md bottom-md z-50 flex justify-center">
      <HotkeyAwaitingHUDPresentation
        attached={false}
        prefix={snapshot.prefix}
      />
    </div>
  );
}
