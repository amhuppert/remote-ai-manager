"use client";

import Link from "next/link";

import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { useTicketSessionLinksQuery } from "@/lib/tickets/queries";
import { cn } from "@/lib/ui/cn";

export interface SessionTicketIndicatorProps {
  projectName: string;
  sessionName: string;
  /** External-geometry utilities only; appended after appearance. */
  layoutClassName?: string;
}

/**
 * Ticket identity on a linked session's presentation surfaces (design §618):
 * an identifier pill fed by the per-project session-link map, shown for
 * active AND historical links with distinct treatments; activation navigates
 * to the ticket's detail view. Renders nothing for unlinked sessions.
 */
export default function SessionTicketIndicator({
  projectName,
  sessionName,
  layoutClassName,
}: SessionTicketIndicatorProps): React.JSX.Element | null {
  const linksQuery = useTicketSessionLinksQuery(projectName);
  const link = linksQuery.data?.[sessionName];
  if (link === undefined) return null;
  const livenessUnknown = linksQuery.isError;
  const active = link.active && !livenessUnknown;
  const identifier = `${link.projectName}#${link.number}`;

  return (
    <Link
      href={ticketDetailHref(link.projectName, link.number)}
      title={
        livenessUnknown
          ? `${link.title} — ticket link status unavailable`
          : link.title
      }
      aria-label={
        livenessUnknown
          ? `${identifier}, ticket link status unavailable`
          : undefined
      }
      data-active={active || undefined}
      data-liveness={
        livenessUnknown ? "unknown" : active ? "active" : "historical"
      }
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex shrink-0 items-center gap-[3px] rounded-full border border-solid px-[7px] py-[2px] font-mono text-[0.66rem] leading-none font-semibold no-underline transition-[border-color,color] duration-150 ease-[ease]",
        livenessUnknown
          ? "border-amber-dim bg-amber-glow text-amber! hover:border-amber"
          : active
            ? "border-cyan-dim bg-[var(--cc-cyan-a08)] text-cyan! hover:border-cyan"
            : "border-border-subtle bg-bg-raised text-text-tertiary! hover:border-border-strong hover:text-text-secondary!",
        layoutClassName,
      )}
    >
      {identifier}
      {livenessUnknown && <span aria-hidden="true">?</span>}
    </Link>
  );
}
