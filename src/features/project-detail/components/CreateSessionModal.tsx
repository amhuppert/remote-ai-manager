"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useCreateSessionMutation } from "@/lib/sessions/mutations";
import { useSessionsQuery } from "@/lib/sessions/queries";
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
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionCreationMode } from "@/lib/sessions/schemas";
/** Derive a git-safe branch suffix from an arbitrary session name */
function sanitizeBranchName(sessionName: string): string {
  return sessionName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface CreateSessionModalProps {
  projectName: string;
  open: boolean;
  onClose: () => void;
}

export default function CreateSessionModal({
  projectName,
  open,
  onClose,
}: CreateSessionModalProps): React.JSX.Element | null {
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

  // Focus the appropriate input when modal opens or mode changes
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        if (mode === "fast") {
          nameInputRef.current?.focus();
        } else {
          textareaRef.current?.focus();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open, mode]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

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
        const basePath = conversationId
          ? `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}/${encodeURIComponent(conversationId)}`
          : `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`;

        // Append autoFocus param for Focus mode
        const url =
          mode === "focus" && conversationId
            ? `${basePath}?autoFocus=true`
            : basePath;

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

  if (!open) return null;

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
    <div className="modal-overlay" data-testid="modal-overlay">
      <div className="modal">
        <div className="modal-title">New Session</div>
        <div className="form-group">
          <div className="session-mode-toggle">
            <button
              type="button"
              className={`mode-btn${mode === "fast" ? " active" : ""}`}
              onClick={() => setMode("fast")}
              disabled={createMutation.isPending}
            >
              Fast
            </button>
            <button
              type="button"
              className={`mode-btn${mode === "focus" ? " active" : ""}`}
              onClick={() => setMode("focus")}
              disabled={createMutation.isPending}
            >
              Focus
            </button>
            <button
              type="button"
              className={`mode-btn${mode === "optimistic" ? " active" : ""}`}
              onClick={() => setMode("optimistic")}
              disabled={createMutation.isPending}
            >
              Optimistic
            </button>
          </div>

          {branchOptions.length > 0 && (
            <>
              <label
                className="form-label"
                style={{ marginTop: "var(--space-sm)" }}
              >
                Branch from
              </label>
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
              <label
                className="form-label"
                htmlFor="session-name-input"
                style={{ marginTop: "var(--space-sm)" }}
              >
                Session name
              </label>
              <input
                ref={nameInputRef}
                id="session-name-input"
                type="text"
                className="form-input"
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
              <div className="form-hint">
                {sessionName.trim() && sanitizeBranchName(sessionName) ? (
                  <>
                    Branch: <code>csm/{sanitizeBranchName(sessionName)}</code>
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
              </div>
            </>
          ) : (
            <>
              <label
                className="form-label"
                htmlFor="session-objective-input"
                style={{ marginTop: "var(--space-sm)" }}
              >
                {textareaLabel}
              </label>
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
                  className="form-input"
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
              <div className="form-hint">{textareaHint}</div>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          <TddToggle
            enabled={tddEnabled}
            onChange={setTddEnabled}
            disabled={createMutation.isPending}
          />
        </div>
        <div className="modal-actions">
          <button
            className="btn btn-sm"
            onClick={onClose}
            disabled={createMutation.isPending}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {createMutation.isPending ? "Creating..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
