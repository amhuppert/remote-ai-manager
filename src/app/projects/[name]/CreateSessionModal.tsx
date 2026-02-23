"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useCreateSessionMutation } from "@/lib/mutations";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";

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
  const [objective, setObjective] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const createMutation = useCreateSessionMutation(projectName);

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
    toggleRecording,
  } = useVoiceRecorder({
    projectName,
    onResult: (text) => {
      setObjective((prev) => (prev ? prev + "\n" + text : text));
    },
    onError: (err) => setError(err),
  });

  // Reset state when modal opens (state-during-render pattern)
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setObjective("");
      setError(null);
    }
  }

  // Focus textarea when modal opens
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 100);
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

  const handleSubmit = () => {
    if (!objective.trim() || createMutation.isPending || isRecording) return;
    setError(null);

    createMutation.mutate(objective.trim(), {
      onSuccess: (session) => {
        onClose();
        const conversationId = session.conversations[0]?.id;
        router.push(
          conversationId
            ? `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}/${encodeURIComponent(conversationId)}`
            : `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`,
        );
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
          <label className="form-label" htmlFor="session-objective-input">
            What do you want to work on?
          </label>
          <div style={{ position: "relative" }}>
            <textarea
              ref={textareaRef}
              id="session-objective-input"
              className="form-input"
              rows={3}
              placeholder="e.g. Add user authentication with JWT tokens"
              value={objective}
              maxLength={500}
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
          <div
            className="form-hint"
            style={{
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>Session name and branch will be auto-generated</span>
            <span>{objective.length}/500</span>
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
            disabled={
              !objective.trim() || createMutation.isPending || isRecording
            }
          >
            {createMutation.isPending ? "Creating..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
