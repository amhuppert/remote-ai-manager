"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  RichPromptInput,
  type RichPromptInputHandle,
} from "@/components/rich-prompt/RichPromptInput";
import { useCreateSessionMutation } from "@/lib/sessions/mutations";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { useSessionsQuery, useBranchPrefixQuery } from "@/lib/sessions/queries";
import { sanitizeBranchName } from "@/lib/sessions/branch-name";
import BranchSelector from "@/components/BranchSelector";
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
import type {
  CreateSessionRequest,
  SessionCreationMode,
} from "@/lib/sessions/schemas";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";

// The `formInputBase` appearance the `FormInput` primitive owns, applied to the
// ref-forwarded session-name input. The string is the primitive's recipe
// verbatim (the merged effective `.form-input` cascade: 9px/12px padding,
// 0.82rem, hover border-strong, focus cyan + glow ring, placeholder
// text-tertiary).
const FORM_INPUT_CLASS =
  "w-full rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] " +
  "font-mono text-[0.82rem] text-text-primary outline-0 " +
  "transition-[border-color,box-shadow] duration-150 ease-[ease] " +
  "placeholder:text-text-tertiary hover:border-border-strong " +
  "focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)]";

/**
 * Session-creation mode toggle button (Normal / Optimistic). Selection is
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
  const [mode, setMode] = useState<SessionCreationMode>("normal");
  const [tddEnabled, setTddEnabled] = useState(true);
  const [parentSessionName, setParentSessionName] = useState<string | null>(
    null,
  );
  const [sessionName, setSessionName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<RichPromptInputHandle>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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

  // Reset state when modal opens (state-during-render pattern)
  const [prevOpen, setPrevOpen] = useState(false);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSessionName("");
      setInstructions("");
      setMode("normal");
      setParentSessionName(branchFromParent);
      setError(null);
    }
  }

  // Focus the name input (normal) or the instructions textarea (optimistic).
  // Initial focus is driven synchronously from the Dialog's `onOpenAutoFocus`;
  // this effect re-focuses when the mode changes while open.
  const focusActiveField = useCallback(() => {
    if (mode === "normal") {
      nameInputRef.current?.focus();
    } else {
      promptRef.current?.focus();
    }
  }, [mode]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(focusActiveField, 100);
      return () => clearTimeout(timer);
    }
  }, [open, focusActiveField]);

  const canSubmit =
    !createMutation.isPending &&
    mode === "normal" &&
    sessionName.trim().length > 0;

  const submitRequest = (params: CreateSessionRequest, optimistic: boolean) => {
    createMutation.mutate(params, {
      onSuccess: (session) => {
        onClose();

        if (optimistic) return;

        const conversationId = session.conversations[0]?.id;
        const url = conversationId
          ? conversationsPageHref({ conversationId })
          : `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`;

        router.push(url);
      },
      onError: (err) => {
        setError(err.message);
      },
    });
  };

  const createSession = (
    mode: SessionCreationMode,
    document?: SerializedPromptDoc,
  ) => {
    if (mode === "normal") {
      if (!canSubmit) return;
      setError(null);
      submitRequest(
        {
          mode: "normal",
          sessionName: sessionName.trim(),
          tddEnabled,
          parentSessionName: parentSessionName ?? undefined,
        },
        false,
      );
      return;
    }
    if (document === undefined) return;
    setError(null);
    submitRequest(
      {
        mode: "optimistic",
        instructions: document.prompt.trim(),
        images: document.images.length > 0 ? document.images : undefined,
        tddEnabled,
        parentSessionName: parentSessionName ?? undefined,
      },
      true,
    );
  };

  const handleSubmit = () => createSession("normal");

  const mergeTargetLabel = selectedParentBranch ?? "main";
  const textareaHint = `Claude will complete this task and merge the result into ${mergeTargetLabel}`;

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
              data-active={mode === "normal"}
              onClick={() => setMode("normal")}
              disabled={createMutation.isPending}
            >
              Normal
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

          {mode === "normal" && (
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
          )}
          <div
            style={{ display: mode === "optimistic" ? "contents" : "none" }}
            hidden={mode !== "optimistic"}
            aria-hidden={mode !== "optimistic" || undefined}
          >
            <FormLabel
              htmlFor="session-instructions-input"
              layoutClassName="mt-sm"
            >
              What should Claude do?
            </FormLabel>
            <RichPromptInput
              ref={promptRef}
              id="session-instructions-input"
              capabilityContext={{ projectName }}
              value={instructions}
              onValueChange={(value) => {
                setInstructions(value);
                setError(null);
              }}
              onSubmit={(document) => createSession("optimistic", document)}
              ariaLabel="What should Claude do?"
              placeholder="e.g. Fix the typo in the login page header"
              submitLabel="Create Session"
              disabled={createMutation.isPending || mode !== "optimistic"}
              onError={setError}
            />
            <FormHint>{textareaHint}</FormHint>
          </div>
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
          {mode === "normal" && (
            <Button
              variant="primary"
              size="sm"
              touch
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {createMutation.isPending ? "Creating..." : "Create Session"}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
