"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
} from "@/components/ui/Dialog";
import {
  FormError,
  FormGroup,
  FormHint,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useDialogRequestGeneration } from "@/hooks/use-dialog-request-generation";
import { useProjectsQuery } from "@/lib/projects/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { useCreateTicketMutation } from "@/lib/tickets/mutations";
import type { TicketDetail, TicketWorkType } from "@/lib/tickets/schemas";
import { ticketIdentifier } from "../ticket-reference";
import {
  TICKET_WORK_TYPE_LABELS,
  TICKET_WORK_TYPE_ORDER,
} from "../ticket-visuals";
import { useOpenerFocus } from "@/hooks/use-opener-focus";

export interface CreateTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Owning project pre-filled from a project-prefiltered entry; null leaves
   * the choice to the user.
   */
  initialProjectName?: string | null;
}

// The `FormInput` primitive's recipe, applied to elements it cannot render
// (textarea) — same approach as AttachmentDialog.
const FIELD_CLASS =
  "box-border w-full rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] font-mono text-[0.82rem] text-text-primary outline-0 transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] disabled:opacity-60";

export default function CreateTicketDialog({
  open,
  onOpenChange,
  initialProjectName = null,
}: CreateTicketDialogProps): React.JSX.Element {
  const router = useRouter();
  const projectsQuery = useProjectsQuery();
  const createMutation = useCreateTicketMutation();
  const requestGeneration = useDialogRequestGeneration(open);
  const projectSelectId = useId();
  const workTypeSelectId = useId();
  const titleInputId = useId();
  const projectValidationErrorId = useId();
  const titleValidationErrorId = useId();
  const createdActionId = useId();
  const projectDiscoveryErrorId = useId();
  // State-opened dialog (no Radix trigger) — restore focus to the opener.
  const { captureOpener, restoreOpener } = useOpenerFocus();

  const [projectName, setProjectName] = useState(initialProjectName ?? "");
  const [workType, setWorkType] = useState<TicketWorkType>("feature");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<TicketDetail | null>(null);

  // Re-arm the form each time the dialog opens: the pre-filled project tracks
  // the entry the user opened it from, and a previous success/failure never
  // leaks into a fresh create.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setProjectName(initialProjectName ?? "");
      setWorkType("feature");
      setTitle("");
      setDescription("");
      setIssues([]);
      setError(null);
      setCreated(null);
    }
  }

  const projectOptions = useMemo(() => {
    const names = new Set((projectsQuery.data ?? []).map((p) => p.name));
    // The pre-filled entry must be selectable even if discovery hasn't
    // returned (or no longer lists) it.
    if (projectName.length > 0) names.add(projectName);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [projectsQuery.data, projectName]);

  const pending = createMutation.isPending;

  useEffect(() => {
    if (!open || created === null) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(createdActionId)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [created, createdActionId, open]);
  const projectIssue = issues.includes("Choose an owning project.");
  const titleIssue = issues.includes("Title is required.");
  const projectDiscoveryLoading =
    projectsQuery.isPending || projectsQuery.isFetching;
  const noProjectsAvailable =
    projectsQuery.isSuccess && projectOptions.length === 0;
  const projectDiscoveryBlocksSubmit =
    projectName.length === 0 &&
    (projectDiscoveryLoading || projectsQuery.isError || noProjectsAvailable);
  const projectDescriptionIds = [
    projectIssue ? projectValidationErrorId : null,
    projectsQuery.isError || noProjectsAvailable
      ? projectDiscoveryErrorId
      : null,
  ].filter((id): id is string => id !== null);

  const submit = () => {
    const nextIssues: string[] = [];
    if (projectName.length === 0) nextIssues.push("Choose an owning project.");
    if (title.trim().length === 0) nextIssues.push("Title is required.");
    setIssues(nextIssues);
    setError(null);
    if (nextIssues.length > 0) {
      const firstInvalidId =
        projectName.length === 0 ? projectSelectId : titleInputId;
      window.requestAnimationFrame(() => {
        document.getElementById(firstInvalidId)?.focus();
      });
      return;
    }

    const generation = requestGeneration.capture();
    createMutation.mutate(
      { projectName, input: { title: title.trim(), description, workType } },
      {
        onSuccess: (detail) => {
          if (!requestGeneration.isCurrent(generation)) return;
          setCreated(detail);
        },
        onError: (mutationError) => {
          if (!requestGeneration.isCurrent(generation)) return;
          setError(
            mutationError instanceof Error
              ? mutationError.message
              : "Couldn't create the ticket",
          );
        },
      },
    );
  };

  const close = (nextOpen: boolean) => {
    if (!nextOpen) requestGeneration.invalidate();
    onOpenChange(nextOpen);
  };

  const goToDossier = () => {
    if (created === null) return;
    close(false);
    router.push(ticketDetailHref(created.projectName, created.number));
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        mobileSheet
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
      >
        {created !== null ? (
          <>
            <DialogTitle>Ticket created</DialogTitle>
            <p className="m-0 font-mono text-[0.84rem] text-text-primary">
              <span className="font-semibold text-cyan">
                {ticketIdentifier(created)}
              </span>{" "}
              — {created.title}
            </p>
            <FormHint>
              Add context so the work session starts with everything it needs —
              files, conversations, session refs, related tickets, notes.
            </FormHint>
            <DialogActions>
              <Button variant="ghost" onClick={() => close(false)}>
                Close
              </Button>
              <Button
                id={createdActionId}
                variant="primary"
                onClick={goToDossier}
              >
                Add context
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <DialogTitle>New ticket</DialogTitle>

            <div className="grid grid-cols-2 gap-md max-768:grid-cols-1">
              <FormGroup>
                <FormLabel htmlFor={projectSelectId}>Project</FormLabel>
                <Select
                  value={projectName.length > 0 ? projectName : undefined}
                  onValueChange={(value) => {
                    setProjectName(value);
                    setIssues((current) =>
                      current.filter(
                        (issue) => issue !== "Choose an owning project.",
                      ),
                    );
                  }}
                  disabled={pending || projectDiscoveryBlocksSubmit}
                >
                  <SelectTrigger
                    id={projectSelectId}
                    layoutClassName="w-full"
                    aria-required="true"
                    aria-invalid={projectIssue || undefined}
                    aria-describedby={
                      projectDescriptionIds.length > 0
                        ? projectDescriptionIds.join(" ")
                        : undefined
                    }
                  >
                    <SelectValue
                      placeholder={
                        projectDiscoveryLoading
                          ? "Loading projects…"
                          : projectsQuery.isError
                            ? "Projects unavailable"
                            : noProjectsAvailable
                              ? "No projects available"
                              : "Choose project…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {projectOptions.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {projectIssue && (
                  <FormError id={projectValidationErrorId} role="alert">
                    Choose an owning project.
                  </FormError>
                )}
                {projectsQuery.isError && (
                  <FormError id={projectDiscoveryErrorId} role="alert">
                    Couldn&apos;t load projects.{" "}
                    <button
                      type="button"
                      onClick={() => void projectsQuery.refetch()}
                      disabled={projectsQuery.isFetching}
                      className="min-h-[24px] cursor-pointer border-0 bg-transparent p-0 font-mono font-semibold text-red underline underline-offset-2 disabled:cursor-wait disabled:opacity-60"
                    >
                      Retry projects
                    </button>
                  </FormError>
                )}
                {noProjectsAvailable && (
                  <FormError id={projectDiscoveryErrorId} role="alert">
                    No projects are available.
                  </FormError>
                )}
              </FormGroup>
              <FormGroup>
                <FormLabel htmlFor={workTypeSelectId}>Work type</FormLabel>
                <Select
                  value={workType}
                  onValueChange={(value) =>
                    setWorkType(value as TicketWorkType)
                  }
                  disabled={pending}
                >
                  <SelectTrigger id={workTypeSelectId} layoutClassName="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TICKET_WORK_TYPE_ORDER.map((type) => (
                      <SelectItem key={type} value={type}>
                        {capitalize(TICKET_WORK_TYPE_LABELS[type])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormGroup>
            </div>

            <FormGroup>
              <FormLabel htmlFor={titleInputId}>Title</FormLabel>
              <FormInput
                id={titleInputId}
                required
                value={title}
                disabled={pending}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setIssues((current) =>
                    current.filter((issue) => issue !== "Title is required."),
                  );
                }}
                placeholder="What needs to happen"
                aria-invalid={titleIssue || undefined}
                aria-describedby={
                  titleIssue ? titleValidationErrorId : undefined
                }
              />
              {titleIssue && (
                <FormError id={titleValidationErrorId} role="alert">
                  Title is required.
                </FormError>
              )}
            </FormGroup>

            <FormGroup>
              <FormLabel htmlFor="create-ticket-description">
                Description — markdown, optional
              </FormLabel>
              <textarea
                id="create-ticket-description"
                rows={5}
                value={description}
                disabled={pending}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="## Problem…"
                className={FIELD_CLASS}
              />
            </FormGroup>

            {error !== null && <FormError role="alert">{error}</FormError>}

            <DialogActions>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pending || projectDiscoveryBlocksSubmit}
                onClick={submit}
              >
                {pending && <Spinner size="sm" tone="inherit" />}
                Create ticket
              </Button>
            </DialogActions>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
