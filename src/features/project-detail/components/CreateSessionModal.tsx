"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useCreateSessionMutation } from "@/lib/sessions/mutations";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { useSessionsQuery, useBranchPrefixQuery } from "@/lib/sessions/queries";
import { sanitizeBranchName } from "@/lib/sessions/branch-name";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import { FileAutocomplete } from "@/components/FileAutocomplete";
import BranchSelector from "@/components/BranchSelector";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import ImageAttachmentPreview from "@/components/ImageAttachmentPreview";
import { useFileAutocomplete } from "@/hooks/use-file-autocomplete";
import { useBranchFromParent } from "@/stores/sessions.store";
import TddToggle from "@/components/TddToggle";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
} from "@/components/ui/Dialog";
import {
  FormGroup,
  FormLabel,
  FormHint,
  FormError,
} from "@/components/ui/FormField";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionCreationMode } from "@/lib/sessions/schemas";

// The `formInputBase` appearance the `FormInput` primitive owns, applied inline:
// the two `.form-input` consumers here are a ref'd `<input>` (autofocus) and a
// `<textarea rows={6}>`, neither of which the input-only, non-ref-forwarding
// `FormInput` primitive can render. The string is the primitive's recipe verbatim
// (the merged effective `.form-input` cascade: 9px/12px padding, 0.82rem, hover
// border-strong, focus cyan + glow ring, placeholder text-tertiary).
const FORM_INPUT_CLASS =
  "w-full rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] " +
  "font-mono text-[0.82rem] text-text-primary outline-0 " +
  "transition-[border-color,box-shadow] duration-150 ease-[ease] " +
  "placeholder:text-text-tertiary hover:border-border-strong " +
  "focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)]";

/**
 * Session-creation mode toggle button (Fast / Focus / Optimistic). Selection is
 * `data-active`; active beats hover via mutually-exclusive `data-[active=…]`
 * gating so the cascade does not depend on utility emission order.
 */
const modeButtonClass =
  "flex flex-1 cursor-pointer items-center justify-center gap-xs rounded-sm border-none bg-transparent px-sm py-xs font-mono text-[0.75rem] transition-all duration-150 ease-[ease] data-[active=false]:text-text-tertiary data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-secondary data-[active=true]:bg-cyan data-[active=true]:text-text-inverse";

interface CreateSessionModalProps {
  projectName: string;
  open: boolean;
  onClose: () => void;
}

export default function CreateSessionModal({
  projectName,
  open,
  onClose,
}: CreateSessionModalProps): React.JSX.Element {
  const router = useRouter();
  const branchFromParent = useBranchFromParent();
  const [mode, setMode] = useState<SessionCreationMode>("fast");
  const [tddEnabled, setTddEnabled] = useState(true);
  const [parentSessionName, setParentSessionName] = useState<string | null>(
    null,
  );
  const [sessionName, setSessionName] = useState("");
  const [objective, setObjective] = useState("");
  const [instructions, setInstructions] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const objectiveRef = useRef(objective);
  const instructionsRef = useRef(instructions);
  const fireAndForgetRef = useRef(false);
  const autoSubmitPendingRef = useRef(false);
  useEffect(() => {
    objectiveRef.current = objective;
  });
  useEffect(() => {
    instructionsRef.current = instructions;
  });

  const createMutation = useCreateSessionMutation(projectName);

  // Sessions query for BranchSelector
  const sessionsQuery = useSessionsQuery(projectName);
  // Effective branch prefix so the preview shows the real `<prefix>/<slug>`
  // CC will create — never a hardcoded prefix.
  const branchPrefixQuery = useBranchPrefixQuery(projectName);
  const branchOptions = useMemo(() => {
    if (!sessionsQuery.data) return [];
    return sessionsQuery.data
      .filter((s) => !s.finished && !s.archived)
      .map((s) => ({
        sessionName: s.sessionName,
        branchName: s.branchName,
      }));
  }, [sessionsQuery.data]);

  // Find the selected parent session's branch for hint text
  const selectedParentBranch = useMemo(() => {
    if (!parentSessionName || !sessionsQuery.data) return null;
    const parent = sessionsQuery.data.find(
      (s) => s.sessionName === parentSessionName,
    );
    return parent?.branchName ?? null;
  }, [parentSessionName, sessionsQuery.data]);

  // File autocomplete for focus/optimistic textarea
  const currentTextareaValue = mode === "optimistic" ? instructions : objective;
  const setCurrentTextareaValue =
    mode === "optimistic" ? setInstructions : setObjective;
  const fileAutocomplete = useFileAutocomplete({
    projectName,
    text: currentTextareaValue,
    cursorPosition,
    disabled: mode === "fast" || createMutation.isPending,
    onTextChange: setCurrentTextareaValue,
  });

  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();

  // Voice context returns the relevant text based on mode
  const getVoiceContext = useCallback(
    () =>
      mode === "optimistic" ? instructionsRef.current : objectiveRef.current,
    [mode],
  );

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
    toggleRecording,
  } = useVoiceRecorder({
    projectName,
    getContext: getVoiceContext,
    onResult: (text) => {
      if (mode === "optimistic") {
        const newInstructions = instructionsRef.current
          ? instructionsRef.current + "\n" + text
          : text;
        setInstructions(newInstructions);
        instructionsRef.current = newInstructions;
      } else {
        const newObjective = objectiveRef.current
          ? objectiveRef.current + "\n" + text
          : text;
        setObjective(newObjective);
        objectiveRef.current = newObjective;
      }

      if (fireAndForgetRef.current) {
        fireAndForgetRef.current = false;
        autoSubmitPendingRef.current = true;
      }
    },
    onError: (err) => {
      setError(err);
      fireAndForgetRef.current = false;
      autoSubmitPendingRef.current = false;
    },
  });

  // Voice mode is available for focus and optimistic modes
  const voiceEnabled = mode === "focus" || mode === "optimistic";

  // Alt+V hotkey to toggle voice recording while modal is open (focus/optimistic mode)
  useAppHotkey(
    "voiceToggle",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = false;
      }
      void toggleRecording();
    },
    {
      enabled: open && voiceEnabled && voiceAvailable && !isProcessing,
      keepActiveInOverlay: true,
    },
  );

  // Reset state when modal opens (state-during-render pattern)
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSessionName("");
      setObjective("");
      setInstructions("");
      setMode("fast");
      setParentSessionName(branchFromParent);
      setError(null);
      clearImages();
      fireAndForgetRef.current = false;
      autoSubmitPendingRef.current = false;
    }
  }

  // Focus the name input (fast) or the objective/instructions textarea
  // (focus/optimistic). Initial focus is driven synchronously from the Dialog's
  // `onOpenAutoFocus`; this effect re-focuses when the mode changes while open.
  const focusActiveField = useCallback(() => {
    if (mode === "fast") {
      nameInputRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [mode]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(focusActiveField, 100);
      return () => clearTimeout(timer);
    }
  }, [open, focusActiveField]);

  const hasImages = pendingImages.length > 0;
  const canSubmit =
    !createMutation.isPending &&
    !isRecording &&
    (mode === "fast"
      ? sessionName.trim().length > 0
      : mode === "optimistic"
        ? instructions.trim().length > 0 || hasImages
        : objective.trim().length > 0);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);

    const imagePayloads: ImagePayload[] = hasImages
      ? pendingImages.map((img) => ({
          attachmentId: img.id,
          mediaType: img.mediaType as ImagePayload["mediaType"],
          base64Data: img.base64Data,
        }))
      : [];

    const params =
      mode === "fast"
        ? ({
            mode: "fast",
            sessionName: sessionName.trim(),
            tddEnabled,
            parentSessionName: parentSessionName ?? undefined,
          } as const)
        : mode === "optimistic"
          ? ({
              mode: "optimistic",
              instructions: instructions.trim(),
              images: imagePayloads.length > 0 ? imagePayloads : undefined,
              tddEnabled,
              parentSessionName: parentSessionName ?? undefined,
            } as const)
          : ({
              mode: "focus",
              objective: objective.trim(),
              tddEnabled,
              parentSessionName: parentSessionName ?? undefined,
            } as const);

    createMutation.mutate(params, {
      onSuccess: (session) => {
        onClose();

        // Optimistic mode: fire-and-forget — close dialog without navigation
        if (mode === "optimistic") return;

        const conversationId = session.conversations[0]?.id;
        const url = conversationId
          ? conversationsPageHref({
              conversationId,
              autoFocus: mode === "focus",
            })
          : `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`;

        router.push(url);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  };

  // Auto-submit after fire-and-forget voice result
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs every render; ref guard prevents repeated calls
  useEffect(() => {
    if (autoSubmitPendingRef.current && canSubmit) {
      autoSubmitPendingRef.current = false;
      handleSubmit();
    }
  });

  const textareaValue = mode === "optimistic" ? instructions : objective;
  const setTextareaValue =
    mode === "optimistic" ? setInstructions : setObjective;
  const textareaLabel =
    mode === "optimistic"
      ? "What should Claude do?"
      : "What do you want to work on?";
  const textareaPlaceholder =
    mode === "optimistic"
      ? "e.g. Fix the typo in the login page header"
      : "e.g. Add user authentication with JWT tokens";
  const mergeTargetLabel = selectedParentBranch ?? "main";
  const textareaHint =
    mode === "optimistic"
      ? `Claude will complete this task and merge the result into ${mergeTargetLabel}`
      : "Agent will research the codebase and clarify the objective first";

  return (
    // Radix `Dialog` (WAI-ARIA Dialog Modal) owns the focus trap, Escape
    // dismissal, the inert background, and `useOverlayScope` registration.
    // `mobileSheet` reproduces the legacy `.modal` ≤768px bottom-sheet.
    // `onOpenAutoFocus`/`onCloseAutoFocus` take over initial focus (the active
    // field) and focus-return (see below), and `onInteractOutside` is suppressed
    // so an outside click never dismisses this session-creation form (parity with
    // the legacy non-dismissing overlay). The in-form `FileAutocomplete` renders
    // inline, inside the trap.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        mobileSheet
        onOpenAutoFocus={(event) => {
          // Move focus into the active field synchronously instead of Radix's
          // default first-tabbable. Capture the element to restore on close
          // here: this modal opens from the sessions store (not a Radix
          // `DialogTrigger`), so Radix's own focus-return target has already
          // blurred to <body> by the time its FocusScope mounts.
          event.preventDefault();
          const active = document.activeElement;
          restoreFocusRef.current =
            active instanceof HTMLElement ? active : null;
          focusActiveField();
        }}
        onCloseAutoFocus={(event) => {
          const target = restoreFocusRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogTitle>New Session</DialogTitle>
        <FormGroup>
          <div className="mt-sm flex gap-[2px] rounded-md border border-solid border-border-subtle bg-bg-surface p-[3px]">
            <button
              type="button"
              className={modeButtonClass}
              data-active={mode === "fast"}
              onClick={() => setMode("fast")}
              disabled={createMutation.isPending}
            >
              Fast
            </button>
            <button
              type="button"
              className={modeButtonClass}
              data-active={mode === "focus"}
              onClick={() => setMode("focus")}
              disabled={createMutation.isPending}
            >
              Focus
            </button>
            <button
              type="button"
              className={modeButtonClass}
              data-active={mode === "optimistic"}
              onClick={() => setMode("optimistic")}
              disabled={createMutation.isPending}
            >
              Optimistic
            </button>
          </div>

          {branchOptions.length > 0 && (
            <>
              <FormLabel layoutClassName="mt-sm">Branch from</FormLabel>
              <BranchSelector
                sessions={branchOptions}
                selectedParent={parentSessionName}
                onSelect={setParentSessionName}
                disabled={createMutation.isPending}
              />
            </>
          )}

          {mode === "fast" ? (
            <>
              <FormLabel htmlFor="session-name-input" layoutClassName="mt-sm">
                Session name
              </FormLabel>
              <input
                ref={nameInputRef}
                id="session-name-input"
                type="text"
                className={FORM_INPUT_CLASS}
                placeholder="e.g. Copy To Clipboard"
                value={sessionName}
                onChange={(e) => {
                  setSessionName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
              <FormHint>
                {sessionName.trim() && sanitizeBranchName(sessionName) ? (
                  <>
                    Branch:{" "}
                    <code>
                      {branchPrefixQuery.data
                        ? `${branchPrefixQuery.data}/`
                        : ""}
                      {sanitizeBranchName(sessionName)}
                    </code>
                    {selectedParentBranch && (
                      <>
                        {" "}
                        · Merges into: <code>{selectedParentBranch}</code>
                      </>
                    )}
                  </>
                ) : (
                  "Branch name will be derived from the session name"
                )}
              </FormHint>
            </>
          ) : (
            <>
              <FormLabel
                htmlFor="session-objective-input"
                layoutClassName="mt-sm"
              >
                {textareaLabel}
              </FormLabel>
              <div style={{ position: "relative" }}>
                <FileAutocomplete
                  ref={fileAutocomplete.autocompleteRef}
                  items={fileAutocomplete.items}
                  visible={fileAutocomplete.visible}
                  loading={fileAutocomplete.loading}
                  error={fileAutocomplete.error}
                  totalCount={fileAutocomplete.totalCount}
                  truncated={fileAutocomplete.truncated}
                  sourceLabel="From project root"
                  onSelect={fileAutocomplete.onSelect}
                  onClose={fileAutocomplete.onClose}
                />
                <textarea
                  ref={textareaRef}
                  id="session-objective-input"
                  className={FORM_INPUT_CLASS}
                  rows={6}
                  placeholder={textareaPlaceholder}
                  value={textareaValue}
                  onChange={(e) => {
                    setTextareaValue(e.target.value);
                    setCursorPosition(e.target.selectionStart);
                    setError(null);
                  }}
                  onSelect={(e) => {
                    setCursorPosition(
                      (e.target as HTMLTextAreaElement).selectionStart,
                    );
                  }}
                  onPaste={
                    mode === "optimistic"
                      ? (e) => {
                          const items = e.clipboardData.items;
                          for (const item of items) {
                            if (item.type.startsWith("image/")) {
                              e.preventDefault();
                              const file = item.getAsFile();
                              if (file) {
                                void addImage(file).then((result) => {
                                  if (result.error) setError(result.error);
                                });
                              }
                              return;
                            }
                          }
                        }
                      : undefined
                  }
                  onKeyDown={(e) => {
                    if (
                      fileAutocomplete.autocompleteRef.current?.handleKeyDown(e)
                    ) {
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (isRecording) {
                        fireAndForgetRef.current = true;
                        toggleRecording();
                      } else {
                        handleSubmit();
                      }
                    }
                  }}
                />
                {mode === "optimistic" && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const files = e.target.files;
                        if (!files) return;
                        for (const file of files) {
                          void addImage(file).then((result) => {
                            if (result.error) setError(result.error);
                          });
                        }
                        e.target.value = "";
                      }}
                    />
                    <ImageAttachmentPreview
                      images={pendingImages}
                      onRemove={removeImage}
                    />
                  </>
                )}
                <div
                  style={{
                    position: "absolute",
                    right: "0.5rem",
                    bottom: "0.5rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.25rem",
                  }}
                >
                  {mode === "optimistic" && (
                    <button
                      className="attachment-btn"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isAtLimit || createMutation.isPending}
                      title="Attach image"
                      type="button"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                    </button>
                  )}
                  <VoiceRecordButton
                    isRecording={isRecording}
                    isProcessing={isProcessing}
                    elapsedTime={elapsedTime}
                    isAvailable={voiceAvailable}
                    toggleRecording={toggleRecording}
                    disabled={createMutation.isPending}
                  />
                </div>
              </div>
              <FormHint>{textareaHint}</FormHint>
            </>
          )}
          {error && <FormError>{error}</FormError>}
          <TddToggle
            enabled={tddEnabled}
            onChange={setTddEnabled}
            disabled={createMutation.isPending}
          />
        </FormGroup>
        <DialogActions>
          <Button
            size="sm"
            touch
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            touch
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {createMutation.isPending ? "Creating..." : "Create Session"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
