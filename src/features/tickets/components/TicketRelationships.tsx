"use client";

import { useId, useState } from "react";
import Link from "next/link";

import ConfirmDialog from "@/components/ConfirmDialog";
import { DocumentMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import {
  SectionActions,
  SectionCount,
  SectionHeader,
  SectionLabel,
} from "@/components/ui/SectionHeader";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { ticketDependenciesHref, ticketDetailHref } from "@/lib/tickets/hrefs";
import { useRemoveTicketRelationshipMutation } from "@/lib/tickets/mutations";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type {
  TicketRelationshipRole,
  TicketRelationshipView,
  TicketStatus,
} from "@/lib/tickets/schemas";
import { TICKET_STATUS_VISUALS } from "@/lib/tickets/ticket-visuals";
import TicketRelationshipDialog from "./TicketRelationshipDialog";

export interface TicketRelationshipsProps {
  projectName: string;
  number: number;
  relationships: readonly TicketRelationshipView[];
}

export default function TicketRelationships(
  props: TicketRelationshipsProps,
): React.JSX.Element {
  const headingId = useId();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<TicketRelationshipView | null>(null);
  const [removeCandidate, setRemoveCandidate] =
    useState<TicketRelationshipView | null>(null);
  const [removeError, setRemoveError] = useState<{
    relationshipId: string;
    message: string;
  } | null>(null);
  const removeMutation = useRemoveTicketRelationshipMutation();

  const remove = (relationship: TicketRelationshipView) => {
    setRemoveCandidate(null);
    setRemoveError(null);
    removeMutation.mutate(
      {
        projectName: props.projectName,
        number: props.number,
        relationshipId: relationship.id,
      },
      {
        onError: (error) => {
          setRemoveError({
            relationshipId: relationship.id,
            message:
              error instanceof Error
                ? error.message
                : "Couldn't remove the relationship.",
          });
        },
      },
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-label="Relationships"
      className="flex flex-col gap-md"
    >
      <SectionHeader layoutClassName="mb-0 flex-wrap">
        <SectionLabel id={headingId}>Relationships</SectionLabel>
        <SectionCount>{props.relationships.length}</SectionCount>
        <SectionActions layoutClassName="flex-wrap">
          <Link
            href={ticketDependenciesHref(props.projectName, props.number)}
            className="inline-flex min-h-[32px] items-center px-sm font-mono text-[0.72rem] text-text-secondary! no-underline hover:text-cyan! focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
          >
            View dependencies
          </Link>
          <Button
            type="button"
            variant="default"
            size="sm"
            touch
            onClick={() => setAddOpen(true)}
          >
            Add relationship
          </Button>
        </SectionActions>
      </SectionHeader>

      {props.relationships.length === 0 ? (
        <p className="m-0 py-sm font-mono text-[0.74rem] text-text-tertiary">
          No relationships yet.
        </p>
      ) : (
        <div className="flex flex-col gap-lg">
          {RELATIONSHIP_GROUPS.map((group) => {
            const items = props.relationships.filter(
              (relationship) => relationship.role === group.role,
            );
            if (items.length === 0) return null;
            return (
              <div key={group.role} className="flex flex-col gap-sm">
                <h3 className="m-0 font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                  {group.label}
                </h3>
                <ul className="m-0 flex list-none flex-col gap-sm p-0">
                  {items.map((relationship) => (
                    <RelationshipRow
                      key={relationship.id}
                      relationship={relationship}
                      removing={
                        removeMutation.isPending &&
                        removeMutation.variables?.relationshipId ===
                          relationship.id
                      }
                      error={
                        removeError?.relationshipId === relationship.id
                          ? removeError.message
                          : null
                      }
                      onEdit={() => setEditing(relationship)}
                      onRemove={() => setRemoveCandidate(relationship)}
                      onRetryRemove={() => remove(relationship)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <TicketRelationshipDialog
        projectName={props.projectName}
        number={props.number}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
      <TicketRelationshipDialog
        projectName={props.projectName}
        number={props.number}
        open={editing !== null}
        relationship={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <ConfirmDialog
        open={removeCandidate !== null}
        title="Remove relationship?"
        message={
          removeCandidate === null
            ? ""
            : `Remove the relationship with ${formatTicketIdentifier(removeCandidate.otherTicket.projectName, removeCandidate.otherTicket.number)}? The linked ticket is not deleted.`
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removeCandidate !== null) remove(removeCandidate);
        }}
        onCancel={() => setRemoveCandidate(null)}
      />
    </section>
  );
}

function RelationshipRow({
  relationship,
  removing,
  error,
  onEdit,
  onRemove,
  onRetryRemove,
}: {
  relationship: TicketRelationshipView;
  removing: boolean;
  error: string | null;
  onEdit: () => void;
  onRemove: () => void;
  onRetryRemove: () => void;
}): React.JSX.Element {
  const identifier = formatTicketIdentifier(
    relationship.otherTicket.projectName,
    relationship.otherTicket.number,
  );
  return (
    <li
      aria-label={`${identifier} ${relationship.otherTicket.title}`}
      className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-sm">
        <Link
          href={ticketDetailHref(
            relationship.otherTicket.projectName,
            relationship.otherTicket.number,
          )}
          className="min-w-0 flex-1 font-mono text-[0.78rem] font-semibold text-text-primary! no-underline hover:text-cyan! focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          {identifier} · {relationship.otherTicket.title}
        </Link>
        <StatusChip tone={statusTone(relationship.otherTicket.status)}>
          {TICKET_STATUS_VISUALS[relationship.otherTicket.status].label}
        </StatusChip>
      </div>

      {relationship.description.length > 0 ? (
        <div className="rounded-sm bg-bg-void">
          <DocumentMarkdown content={relationship.description} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-sm">
        {error !== null ? (
          <div
            role="alert"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-sm font-mono text-[0.72rem] text-red"
          >
            <span>{error}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              touch
              onClick={onRetryRemove}
            >
              Retry remove
            </Button>
          </div>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          touch
          aria-label={`Edit ${relationship.id}`}
          disabled={removing}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          touch
          disabled={removing}
          onClick={onRemove}
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
    </li>
  );
}

const RELATIONSHIP_GROUPS: ReadonlyArray<{
  role: TicketRelationshipRole;
  label: string;
}> = [
  { role: "parent", label: "Parent" },
  { role: "child", label: "Children" },
  { role: "depends_on", label: "Depends on" },
  { role: "blocks", label: "Blocks" },
  { role: "related", label: "Related" },
];

function statusTone(status: TicketStatus): StatusChipTone {
  if (status === "in_progress") return "cyan";
  if (status === "done") return "green";
  if (status === "blocked") return "red";
  return "neutral";
}
