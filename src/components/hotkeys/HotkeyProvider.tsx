"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname } from "next/navigation";
import {
  createHotkeyDispatcher,
  type HotkeyCommandView,
  type HotkeyDispatcher,
  type HotkeyEventContext,
  type HotkeySnapshot,
} from "@/lib/hotkeys/dispatcher";
import { isOverlayOpen, useIsOverlayOpen } from "@/stores/overlay-scope.store";

const defaultHotkeyDispatcher = createHotkeyDispatcher();
const HotkeyDispatcherContext = createContext<HotkeyDispatcher>(
  defaultHotkeyDispatcher,
);

function elementFromTarget(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = elementFromTarget(target);
  if (!element) return false;
  return (
    element.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ) !== null
  );
}

function promptIdFromTarget(target: EventTarget | null): string | null {
  const element = elementFromTarget(target);
  return (
    element?.closest<HTMLElement>("[data-cc-prompt-id]")?.dataset.ccPromptId ??
    null
  );
}

function eventContext(target: EventTarget | null): HotkeyEventContext {
  return {
    editable: isEditableTarget(target),
    overlayOpen: isOverlayOpen(),
    promptId: promptIdFromTarget(target),
  };
}

export interface HotkeyProviderProps {
  readonly children: React.ReactNode;
  readonly dispatcher?: HotkeyDispatcher;
}

export function HotkeyProvider({
  children,
  dispatcher = defaultHotkeyDispatcher,
}: HotkeyProviderProps): React.JSX.Element {
  const overlayOpen = useIsOverlayOpen();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      dispatcher.handleKeyDown(event, eventContext(event.target));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      dispatcher.handleKeyUp(event);
    };
    const onPointerDown = () => dispatcher.cancel("pointer");
    const onCompositionStart = () => dispatcher.cancel("composition");
    const onWindowBlur = () => dispatcher.cancel("window_blur");
    const onFocusIn = (event: FocusEvent) => {
      const snapshot = dispatcher.getSnapshot();
      if (snapshot.mode === "idle") return;
      if (promptIdFromTarget(event.target) === snapshot.promptId) return;
      dispatcher.cancel("focus_changed");
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("compositionstart", onCompositionStart, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener(
        "compositionstart",
        onCompositionStart,
        true,
      );
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("blur", onWindowBlur);
      dispatcher.cancel("provider_unmounted");
    };
  }, [dispatcher]);

  useEffect(() => {
    if (overlayOpen) dispatcher.cancel("overlay_open");
  }, [dispatcher, overlayOpen]);

  return (
    <HotkeyDispatcherContext.Provider value={dispatcher}>
      {children}
    </HotkeyDispatcherContext.Provider>
  );
}

export function HotkeyRouteReset(): null {
  const pathname = usePathname();
  const dispatcher = useHotkeyDispatcher();

  useEffect(() => {
    dispatcher.cancel("route_changed");
  }, [dispatcher, pathname]);

  return null;
}

export function useHotkeyDispatcher(): HotkeyDispatcher {
  return useContext(HotkeyDispatcherContext);
}

export function useHotkeySnapshot(): HotkeySnapshot {
  const dispatcher = useHotkeyDispatcher();
  return useSyncExternalStore(
    dispatcher.subscribe,
    dispatcher.getSnapshot,
    dispatcher.getSnapshot,
  );
}

export function useHotkeyCommands(): readonly HotkeyCommandView[] {
  const dispatcher = useHotkeyDispatcher();
  const [revision, setRevision] = useState(0);

  useEffect(
    () =>
      dispatcher.subscribe(() => {
        setRevision((current) => current + 1);
      }),
    [dispatcher],
  );

  return useMemo(() => dispatcher.getCommands(), [dispatcher, revision]);
}
