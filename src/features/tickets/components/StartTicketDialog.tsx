"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";

import AgentProfilePicker from "@/components/agent-profiles/AgentProfilePicker";
import {
  parseAgentProfilePickerValue,
  STANDARD_AGENT_PROFILE_VALUE,
} from "@/components/agent-profiles/agent-profile-picker-state";
import BackendToggle from "@/components/BackendToggle";
import ModelSelector from "@/components/ModelSelector";
import { useProjectBackendModelOptions } from "@/lib/agent-backends/queries";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
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
import { getEffortLevelsForBackend } from "@/lib/agent-backends/catalog";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { useStartTicketMutation } from "@/lib/tickets/mutations";
import type { TicketStartMode } from "@/lib/tickets/schemas";
import { useOpenerFocus } from "@/hooks/use-opener-focus";

import FieldGroupLabel from "./FieldGroupLabel";

function defaultEffort(backend: AgentBackendId, model: string): EffortLevel {
  const levels = getEffortLevelsForBackend(backend, model);
  if (levels.includes("high")) return "high";
  return levels[levels.length - 1] ?? "high";
}

function profileDefaults(
  backend: AgentBackendId,
  backendDefaults: BackendSelectionDefaultsById,
): { model: string; effort: EffortLevel } {
  const configured = backendDefaults[backend];
  const levels = getEffortLevelsForBackend(backend, configured.modelId);
  const effort = levels.includes(configured.effort)
    ? configured.effort
    : defaultEffort(backend, configured.modelId);
  return { model: configured.modelId, effort };
}

export interface StartTicketDialogProps {
  projectName: string;
  number: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
}

export default function StartTicketDialog({
  projectName,
  number,
  open,
  onOpenChange,
  defaultBackend,
  backendDefaults,
}: StartTicketDialogProps): React.JSX.Element {
  const router = useRouter();
  const initialDefaults = profileDefaults(defaultBackend, backendDefaults);
  const [mode, setMode] = useState<TicketStartMode>("agent");
  const [backend, setBackend] = useState<AgentBackendId>(defaultBackend);
  const [model, setModel] = useState(initialDefaults.model);
  const [reasoningEffort, setReasoningEffort] = useState<EffortLevel>(
    initialDefaults.effort,
  );
  // A ticket always starts inside a project, so the models offered are the
  // project's effective ones (spec D10), not the process-global catalog's.
  const projectModelOptions = useProjectBackendModelOptions(
    projectName,
    backend,
  );
  const [profileValue, setProfileValue] = useState(
    STANDARD_AGENT_PROFILE_VALUE,
  );
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
      const defaults = profileDefaults(defaultBackend, backendDefaults);
      setBackend(defaultBackend);
      setModel(defaults.model);
      setReasoningEffort(defaults.effort);
      setProfileValue(STANDARD_AGENT_PROFILE_VALUE);
      setError(null);
      setPreparedSessionName(null);
    }
    onOpenChange(nextOpen);
  };

  const submit = () => {
    setError(null);
    const generation = requestGeneration.capture();
    const effortLevels = getEffortLevelsForBackend(backend, model);
    const profile = parseAgentProfilePickerValue(profileValue) ?? undefined;
    startMutation.mutate(
      {
        projectName,
        number,
        mode,
        // Identity applies to both modes: a prepared session's first manual
        // turn runs under the same profile an agent start would have used.
        ...(profile === undefined ? {} : { profile }),
        ...(mode === "agent"
          ? {
              backend,
              model,
              ...(effortLevels.includes(reasoningEffort)
                ? { reasoningEffort }
                : {}),
            }
          : {}),
      },
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

  const changeBackend = (nextBackend: AgentBackendId) => {
    const defaults = profileDefaults(nextBackend, backendDefaults);
    setBackend(nextBackend);
    setModel(defaults.model);
    setReasoningEffort(defaults.effort);
  };

  const changeModel = (nextModel: string) => {
    const levels = getEffortLevelsForBackend(backend, nextModel);
    setModel(nextModel);
    if (!levels.includes(reasoningEffort)) {
      setReasoningEffort(defaultEffort(backend, nextModel));
    }
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

            <FormGroup>
              <FieldGroupLabel>Agent profile</FieldGroupLabel>
              <AgentProfilePicker
                projectName={projectName}
                value={profileValue}
                onChange={(selection) => setProfileValue(selection.value)}
                disabled={pending}
              />
            </FormGroup>

            {mode === "agent" && (
              <FormGroup>
                <FieldGroupLabel>Kickoff agent</FieldGroupLabel>
                <div className="flex flex-wrap items-end gap-lg">
                  <div className="flex flex-col gap-2xs">
                    <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                      Backend
                    </span>
                    <BackendToggle
                      value={backend}
                      onChange={changeBackend}
                      disabled={pending}
                    />
                  </div>
                  <div className="flex flex-col gap-2xs">
                    <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                      Model
                    </span>
                    <ModelSelector
                      backend={backend}
                      value={model}
                      onChange={changeModel}
                      disabled={pending}
                      projectOptions={projectModelOptions}
                    />
                  </div>
                  <div className="flex flex-col gap-2xs">
                    <span className="font-mono text-[0.6rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                      Reasoning
                    </span>
                    <ReasoningLevelSelector
                      value={reasoningEffort}
                      onChange={setReasoningEffort}
                      availableLevels={getEffortLevelsForBackend(
                        backend,
                        model,
                      )}
                      disabled={pending}
                    />
                  </div>
                </div>
              </FormGroup>
            )}

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
