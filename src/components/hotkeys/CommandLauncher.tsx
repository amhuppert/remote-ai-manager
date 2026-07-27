"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/Dialog";
import { FormInput } from "@/components/ui/FormField";
import { HotkeyKeycaps } from "./HotkeyKeycaps";
import { useHotkeyCommands, useHotkeyDispatcher } from "./HotkeyProvider";
import type {
  HotkeyCommandView,
  HotkeyEventContext,
} from "@/lib/hotkeys/dispatcher";
import type { HotkeyId } from "@/lib/shared/hotkeys";
import { cn } from "@/lib/ui/cn";

export interface CommandLauncherProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly commands?: readonly HotkeyCommandView[];
  readonly onRun?: (id: HotkeyId) => void;
  readonly invocationContext?: HotkeyEventContext;
}

export function CommandLauncher({
  open,
  onClose,
  commands,
  onRun,
  invocationContext,
}: CommandLauncherProps): React.JSX.Element {
  const dispatcher = useHotkeyDispatcher();
  const contextualCommands = useHotkeyCommands();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const source = commands ?? contextualCommands;
  const availableCommands = useMemo(
    () =>
      source.filter(
        (command) =>
          command.available && command.definition.id !== "commandLauncher",
      ),
    [source],
  );
  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return availableCommands;
    return availableCommands.filter(({ definition }) =>
      `${definition.label} ${definition.description}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [availableCommands, query]);
  const activeCommand = filteredCommands[activeIndex] ?? filteredCommands[0];
  const activeOptionId = activeCommand
    ? `command-launcher-option-${activeCommand.definition.id}`
    : undefined;

  function close(): void {
    setQuery("");
    setActiveIndex(0);
    onClose();
  }

  function run(id: HotkeyId): void {
    close();
    if (onRun) {
      onRun(id);
      return;
    }
    window.setTimeout(() => dispatcher.invoke(id, invocationContext), 0);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent mobileSheet aria-describedby={undefined}>
        <DialogTitle>Command Launcher</DialogTitle>
        <FormInput
          autoFocus
          role="combobox"
          aria-label="Search commands"
          aria-controls="command-launcher-results"
          aria-activedescendant={activeOptionId}
          aria-expanded="true"
          aria-autocomplete="list"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (filteredCommands.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex(
                (current) => (current + 1) % filteredCommands.length,
              );
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(
                (current) =>
                  (current - 1 + filteredCommands.length) %
                  filteredCommands.length,
              );
              return;
            }
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (activeCommand) run(activeCommand.definition.id);
          }}
        />

        <ul
          id="command-launcher-results"
          role="listbox"
          aria-label="Available commands"
          className="m-0 flex max-h-[min(50vh,28rem)] list-none flex-col gap-[2px] overflow-y-auto p-0"
        >
          {filteredCommands.map((command, index) => (
            <li
              id={`command-launcher-option-${command.definition.id}`}
              key={command.definition.id}
              role="option"
              aria-selected={
                command.definition.id === activeCommand?.definition.id
              }
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => run(command.definition.id)}
              className={cn(
                "grid min-h-[32px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-md rounded-sm px-sm py-sm text-left",
                command.definition.id === activeCommand?.definition.id
                  ? "bg-cyan-glow"
                  : "bg-transparent hover:bg-bg-raised",
              )}
            >
              <span className="min-w-0">
                <span className="block text-[0.82rem] text-text-primary">
                  {command.definition.label}
                </span>
                <span className="block truncate text-[0.7rem] text-text-tertiary">
                  {command.definition.description}
                </span>
              </span>
              <HotkeyKeycaps keys={command.definition.keys} />
            </li>
          ))}
        </ul>

        {filteredCommands.length === 0 ? (
          <p
            role="status"
            aria-live="polite"
            className="m-0 py-lg text-center font-mono text-[0.75rem] text-text-tertiary"
          >
            No matching commands
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
