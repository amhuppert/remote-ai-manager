"use client";

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import { useMultilineVoice } from "@/hooks/use-multiline-voice";
import {
  applyTextareaShortcut,
  getMultilineShortcut,
  insertTextAtActiveEdge,
  type TextSelection,
} from "@/lib/multiline/shortcuts";
import { cn } from "@/lib/ui/cn";

type NativeTextareaProps = Omit<
  ComponentPropsWithoutRef<"textarea">,
  "defaultValue" | "onChange" | "value"
>;

export interface MultilineInputProps extends NativeTextareaProps {
  value: string;
  onValueChange(value: string): void;
  onPrimaryAction?(value: string): void;
  /** Project identity enables the shared voice transcription control. */
  voiceProjectName?: string | null;
  /** Overrides platform detection for deterministic adapter tests. */
  isMac?: boolean;
  /** Separate action surface for external buttons; the forwarded ref remains the textarea. */
  actionRef?: Ref<MultilineInputActionHandle>;
  onVoiceStateChange?(busy: boolean): void;
}

export interface MultilineInputActionHandle {
  primaryAction(): void;
  isVoiceBusy(): boolean;
}

export function runMultilinePrimaryAction(
  handles: Iterable<MultilineInputActionHandle | null | undefined>,
  fallback: () => void,
): void {
  for (const handle of handles) {
    if (!handle?.isVoiceBusy()) continue;
    handle.primaryAction();
    return;
  }
  fallback();
}

export interface MultilinePrimaryActionRegistry {
  voiceBusy: boolean;
  primaryAction(fallback: () => void): void;
  register(id: string, handle: MultilineInputActionHandle): void;
  unregister(id: string): void;
  reportVoiceState(id: string, busy: boolean): void;
}

const MultilinePrimaryActionContext =
  createContext<MultilinePrimaryActionRegistry | null>(null);

export function useMultilinePrimaryActionRegistry(): MultilinePrimaryActionRegistry {
  const handlesRef = useRef(new Map<string, MultilineInputActionHandle>());
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const register = useCallback(
    (id: string, handle: MultilineInputActionHandle) => {
      handlesRef.current.set(id, handle);
    },
    [],
  );
  const unregister = useCallback((id: string) => {
    handlesRef.current.delete(id);
    setBusyIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);
  const reportVoiceState = useCallback((id: string, busy: boolean) => {
    setBusyIds((previous) => {
      if (previous.has(id) === busy) return previous;
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const primaryAction = useCallback((fallback: () => void) => {
    runMultilinePrimaryAction(handlesRef.current.values(), fallback);
  }, []);

  return useMemo(
    () => ({
      voiceBusy: busyIds.size > 0,
      primaryAction,
      register,
      unregister,
      reportVoiceState,
    }),
    [busyIds.size, primaryAction, register, reportVoiceState, unregister],
  );
}

export function MultilinePrimaryActionScope({
  registry,
  children,
}: {
  registry: MultilinePrimaryActionRegistry;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <MultilinePrimaryActionContext.Provider value={registry}>
      {children}
    </MultilinePrimaryActionContext.Provider>
  );
}

function detectMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

function getProjectNameFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const match = /^\/projects\/([^/]+)/.exec(window.location.pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export const MultilineInput = forwardRef<
  HTMLTextAreaElement,
  MultilineInputProps
>(function MultilineInput(
  {
    value,
    onValueChange,
    onPrimaryAction,
    onKeyDown,
    voiceProjectName,
    isMac = detectMacPlatform(),
    actionRef,
    onVoiceStateChange,
    disabled = false,
    readOnly = false,
    className,
    ...textareaProps
  },
  forwardedRef,
) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const registryId = useId();
  const actionRegistry = useContext(MultilinePrimaryActionContext);
  const registerAction = actionRegistry?.register;
  const unregisterAction = actionRegistry?.unregister;
  const reportVoiceState = actionRegistry?.reportVoiceState;
  const pendingSelectionRef = useRef<TextSelection | null>(null);
  const valueRef = useRef(value);
  const onVoiceStateChangeRef = useRef(onVoiceStateChange);
  const [isFocused, setIsFocused] = useState(false);
  const projectName =
    voiceProjectName === undefined
      ? getProjectNameFromLocation()
      : (voiceProjectName ?? undefined);

  useLayoutEffect(() => {
    valueRef.current = value;
  }, [value]);
  useLayoutEffect(() => {
    onVoiceStateChangeRef.current = onVoiceStateChange;
  }, [onVoiceStateChange]);

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inputRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    const input = inputRef.current;
    if (!selection || !input) return;
    input.setSelectionRange(selection.start, selection.end);
    pendingSelectionRef.current = null;
  }, [value]);

  const insertVoiceText = useCallback(
    (text: string) => {
      const input = inputRef.current;
      if (!input) return valueRef.current;
      const result = insertTextAtActiveEdge(
        input.value,
        { start: input.selectionStart, end: input.selectionEnd },
        input.selectionDirection,
        text,
      );
      pendingSelectionRef.current = result.selection;
      valueRef.current = result.value;
      onValueChange(result.value);
      return result.value;
    },
    [onValueChange],
  );
  const voice = useMultilineVoice({
    projectName,
    valueRef,
    insertText: insertVoiceText,
    focus: () => inputRef.current?.focus(),
    isFocused,
    onStopAndSubmit: (nextValue) => onPrimaryAction?.(nextValue),
    hotkeyEnabled: !disabled && !readOnly,
  });
  const primaryAction = useCallback(() => {
    if (disabled || readOnly) return;
    if (voice.isRecording || voice.isProcessing) {
      voice.stopAndSubmit();
      return;
    }
    onPrimaryAction?.(valueRef.current);
  }, [disabled, onPrimaryAction, readOnly, voice]);
  const actionHandle = useMemo<MultilineInputActionHandle>(
    () => ({
      primaryAction,
      isVoiceBusy: () => voice.isRecording || voice.isProcessing,
    }),
    [primaryAction, voice.isProcessing, voice.isRecording],
  );
  useImperativeHandle(actionRef, () => actionHandle, [actionHandle]);
  useEffect(() => {
    registerAction?.(registryId, actionHandle);
    return () => unregisterAction?.(registryId);
  }, [actionHandle, registerAction, registryId, unregisterAction]);
  useEffect(() => {
    const busy = voice.isRecording || voice.isProcessing;
    onVoiceStateChangeRef.current?.(busy);
    reportVoiceState?.(registryId, busy);
  }, [registryId, reportVoiceState, voice.isProcessing, voice.isRecording]);
  useEffect(
    () => () => {
      onVoiceStateChangeRef.current?.(false);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || disabled || readOnly) return;

      const shortcut = getMultilineShortcut(event.nativeEvent, isMac);
      if (!shortcut) return;

      event.preventDefault();
      if (shortcut === "submit") {
        primaryAction();
        return;
      }

      const element = event.currentTarget;
      const result = applyTextareaShortcut(
        element.value,
        {
          start: element.selectionStart,
          end: element.selectionEnd,
        },
        shortcut,
        element.selectionDirection,
      );
      if (result.value === element.value) {
        element.setSelectionRange(result.selection.start, result.selection.end);
        return;
      }
      pendingSelectionRef.current = result.selection;
      valueRef.current = result.value;
      onValueChange(result.value);
    },
    [disabled, isMac, onKeyDown, onValueChange, primaryAction, readOnly],
  );

  return (
    <div
      className="relative"
      onFocus={() => setIsFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setIsFocused(false);
        }
      }}
    >
      <textarea
        {...textareaProps}
        className={cn(
          className,
          (projectName || voiceProjectName === null) && "pr-12 pb-12",
        )}
        ref={setRefs}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="absolute right-[var(--space-sm)] bottom-[var(--space-sm)]">
        <VoiceRecordButton
          isRecording={voice.isRecording}
          isProcessing={voice.isProcessing}
          elapsedTime={voice.elapsedTime}
          isAvailable={voice.isAvailable}
          toggleRecording={voice.toggleRecording}
          disabled={disabled || readOnly}
          unavailableReason={
            voiceProjectName === null
              ? "Voice input requires a project-scoped workflow"
              : undefined
          }
        />
      </div>
    </div>
  );
});
