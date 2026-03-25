"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useCreateSessionMutation } from "@/lib/mutations";
import { useSessionsQuery } from "@/lib/queries";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import BranchSelector from "@/components/BranchSelector";
import ImageAttachmentPreview from "@/app/projects/[name]/[session]/ImageAttachmentPreview";
import {
  CommandAutocomplete,
  type CommandAutocompleteHandle,
} from "@/components/CommandAutocomplete";
import { FileAutocomplete } from "@/components/FileAutocomplete";
import TddToggle from "@/components/TddToggle";
import { useFileAutocomplete } from "@/hooks/use-file-autocomplete";
import type { SessionState, ImagePayload } from "@/types";

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
  const [cursorPosition, setCursorPosition] = useState(0);
  const [tddEnabled, setTddEnabled] = useState(true);
  const [parentSessionName, setParentSessionName] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [promptPlaceholder, setPromptPlaceholder] = useState<string | null>(
    null,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<CommandAutocompleteHandle>(null);
  const instructionsRef = useRef(instructions);
  const fireAndForgetRef = useRef(false);
  const autoSubmitPendingRef = useRef(false);
  useEffect(() => {
    instructionsRef.current = instructions;
  });

  const createMutation = useCreateSessionMutation(projectName);

  // Sessions query for BranchSelector
  const sessionsQuery = useSessionsQuery(projectName);
  const branchOptions = useMemo(() => {
    if (!sessionsQuery.data) return [];
    return sessionsQuery.data
      .filter((s: SessionState) => !s.finished && !s.archived)
      .map((s: SessionState) => ({
        sessionName: s.sessionName,
        branchName: s.branchName,
      }));
  }, [sessionsQuery.data]);

  const selectedParentBranch = useMemo(() => {
    if (!parentSessionName || !sessionsQuery.data) return null;
    const parent = sessionsQuery.data.find(
      (s: SessionState) => s.sessionName === parentSessionName,
    );
    return parent?.branchName ?? null;
  }, [parentSessionName, sessionsQuery.data]);

  const fileAutocomplete = useFileAutocomplete({
    projectName,
    text: instructions,
    cursorPosition,
    disabled: createMutation.isPending,
    onTextChange: setInstructions,
  });

  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();

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
      setParentSessionName(null);
      setError(null);
      setPromptPlaceholder(null);
      clearImages();
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

  const hasImages = pendingImages.length > 0;
  const canSubmit =
    !createMutation.isPending &&
    !isRecording &&
    (instructions.trim().length > 0 || hasImages);

  const handleSubmit = () => {
    if (!canSubmit) return;
    setError(null);

    const imagePayloads: ImagePayload[] = hasImages
      ? pendingImages.map((img) => ({
          mediaType: img.mediaType as ImagePayload["mediaType"],
          base64Data: img.base64Data,
        }))
      : [];

    createMutation.mutate(
      {
        mode: "optimistic",
        instructions: instructions.trim(),
        images: imagePayloads.length > 0 ? imagePayloads : undefined,
        tddEnabled,
        parentSessionName: parentSessionName ?? undefined,
      },
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

  // Placeholder management for command autocomplete
  const showPlaceholder = useCallback((text: string) => {
    setPromptPlaceholder(text);
  }, []);
  const clearPlaceholder = useCallback(() => {
    setPromptPlaceholder(null);
  }, []);

  if (!open) return null;

  return (
    <div className="modal-overlay" data-testid="modal-overlay">
      <div className="modal">
        <div className="modal-title">Quick Task</div>
        <div className="form-group">
          {branchOptions.length > 0 && (
            <>
              <label className="form-label">Branch from</label>
              <BranchSelector
                sessions={branchOptions}
                selectedParent={parentSessionName}
                onSelect={setParentSessionName}
                disabled={createMutation.isPending}
              />
            </>
          )}
          <label
            className="form-label"
            htmlFor="optimistic-instructions-input"
            style={
              branchOptions.length > 0
                ? { marginTop: "var(--space-sm)" }
                : undefined
            }
          >
            What should Claude do?
          </label>
          <div style={{ position: "relative" }}>
            <CommandAutocomplete
              ref={autocompleteRef}
              promptText={instructions}
              onPromptChange={(text) => {
                setInstructions(text);
                if (!text.startsWith("/")) {
                  clearPlaceholder();
                }
              }}
              onPlaceholderChange={showPlaceholder}
              projectName={projectName}
              disabled={createMutation.isPending}
            />
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
              id="optimistic-instructions-input"
              className="form-input"
              rows={4}
              placeholder={
                promptPlaceholder ??
                "e.g. Fix the typo in the login page header"
              }
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value);
                setCursorPosition(e.target.selectionStart);
                setError(null);
              }}
              onSelect={(e) => {
                setCursorPosition(
                  (e.target as HTMLTextAreaElement).selectionStart,
                );
              }}
              onPaste={(e) => {
                const items = e.clipboardData.items;
                for (const item of items) {
                  if (item.type.startsWith("image/")) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) {
                      void addImage(file).then((err) => {
                        if (err) setError(err);
                      });
                    }
                    return;
                  }
                }
                // Text paste — let default behavior proceed
              }}
              onKeyDown={(e) => {
                if (
                  fileAutocomplete.autocompleteRef.current?.handleKeyDown(e)
                ) {
                  return;
                }
                if (autocompleteRef.current?.handleKeyDown(e)) {
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
                  void addImage(file).then((err) => {
                    if (err) setError(err);
                  });
                }
                // Reset so re-selecting the same file works
                e.target.value = "";
              }}
            />
            <ImageAttachmentPreview
              images={pendingImages}
              onRemove={removeImage}
            />
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
            Claude will complete this task and merge the result into{" "}
            {selectedParentBranch ?? "main"}
          </div>
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
            {createMutation.isPending ? "Submitting..." : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
