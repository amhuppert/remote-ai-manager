"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
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

/**
 * Keyboard-shortcuts reference over the Radix-backed `Dialog` primitive
 * (WAI-ARIA Dialog Modal). Radix owns role=dialog, the focus trap + return,
 * Escape dismissal, the inert background, and `useOverlayScope` registration —
 * replacing the previous hand-rolled capture-phase Escape listener (which
 * existed to beat the bubble-phase react-hotkeys-hook handler; Radix's
 * DismissableLayer handles Escape first and stops it).
 *
 * `mobileSheet` restores the ≤768px bottom-sheet docking. `id="hotkey-help-modal"`
 * reattaches the preserved scroll cap (`max-height: 80vh; overflow-y: auto`) from
 * keyboard-shortcuts-modal.css — `max-height`/`overflow` are not expressible as
 * `layoutClassName` utilities, so the id selector is the only hook for them.
 */
export default function HotkeyHelpModal({
  open,
  onClose,
}: HotkeyHelpModalProps): React.JSX.Element {
  const groups = groupByCategory();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent id="hotkey-help-modal" mobileSheet>
        <DialogTitle>Keyboard Shortcuts</DialogTitle>
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
      </DialogContent>
    </Dialog>
  );
}
