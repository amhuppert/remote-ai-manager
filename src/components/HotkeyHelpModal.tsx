"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import { HotkeyKeycaps } from "@/components/hotkeys/HotkeyKeycaps";
import { useHotkeyCommands } from "@/components/hotkeys/HotkeyProvider";
import {
  getCategoryLabel,
  PROMPT_EDITING_SHORTCUTS,
  type HotkeyCategory,
} from "@/lib/shared/hotkeys";
import type { HotkeyCommandView } from "@/lib/hotkeys/dispatcher";

interface HotkeyHelpModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly commands?: readonly HotkeyCommandView[];
}

const CATEGORY_ORDER: readonly HotkeyCategory[] = [
  "general",
  "navigation",
  "creation",
  "conversation",
  "views",
  "review",
  "diff",
  "development",
];

function groupByCategory(
  commands: readonly HotkeyCommandView[],
): Map<HotkeyCategory, HotkeyCommandView[]> {
  const groups = new Map<HotkeyCategory, HotkeyCommandView[]>();
  for (const command of commands) {
    const entries = groups.get(command.definition.category) ?? [];
    entries.push(command);
    groups.set(command.definition.category, entries);
  }
  return groups;
}

export default function HotkeyHelpModal({
  open,
  onClose,
  commands,
}: HotkeyHelpModalProps): React.JSX.Element {
  const contextualCommands = useHotkeyCommands();
  const [scope, setScope] = useState<"available" | "all">("available");
  const source = commands ?? contextualCommands;
  const visibleCommands =
    scope === "available"
      ? source.filter((command) => command.available)
      : source;
  const groups = groupByCategory(visibleCommands);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent id="hotkey-help-modal" mobileSheet>
        <div className="flex items-center justify-between gap-md">
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <SegmentedControl
            value={scope}
            onValueChange={(value) => {
              if (value === "available" || value === "all") setScope(value);
            }}
            aria-label="Shortcut scope"
          >
            <SegmentedControlItem value="available">
              Available here
            </SegmentedControlItem>
            <SegmentedControlItem value="all">
              All commands
            </SegmentedControlItem>
          </SegmentedControl>
        </div>

        {visibleCommands.length === 0 ? (
          <p className="m-0 rounded-md border border-border-subtle bg-bg-surface p-md font-mono text-[0.75rem] text-text-tertiary">
            No app commands are available in this context.
          </p>
        ) : (
          <div className="flex flex-col gap-lg">
            {CATEGORY_ORDER.map((category) => {
              const entries = groups.get(category);
              if (!entries || entries.length === 0) return null;
              return (
                <section key={category} className="flex flex-col gap-sm">
                  <h3 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                    {getCategoryLabel(category)}
                  </h3>
                  <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
                    {entries.map(({ definition, available }) => (
                      <li
                        key={definition.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-md rounded-sm px-sm py-xs hover:bg-bg-raised"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-sm">
                            <span className="text-[0.82rem] text-text-primary">
                              {definition.label}
                            </span>
                            {!available ? (
                              <span className="font-mono text-[0.62rem] text-text-tertiary">
                                Unavailable here
                              </span>
                            ) : null}
                          </div>
                          <p className="m-0 text-[0.7rem] leading-snug text-text-tertiary">
                            {definition.description}
                          </p>
                        </div>
                        <HotkeyKeycaps keys={definition.keys} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {scope === "all" ? (
              <section className="flex flex-col gap-sm">
                <h3 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                  Prompt editing
                </h3>
                <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
                  {PROMPT_EDITING_SHORTCUTS.map((shortcut) => (
                    <li
                      key={shortcut.keys}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-md rounded-sm px-sm py-xs hover:bg-bg-raised"
                    >
                      <div className="min-w-0">
                        <span className="text-[0.82rem] text-text-primary">
                          {shortcut.label}
                        </span>
                        <p className="m-0 text-[0.7rem] leading-snug text-text-tertiary">
                          {shortcut.description}
                        </p>
                      </div>
                      <HotkeyKeycaps keys={shortcut.keys} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
