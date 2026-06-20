"use client";

import { useCallback, useEffect } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";
import { ModalShell, ModalTitle } from "@/components/ui/ModalShell";
import {
  HOTKEY_REGISTRY,
  formatHotkeyDisplay,
  getCategoryLabel,
  type HotkeyCategory,
  type HotkeyDefinition,
} from "@/lib/shared/hotkeys";

interface HotkeyHelpModalProps {
  open: boolean;
  onClose: () => void;
}

const CATEGORY_ORDER: HotkeyCategory[] = ["general", "navigation", "diff"];

function groupByCategory(): Record<HotkeyCategory, HotkeyDefinition[]> {
  const groups: Record<HotkeyCategory, HotkeyDefinition[]> = {
    general: [],
    navigation: [],
    diff: [],
  };
  for (const def of Object.values(HOTKEY_REGISTRY)) {
    groups[def.category].push(def);
  }
  return groups;
}

export default function HotkeyHelpModal({
  open,
  onClose,
}: HotkeyHelpModalProps): React.JSX.Element | null {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop propagation so bubble-phase listeners (e.g. react-hotkeys-hook
        // abort handler) don't also fire when closing the modal
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      // Use capture phase so this fires before bubble-phase hotkey listeners
      document.addEventListener("keydown", handleKeyDown, { capture: true });
      return () =>
        document.removeEventListener("keydown", handleKeyDown, {
          capture: true,
        });
    }
  }, [open, handleKeyDown]);

  useOverlayScope(open);

  if (!open) return null;

  const groups = groupByCategory();

  return (
    <ModalShell
      id="hotkey-help-modal"
      overlayProps={{ id: "hotkey-help-overlay" }}
    >
      <ModalTitle>Keyboard Shortcuts</ModalTitle>
      <div className="flex flex-col gap-lg">
        {CATEGORY_ORDER.map((category) => {
          const entries = groups[category];
          if (entries.length === 0) return null;
          return (
            <div key={category} className="flex flex-col gap-sm">
              <h3 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                {getCategoryLabel(category)}
              </h3>
              <dl className="m-0 flex flex-col gap-[2px]">
                {entries.map((def) => (
                  <div
                    key={def.id}
                    className="flex items-center justify-between rounded-sm px-sm py-xs hover:bg-bg-raised"
                  >
                    <dt className="text-[0.82rem] text-text-primary">
                      {def.label}
                    </dt>
                    <dd className="m-0">
                      <kbd className="inline-block min-w-[24px] rounded-sm border border-solid border-border-default bg-bg-raised px-[8px] py-[2px] text-center font-mono text-[0.72rem] leading-[1.6] text-text-secondary">
                        {formatHotkeyDisplay(def.keys)}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
