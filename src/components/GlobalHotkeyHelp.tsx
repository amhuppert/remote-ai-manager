"use client";

import { useCallback, useRef, useState } from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { CommandLauncher } from "@/components/hotkeys/CommandLauncher";
import { GlobalHotkeyHUD } from "@/components/hotkeys/HotkeyAwaitingHUD";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { HotkeyEventContext } from "@/lib/hotkeys/dispatcher";
import HotkeyHelpModal from "./HotkeyHelpModal";

const logger = createClientLogger("global-hotkey-overlays");

interface FocusReturn {
  readonly element: HTMLElement;
  readonly selectionRange: Range | null;
}

export default function GlobalHotkeyHelp(): React.JSX.Element {
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showCommandLauncher, setShowCommandLauncher] = useState(false);
  const [launcherInvocationContext, setLauncherInvocationContext] =
    useState<HotkeyEventContext | null>(null);
  const focusReturnRef = useRef<FocusReturn | null>(null);

  const captureFocus = useCallback(() => {
    if (!(document.activeElement instanceof HTMLElement)) {
      focusReturnRef.current = null;
      return;
    }

    const element = document.activeElement;
    const selection = window.getSelection();
    const selectionRange =
      selection?.rangeCount &&
      element.contains(selection.getRangeAt(0).commonAncestorContainer)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    focusReturnRef.current = { element, selectionRange };
  }, []);

  const restoreFocus = useCallback((overlay: "help" | "launcher") => {
    const focusReturn = focusReturnRef.current;
    focusReturnRef.current = null;

    window.setTimeout(() => {
      if (!focusReturn?.element.isConnected) {
        logger.debug("hotkey.overlay.focus_restore.skipped", {
          overlay,
          reason: "target_unavailable",
        });
        return;
      }

      focusReturn.element.focus({ preventScroll: true });
      const selection = window.getSelection();
      if (selection && focusReturn.selectionRange) {
        selection.removeAllRanges();
        selection.addRange(focusReturn.selectionRange);
      }
      logger.debug("hotkey.overlay.focus_restored", {
        overlay,
        promptId: focusReturn.element.dataset.ccPromptId ?? null,
        selectionRestored: focusReturn.selectionRange !== null,
      });
    }, 0);
  }, []);

  useAppHotkey("helpModal", () => {
    captureFocus();
    setShowHelpModal(true);
  });
  useAppHotkey("commandLauncher", (_event, invocation) => {
    captureFocus();
    setLauncherInvocationContext(invocation.context);
    setShowCommandLauncher(true);
  });

  return (
    <>
      <HotkeyHelpModal
        open={showHelpModal}
        onClose={() => {
          setShowHelpModal(false);
          restoreFocus("help");
        }}
      />
      <CommandLauncher
        open={showCommandLauncher}
        invocationContext={launcherInvocationContext ?? undefined}
        onClose={() => {
          setShowCommandLauncher(false);
          setLauncherInvocationContext(null);
          restoreFocus("launcher");
        }}
      />
      <GlobalHotkeyHUD />
    </>
  );
}
