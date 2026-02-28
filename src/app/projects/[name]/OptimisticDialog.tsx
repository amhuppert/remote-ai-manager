"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useCreateSessionMutation } from "@/lib/mutations";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";

interface OptimisticDialogProps {
  projectName: string;
  open: boolean;
  onClose: () => void;
}

export default function OptimisticDialog({
  projectName,
  open,
  onClose,
}: OptimisticDialogProps): React.JSX.Element | null {
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const instructionsRef = useRef(instructions);
  const fireAndForgetRef = useRef(false);
  const autoSubmitPendingRef = useRef(false);
  useEffect(() => {
    instructionsRef.current = instructions;
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
    getContext: useCallback(() => instructionsRef.current, []),
    onResult: (text) => {
      const newInstructions = instructionsRef.current
        ? instructionsRef.current + "\n" + text
        : text;
      setInstructions(newInstructions);
      instructionsRef.current = newInstructions;

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

  // Reset state when dialog opens
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setInstructions("");
      setError(null);
      fireAndForgetRef.current = false;
      autoSubmitPendingRef.current = false;
    }
  }

  // Focus textarea when dialog opens
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [open]);

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
    !createMutation.isPending && !isRecording && instructions.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);

    createMutation.mutate(
      { mode: "optimistic", instructions: instructions.trim() },
      {
        onSuccess: () => {
          onClose();
        },
        onError: (err) => {
          setError(err.message);
        },
      },
    );
  };

  // Alt+V hotkey to toggle voice recording while dialog is open
  useAppHotkey(
    "voiceToggle",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = false;
      }
      void toggleRecording();
    },
    {
      enabled: open && voiceAvailable && !isProcessing,
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
      enabled: open && voiceAvailable && !isProcessing,
    },
  );

  // Auto-submit after fire-and-forget voice result
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs every render; ref guard prevents repeated calls
  useEffect(() => {
    if (autoSubmitPendingRef.current && canSubmit) {
      autoSubmitPendingRef.current = false;
      handleSubmit();
    }
  });

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <div className="modal-title">Quick Task</div>
        <div className="form-group">
          <label className="form-label" htmlFor="optimistic-instructions-input">
            What should Claude do?
          </label>
          <div style={{ position: "relative" }}>
            <textarea
              ref={textareaRef}
              id="optimistic-instructions-input"
              className="form-input"
              rows={4}
              placeholder="e.g. Fix the typo in the login page header"
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value);
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
            Claude will complete this task and merge the result into main
          </div>
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
            {createMutation.isPending ? "Submitting..." : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
