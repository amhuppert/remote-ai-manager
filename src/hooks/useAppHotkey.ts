"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useHotkeyDispatcher } from "@/components/hotkeys/HotkeyProvider";
import type {
  HotkeyInvocation,
  HotkeyRegistrationOptions,
} from "@/lib/hotkeys/dispatcher";
import type { HotkeyId } from "@/lib/shared/hotkeys";

export interface UseAppHotkeyOptions {
  readonly enabled?: boolean;
  readonly keepActiveInOverlay?: boolean;
  readonly isAvailable?: (invocation: HotkeyInvocation) => boolean;
}

export function useAppHotkey(
  id: HotkeyId,
  callback: (event: KeyboardEvent, invocation: HotkeyInvocation) => void,
  options: UseAppHotkeyOptions = {},
): void {
  const dispatcher = useHotkeyDispatcher();
  const callbackRef = useRef(callback);
  const availabilityRef = useRef(options.isAvailable);

  useLayoutEffect(() => {
    callbackRef.current = callback;
    availabilityRef.current = options.isAvailable;
  }, [callback, options.isAvailable]);

  useEffect(() => {
    const registrationOptions: HotkeyRegistrationOptions = {
      enabled: options.enabled,
      keepActiveInOverlay: options.keepActiveInOverlay,
      isAvailable: (invocation) =>
        availabilityRef.current?.(invocation) ?? true,
    };
    return dispatcher.register(
      id,
      (event, invocation) => callbackRef.current(event, invocation),
      registrationOptions,
    );
  }, [dispatcher, id, options.enabled, options.keepActiveInOverlay]);
}
