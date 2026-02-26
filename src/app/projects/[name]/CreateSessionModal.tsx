"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useCreateSessionMutation } from "@/lib/mutations";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
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
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const objectiveRef = useRef(objective);
  useEffect(() => {
    objectiveRef.current = objective;
  });

  const createMutation = useCreateSessionMutation(projectName);

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
    toggleRecording,
  } = useVoiceRecorder({
    projectName,
    getContext: useCallback(() => objectiveRef.current, []),
    onResult: (text) => {
      setObjective((prev) => (prev ? prev + "\n" + text : text));
    },
    onError: (err) => setError(err),
  });

  // Alt+V hotkey to toggle voice recording while modal is open (focus mode only)
  useAppHotkey("voiceToggle", () => void toggleRecording(), {
    enabled: open && mode === "focus" && voiceAvailable && !isProcessing,
  });

  // Reset state when modal opens (state-during-render pattern)
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSessionName("");
      setObjective("");
      setMode("fast");
      setError(null);
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
      : objective.trim().length > 0);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);

    const params =
      mode === "fast"
        ? ({ mode: "fast", sessionName: sessionName.trim() } as const)
        : ({ mode: "focus", objective: objective.trim() } as const);

    createMutation.mutate(params, {
      onSuccess: (session) => {
        onClose();
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

  if (!open) return null;

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
                What do you want to work on?
              </label>
              <div style={{ position: "relative" }}>
                <textarea
                  ref={textareaRef}
                  id="session-objective-input"
                  className="form-input"
                  rows={6}
                  placeholder="e.g. Add user authentication with JWT tokens"
                  value={objective}
                  onChange={(e) => {
                    setObjective(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
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
              <div className="form-hint">
                Agent will research the codebase and clarify the objective first
              </div>
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
