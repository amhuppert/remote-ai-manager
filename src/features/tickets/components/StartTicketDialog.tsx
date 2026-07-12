"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/AlertDialog";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
} from "@/components/ui/Dialog";
import { FormError, FormGroup } from "@/components/ui/FormField";
import { RadioGroup, RadioGroupOption } from "@/components/ui/RadioGroup";
import { Spinner } from "@/components/ui/Spinner";
import { useDialogRequestGeneration } from "@/hooks/use-dialog-request-generation";
import { useStartTicketMutation } from "@/lib/tickets/mutations";
import type { TicketStartMode } from "@/lib/tickets/schemas";
import { useOpenerFocus } from "@/hooks/use-opener-focus";

import FieldGroupLabel from "./FieldGroupLabel";

export interface StartTicketDialogProps {
  projectName: string;
  number: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function StartTicketDialog({
  projectName,
  number,
  open,
  onOpenChange,
}: StartTicketDialogProps): React.JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState<TicketStartMode>("agent");
  const [error, setError] = useState<string | null>(null);
  const [preparedSessionName, setPreparedSessionName] = useState<string | null>(
    null,
  );
  const startMutation = useStartTicketMutation();
  const requestGeneration = useDialogRequestGeneration(open);
  const pending = startMutation.isPending;
  const modeLabelId = useId();
  const preparedActionId = useId();
  // State-opened dialog (no Radix trigger) — restore focus to the opener.
  const { captureOpener, restoreOpener } = useOpenerFocus();

  useEffect(() => {
    if (!open || preparedSessionName === null) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(preparedActionId)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, preparedActionId, preparedSessionName]);

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      requestGeneration.invalidate();
      setMode("agent");
      setError(null);
      setPreparedSessionName(null);
    }
    onOpenChange(nextOpen);
  };

  const submit = () => {
    setError(null);
    const generation = requestGeneration.capture();
    startMutation.mutate(
      { projectName, number, mode },
      {
        onSuccess: (output) => {
          if (!requestGeneration.isCurrent(generation)) return;
          if (mode === "agent" && !output.initialPromptQueued) {
            setPreparedSessionName(output.sessionName);
            return;
          }
          close(false);
        },
        onError: (mutationError) => {
          if (!requestGeneration.isCurrent(generation)) return;
          setError(
            mutationError instanceof Error
              ? mutationError.message
              : "Couldn't start work on the ticket",
          );
        },
      },
    );
  };

  const openPreparedSession = () => {
    if (preparedSessionName === null) return;
    const href = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(preparedSessionName)}`;
    close(false);
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        mobileSheet
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
      >
        <DialogTitle>Start work</DialogTitle>

        {preparedSessionName !== null ? (
          <>
            <FormError role="alert">
              The session was prepared, but the agent kickoff could not be
              queued. Open the session and send its first prompt manually.
            </FormError>
            <DialogActions>
              <Button variant="ghost" onClick={() => close(false)}>
                Close
              </Button>
              <Button
                id={preparedActionId}
                variant="primary"
                onClick={openPreparedSession}
              >
                Open prepared session
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <FormGroup>
              <FieldGroupLabel id={modeLabelId}>Mode</FieldGroupLabel>
              <RadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as TicketStartMode)}
                disabled={pending}
                aria-labelledby={modeLabelId}
              >
                <RadioGroupOption
                  value="agent"
                  label="Agent starts immediately"
                  description="The first turn kicks off from the ticket's title, description, and attachment summaries."
                />
                <RadioGroupOption
                  value="prepared"
                  label="Prepared session"
                  description="Context is materialized, then the session waits for your first prompt."
                />
              </RadioGroup>
            </FormGroup>

            {error !== null && <FormError role="alert">{error}</FormError>}

            <DialogActions>
              {/* Cancel stays enabled through provisioning — closing steps away
                  from the pending start; the link transaction settles server-side. */}
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={pending} onClick={submit}>
                {pending ? (
                  <>
                    <Spinner size="sm" tone="inherit" />
                    Provisioning…
                  </>
                ) : (
                  "Start work"
                )}
              </Button>
            </DialogActions>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface StartTicketConflictAlertProps {
  sessionName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The active-session conflict, surfaced before the start dialog ever opens —
 * an AlertDialog naming the session, not a disabled button, so the reason is
 * discoverable (design §StartTicketDialog).
 */
export function StartTicketConflictAlert({
  sessionName,
  open,
  onOpenChange,
}: StartTicketConflictAlertProps): React.JSX.Element {
  // State-opened alert (no Radix trigger) — restore focus to the opener.
  const { captureOpener, restoreOpener } = useOpenerFocus();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
      >
        <AlertDialogTitle>Work is already in progress</AlertDialogTitle>
        <AlertDialogDescription>
          <span className="font-semibold text-text-primary">{sessionName}</span>{" "}
          is still active on this ticket. One session at a time — finish or
          delete it to start new work; every link stays in the history.
        </AlertDialogDescription>
        <AlertDialogActions>
          <AlertDialogAction onClick={() => onOpenChange(false)}>
            Got it
          </AlertDialogAction>
        </AlertDialogActions>
      </AlertDialogContent>
    </AlertDialog>
  );
}
