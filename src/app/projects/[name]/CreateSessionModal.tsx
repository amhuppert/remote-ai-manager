"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useCreateSessionMutation } from "@/lib/mutations";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import { FileAutocomplete } from "@/components/FileAutocomplete";
import { useFileAutocomplete } from "@/hooks/use-file-autocomplete";
import type { SessionCreationMode } from "@/types";

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
  const [mode, setMode] = useState<SessionCreationMode>("fast");
  const [sessionName, setSessionName] = useState("");
  const [objective, setObjective] = useState("");
  const [instructions, setInstructions] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // Ctrl+Alt+V hotkey for fire-and-forget voice (auto-submit on completion)
  useAppHotkey(
    "voiceFireAndForget",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = true;
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
      setError(null);
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

  const canSubmit =
    !createMutation.isPending &&
    !isRecording &&
    (mode === "fast"
      ? sessionName.trim().length > 0
      : mode === "optimistic"
        ? instructions.trim().length > 0
        : objective.trim().length > 0);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);

    const params =
      mode === "fast"
        ? ({ mode: "fast", sessionName: sessionName.trim() } as const)
        : mode === "optimistic"
          ? ({ mode: "optimistic", instructions: instructions.trim() } as const)
          : ({ mode: "focus", objective: objective.trim() } as const);

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
  const textareaHint =
    mode === "optimistic"
      ? "Claude will complete this task and merge the result into main"
      : "Agent will research the codebase and clarify the objective first";

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
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
              className={`mode-btn${mode === "optimistic" ? " active" : ""}`}
              onClick={() => setMode("optimistic")}
              disabled={createMutation.isPending}
            >
              Optimistic
            </button>
            <button
              type="button"
              className={`mode-btn${mode === "focus" ? " active" : ""}`}
              onClick={() => setMode("focus")}
              disabled={createMutation.isPending}
            >
              Focus
            </button>
          </div>

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
                Branch name will be derived from the session name
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
                  onKeyDown={(e) => {
                    if (
                      fileAutocomplete.autocompleteRef.current?.handleKeyDown(e)
                    ) {
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      if (isRecording) {
                        toggleRecording();
                      } else {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    right: "0.5rem",
                    bottom: "0.5rem",
                  }}
                >
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
