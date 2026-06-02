"use client";

import { useCallback, useEffect } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";
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
    <div className="modal-overlay">
      <div className="modal hotkey-help-modal">
        <h2 className="modal-title">Keyboard Shortcuts</h2>
        <div className="hotkey-help-content">
          {CATEGORY_ORDER.map((category) => {
            const entries = groups[category];
            if (entries.length === 0) return null;
            return (
              <div key={category} className="hotkey-help-group">
                <h3 className="hotkey-help-category">
                  {getCategoryLabel(category)}
                </h3>
                <dl className="hotkey-help-list">
                  {entries.map((def) => (
                    <div key={def.id} className="hotkey-help-item">
                      <dt className="hotkey-help-label">{def.label}</dt>
                      <dd className="hotkey-help-key">
                        <kbd>{formatHotkeyDisplay(def.keys)}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
