"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { CheckboxField } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { Spinner } from "@/components/ui/Spinner";
import { ticketDependenciesHref, ticketDetailHref } from "@/lib/tickets/hrefs";
import { useTicketRelationshipsQuery } from "@/lib/tickets/queries";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type { TicketRelationshipView } from "@/lib/tickets/schemas";
import { TICKET_STATUS_VISUALS } from "@/lib/tickets/ticket-visuals";
import { cn } from "@/lib/ui/cn";

export type DependencyTicket = TicketRelationshipView["otherTicket"];
type Direction = "depends_on" | "blocks";
const LINK_CLASS =
  "inline-flex min-h-[32px] items-center font-mono text-[0.72rem] text-text-secondary! no-underline hover:text-cyan! focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";

export default function TicketDependencyMap({
  ticket,
}: {
  ticket: DependencyTicket;
}): React.JSX.Element {
  const [showAllTickets, setShowAllTickets] = useState(false);
  return (
    <div className="flex flex-col gap-xl">
      <div className="flex flex-wrap items-center justify-between gap-lg">
        <p className="m-0 font-mono text-[0.74rem] text-text-secondary">
          {showAllTickets
            ? "Including done and closed tickets."
            : "Done and closed tickets are hidden."}
        </p>
        <CheckboxField
          label="Show all tickets"
          checked={showAllTickets}
          onCheckedChange={(checked) => setShowAllTickets(checked === true)}
          touch
        />
      </div>
      <div className="flex flex-wrap items-center gap-sm font-mono text-[0.74rem] text-text-secondary">
        <span>Prerequisites</span>
        <Arrow />
        <span>This ticket</span>
        <Arrow />
        <span>Dependents</span>
        <span className="ml-auto text-text-tertiary max-768:ml-0 max-768:w-full">
          Expand a ticket to follow the chain.
        </span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_32px_minmax(0,0.9fr)_32px_minmax(0,1fr)] items-start gap-sm max-960:grid-cols-1">
        <section aria-label="Depends on" className="min-w-0">
          <ColumnHeading
            title="Depends on"
            description="Prerequisites for this ticket"
          />
          <DependencyBranch
            ticket={ticket}
            direction="depends_on"
            path={[ticket.id]}
            depth={0}
            showAllTickets={showAllTickets}
          />
        </section>
        <div
          aria-hidden="true"
          className="flex justify-center pt-3xl text-text-tertiary max-960:py-sm"
        >
          <span className="max-960:rotate-90">
            <Arrow />
          </span>
        </div>
        <section aria-label="Focused ticket" className="min-w-0">
          <ColumnHeading
            title="This ticket"
            description="Center of this dependency map"
          />
          <TicketNode ticket={ticket} focused />
        </section>
        <div
          aria-hidden="true"
          className="flex justify-center pt-3xl text-text-tertiary max-960:py-sm"
        >
          <span className="max-960:rotate-90">
            <Arrow />
          </span>
        </div>
        <section aria-label="Blocks" className="min-w-0">
          <ColumnHeading
            title="Blocks"
            description="Tickets that depend on this ticket"
          />
          <DependencyBranch
            ticket={ticket}
            direction="blocks"
            path={[ticket.id]}
            depth={0}
            showAllTickets={showAllTickets}
          />
        </section>
      </div>
      <p className="m-0 border-x-0 border-t border-b-0 border-solid border-border-dim pt-lg font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
        Arrows run from prerequisite to dependent. Parent/child and related
        links are shown on the ticket itself.
      </p>
    </div>
  );
}

function ColumnHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="mb-lg flex flex-col gap-xs">
      <h2 className="m-0 font-mono text-[0.74rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
        {title}
      </h2>
      <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
        {description}
      </p>
    </div>
  );
}

function DependencyBranch({
  ticket,
  direction,
  path,
  depth,
  showAllTickets,
}: {
  ticket: DependencyTicket;
  direction: Direction;
  path: readonly string[];
  depth: number;
  showAllTickets: boolean;
}): React.JSX.Element {
  const query = useTicketRelationshipsQuery(
    ticket.projectName,
    ticket.number,
    direction,
  );
  const noun = direction === "depends_on" ? "prerequisites" : "dependents";
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;
  const visibleItems = showAllTickets
    ? items
    : items.filter(
        ({ otherTicket }) =>
          otherTicket.status !== "done" && otherTicket.status !== "closed",
      );
  return (
    <div className="flex min-w-0 flex-col gap-md">
      {query.isPending && (
        <div
          role="status"
          className="flex items-center gap-sm p-md font-mono text-[0.74rem] text-text-secondary"
        >
          <Spinner size="sm" />
          Loading {noun}…
        </div>
      )}
      {visibleItems.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-md p-0">
          {visibleItems.map((relationship) => (
            <li key={relationship.id}>
              <ExpandableNode
                ticket={relationship.otherTicket}
                direction={direction}
                path={path}
                depth={depth}
                showAllTickets={showAllTickets}
              />
            </li>
          ))}
        </ul>
      )}
      {query.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-sm rounded-md border border-solid border-red-dim bg-bg-base p-md font-mono text-[0.74rem] text-red"
        >
          <span>Couldn&apos;t load {noun}.</span>
          <Button
            size="sm"
            touch
            loading={query.isFetching}
            onClick={() =>
              void (query.isFetchNextPageError
                ? query.fetchNextPage()
                : query.refetch())
            }
          >
            Retry {noun}
          </Button>
        </div>
      )}
      {!query.isPending && !query.isError && visibleItems.length === 0 && (
        <p className="m-0 rounded-md border border-dashed border-border-subtle p-lg font-mono text-[0.74rem] text-text-tertiary">
          {items.length > 0
            ? `Done or closed ${noun} are hidden. Show all tickets to view them.`
            : direction === "depends_on"
              ? "No prerequisites."
              : "No tickets depend on this ticket."}
        </p>
      )}
      {query.hasNextPage && !query.isError && (
        <Button
          size="sm"
          touch
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more {noun} ({items.length} of {total} loaded)
        </Button>
      )}
    </div>
  );
}

function ExpandableNode({
  ticket,
  direction,
  path,
  depth,
  showAllTickets,
}: {
  ticket: DependencyTicket;
  direction: Direction;
  path: readonly string[];
  depth: number;
  showAllTickets: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const branchId = useId();
  const identifier = formatTicketIdentifier(ticket.projectName, ticket.number);
  const noun = direction === "depends_on" ? "prerequisites" : "dependents";
  const repeated = path.includes(ticket.id);
  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <TicketNode ticket={ticket}>
        {!repeated && (
          <Button
            size="sm"
            variant="ghost"
            touch
            aria-expanded={expanded}
            aria-controls={branchId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${noun} for ${identifier}`}
            onClick={() => setExpanded(!expanded)}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              className={cn("shrink-0", expanded && "rotate-90")}
            >
              <path
                d="m6 3 5 5-5 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {expanded ? "Hide" : "Show"} {noun}
          </Button>
        )}
        {repeated && (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            Already in this chain
          </span>
        )}
      </TicketNode>
      {expanded && (
        <div
          id={branchId}
          className={cn(
            "flex min-w-0 flex-col gap-sm border-y-0 border-r-0 border-l border-solid border-border-default",
            depth < 2 ? "ml-md pl-md" : "pl-sm",
          )}
        >
          <p className="m-0 flex items-center gap-xs font-mono text-[0.7rem] text-text-secondary">
            <span
              className={direction === "depends_on" ? "rotate-180" : undefined}
            >
              <Arrow />
            </span>
            {identifier} {direction === "depends_on" ? "depends on" : "blocks"}
          </p>
          <DependencyBranch
            ticket={ticket}
            direction={direction}
            path={[...path, ticket.id]}
            depth={depth + 1}
            showAllTickets={showAllTickets}
          />
        </div>
      )}
    </div>
  );
}

function TicketNode({
  ticket,
  focused = false,
  children,
}: {
  ticket: DependencyTicket;
  focused?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  const identifier = formatTicketIdentifier(ticket.projectName, ticket.number);
  const tone =
    ticket.status === "in_progress"
      ? "cyan"
      : ticket.status === "done"
        ? "green"
        : ticket.status === "blocked"
          ? "red"
          : "neutral";
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-md rounded-md border border-solid p-lg",
        focused
          ? "border-cyan-dim bg-bg-surface"
          : "border-border-subtle bg-bg-base",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-sm">
        <span
          className={cn(
            "min-w-0 font-mono text-[0.72rem] break-words",
            focused ? "text-cyan" : "text-text-tertiary",
          )}
        >
          {identifier}
        </span>
        <StatusChip tone={tone}>
          {TICKET_STATUS_VISUALS[ticket.status].label}
        </StatusChip>
      </div>
      <h3 className="m-0 font-mono text-[0.82rem] leading-relaxed font-medium break-words text-text-primary">
        {ticket.title}
      </h3>
      <div className="flex flex-wrap items-center gap-x-lg gap-y-xs">
        <Link
          href={ticketDetailHref(ticket.projectName, ticket.number)}
          className={LINK_CLASS}
          aria-label={`Open ${identifier}`}
        >
          Open ticket
        </Link>
        {!focused && (
          <Link
            href={ticketDependenciesHref(ticket.projectName, ticket.number)}
            className={LINK_CLASS}
            aria-label={`Center on ${identifier}`}
          >
            Center here
          </Link>
        )}
      </div>
      {children}
    </article>
  );
}

function Arrow(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="16"
      viewBox="0 0 20 16"
      fill="none"
      className="shrink-0"
    >
      <path
        d="M2 8h15m-5-5 5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
