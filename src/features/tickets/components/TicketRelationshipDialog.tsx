"use client";

import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { MultilineInput } from "@/components/MultilineInput";
import {
  AutocompleteListbox,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  AutocompleteOption,
} from "@/components/ui/Autocomplete";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  FormError,
  FormGroup,
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
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import {
  useAddTicketRelationshipMutation,
  useUpdateTicketRelationshipMutation,
} from "@/lib/tickets/mutations";
import { ticketQueries } from "@/lib/tickets/queries";
import { filterAndScoreTickets } from "@/lib/tickets/ticket-autocomplete-filter";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type {
  TicketListItem,
  TicketRelationshipRole,
  TicketRelationshipView,
} from "@/lib/tickets/schemas";

export interface TicketRelationshipDialogProps {
  projectName: string;
  number: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  relationship?: TicketRelationshipView | null;
}

export default function TicketRelationshipDialog(
  props: TicketRelationshipDialogProps,
): React.JSX.Element {
  const formKey = props.open ? (props.relationship?.id ?? "add") : "closed";

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <TicketRelationshipDialogContent key={formKey} {...props} />
    </Dialog>
  );
}

function TicketRelationshipDialogContent(
  props: TicketRelationshipDialogProps,
): React.JSX.Element {
  const editing =
    props.relationship !== undefined && props.relationship !== null;
  const roleId = useId();
  const targetId = useId();
  const rationaleId = useId();
  const listboxId = useId();
  const [role, setRole] = useState<TicketRelationshipRole>("related");
  const [query, setQuery] = useState("");
  const [selectedTicket, setSelectedTicket] = useState<TicketListItem | null>(
    null,
  );
  const [rationale, setRationale] = useState(
    props.relationship?.description ?? "",
  );
  const [popupOpen, setPopupOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const ticketsQuery = useQuery({
    ...ticketQueries.list(),
    enabled: props.open && !editing,
  });
  const addMutation = useAddTicketRelationshipMutation();
  const updateMutation = useUpdateTicketRelationshipMutation();
  const { captureOpener, restoreOpener } = useOpenerFocus();

  const candidates = useMemo(() => {
    const available = (ticketsQuery.data ?? []).filter((ticket) => {
      if (
        ticket.projectName === props.projectName &&
        ticket.number === props.number
      ) {
        return false;
      }
      if (role === "parent" || role === "child") {
        return ticket.projectName === props.projectName;
      }
      return true;
    });
    return filterAndScoreTickets(query, available, {
      currentProjectName: props.projectName,
      includeDone: true,
    }).items;
  }, [props.number, props.projectName, query, role, ticketsQuery.data]);

  const resolvedActiveIndex =
    candidates.length === 0 ? -1 : Math.min(activeIndex, candidates.length - 1);

  const pending = addMutation.isPending || updateMutation.isPending;

  const selectTicket = (ticket: TicketListItem) => {
    setSelectedTicket(ticket);
    setQuery(
      `${formatTicketIdentifier(ticket.projectName, ticket.number)} · ${ticket.title}`,
    );
    setPopupOpen(false);
    setActiveIndex(-1);
    setError(null);
  };

  const submit = () => {
    if (pending) return;
    setError(null);
    if (editing) {
      updateMutation.mutate(
        {
          projectName: props.projectName,
          number: props.number,
          relationshipId: props.relationship!.id,
          description: rationale,
        },
        mutationCallbacks(props.onOpenChange, setError),
      );
      return;
    }
    if (selectedTicket === null) {
      setError("Choose a ticket to relate.");
      return;
    }
    addMutation.mutate(
      {
        projectName: props.projectName,
        number: props.number,
        target: {
          projectName: selectedTicket.projectName,
          number: selectedTicket.number,
        },
        role,
        description: rationale,
      },
      mutationCallbacks(props.onOpenChange, setError),
    );
  };

  return (
    <DialogContent
      mobileSheet
      onOpenAutoFocus={captureOpener}
      onCloseAutoFocus={restoreOpener}
    >
      <DialogTitle>
        {editing ? "Edit relationship" : "Add relationship"}
      </DialogTitle>
      <DialogDescription>
        {editing
          ? "Update the Markdown rationale without changing the linked tickets."
          : "Choose how this ticket relates to another ticket."}
      </DialogDescription>

      {!editing ? (
        <>
          <FormGroup>
            <FormLabel htmlFor={roleId}>Role</FormLabel>
            <Select
              value={role}
              disabled={pending}
              onValueChange={(value) => {
                setRole(value as TicketRelationshipRole);
                setSelectedTicket(null);
                setQuery("");
                setPopupOpen(false);
                setActiveIndex(-1);
                setError(null);
              }}
            >
              <SelectTrigger id={roleId} layoutClassName="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent contentLayer="popover">
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormGroup>

          <FormGroup>
            <FormLabel htmlFor={targetId}>Ticket</FormLabel>
            <div className="relative">
              <FormInput
                id={targetId}
                role="combobox"
                autoComplete="off"
                aria-autocomplete="list"
                aria-controls={listboxId}
                aria-expanded={popupOpen}
                aria-activedescendant={
                  popupOpen && resolvedActiveIndex >= 0
                    ? `${listboxId}-option-${resolvedActiveIndex}`
                    : undefined
                }
                value={query}
                disabled={pending}
                placeholder="Search by project, identifier, or title"
                onFocus={() => setPopupOpen(true)}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedTicket(null);
                  setPopupOpen(true);
                  setActiveIndex(-1);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setPopupOpen(false);
                    setActiveIndex(-1);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setPopupOpen(true);
                    setActiveIndex(
                      Math.min(resolvedActiveIndex + 1, candidates.length - 1),
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setPopupOpen(true);
                    setActiveIndex(
                      resolvedActiveIndex <= 0
                        ? candidates.length - 1
                        : resolvedActiveIndex - 1,
                    );
                    return;
                  }
                  if (
                    event.key === "Enter" &&
                    popupOpen &&
                    resolvedActiveIndex >= 0 &&
                    candidates[resolvedActiveIndex] !== undefined
                  ) {
                    event.preventDefault();
                    selectTicket(candidates[resolvedActiveIndex]!.item);
                  }
                }}
              />
              {popupOpen ? (
                <div id={listboxId}>
                  <AutocompleteListbox
                    label="Tickets"
                    activeIndex={resolvedActiveIndex}
                    loading={ticketsQuery.isPending}
                    loadingLabel="Loading tickets…"
                    error={
                      ticketsQuery.isError
                        ? errorMessage(
                            ticketsQuery.error,
                            "Couldn't load tickets.",
                          )
                        : null
                    }
                    isEmpty={ticketsQuery.isSuccess && candidates.length === 0}
                    empty="No matching tickets"
                    maxHeightClassName="max-h-[340px]"
                    footer={
                      <AutocompleteNavFooter layoutClassName="max-768:hidden" />
                    }
                  >
                    {candidates.map((candidate, index) => (
                      <AutocompleteOption
                        key={candidate.item.id}
                        id={`${listboxId}-option-${index}`}
                        active={index === resolvedActiveIndex}
                        archived={
                          candidate.item.status === "done" ||
                          candidate.item.status === "closed"
                        }
                        onHover={() => setActiveIndex(index)}
                        onSelect={() => selectTicket(candidate.item)}
                      >
                        <span className="relative z-raised flex min-w-0 flex-1 items-center gap-sm">
                          <span className="shrink-0 font-mono text-[0.7rem] font-semibold text-cyan">
                            {formatTicketIdentifier(
                              candidate.item.projectName,
                              candidate.item.number,
                            )}
                          </span>
                          <AutocompleteMatchText
                            text={candidate.item.title}
                            indices={candidate.titleMatchIndices}
                            className="min-w-0 flex-1 overflow-hidden text-[0.76rem] text-ellipsis whitespace-nowrap text-text-primary"
                          />
                          <span className="shrink-0 font-mono text-[0.64rem] text-text-tertiary">
                            {candidate.item.status.replaceAll("_", " ")}
                          </span>
                        </span>
                      </AutocompleteOption>
                    ))}
                  </AutocompleteListbox>
                </div>
              ) : null}
            </div>
          </FormGroup>
        </>
      ) : null}

      <FormGroup>
        <FormLabel htmlFor={rationaleId}>Rationale</FormLabel>
        <MultilineInput
          id={rationaleId}
          rows={5}
          value={rationale}
          disabled={pending}
          voiceProjectName={props.projectName}
          placeholder="Optional Markdown rationale"
          className="box-border w-full resize-y rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] font-mono text-[0.82rem] leading-[1.55] text-text-primary outline-none placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--color-cyan-glow)] disabled:opacity-60"
          onValueChange={(value) => {
            setRationale(value);
            setError(null);
          }}
          onPrimaryAction={submit}
        />
      </FormGroup>

      {error !== null ? <FormError role="alert">{error}</FormError> : null}

      <DialogActions>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => props.onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={pending}
          disabled={!editing && selectedTicket === null}
          onClick={submit}
        >
          {editing
            ? pending
              ? "Saving…"
              : "Save rationale"
            : pending
              ? "Adding…"
              : "Add relationship"}
        </Button>
      </DialogActions>
    </DialogContent>
  );
}

const ROLE_OPTIONS: ReadonlyArray<{
  value: TicketRelationshipRole;
  label: string;
}> = [
  { value: "related", label: "Related" },
  { value: "depends_on", label: "Depends on" },
  { value: "blocks", label: "Blocks" },
  { value: "parent", label: "Parent" },
  { value: "child", label: "Child" },
];

function mutationCallbacks(
  onOpenChange: (open: boolean) => void,
  setError: (message: string | null) => void,
) {
  return {
    onSuccess: () => onOpenChange(false),
    onError: (error: unknown) =>
      setError(errorMessage(error, "Couldn't save the ticket relationship.")),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
