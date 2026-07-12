"use client";

import Link from "next/link";
import type { TicketRefAttrs } from "@/lib/tickets/schemas";
import { ticketDetailHref } from "@/lib/tickets/hrefs";

const MAX_TITLE_LENGTH = 32;

function truncate(label: string): string {
  if (label.length <= MAX_TITLE_LENGTH) return label;
  return label.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

interface TicketRefLinkChipProps {
  attrs: TicketRefAttrs;
}

/**
 * Inline chip rendered where a sent message carries a `<ticket-ref ... />`
 * tag; links to the ticket's detail route. Read-side only — no remove
 * control.
 */
export default function TicketRefLinkChip({
  attrs,
}: TicketRefLinkChipProps): React.JSX.Element {
  const href = ticketDetailHref(attrs["project-name"], attrs["ticket-number"]);

  return (
    <Link
      href={href}
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised px-[6px] py-[2px] align-baseline font-mono text-[0.78rem] leading-none text-inherit no-underline transition-[border-color,background,box-shadow] duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:shadow-[0_0_0_2px_var(--cyan-glow)]"
      title={attrs.title}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        aria-hidden="true"
        className="h-[12px] w-[12px] shrink-0 text-cyan"
      >
        <path d="M2 5.75A1.25 1.25 0 0 1 3.25 4.5h9.5A1.25 1.25 0 0 1 14 5.75v1a1.75 1.75 0 0 0 0 3.5v1a1.25 1.25 0 0 1-1.25 1.25h-9.5A1.25 1.25 0 0 1 2 11.25v-1a1.75 1.75 0 0 0 0-3.5z" />
        <path d="M6.5 4.5v8" strokeDasharray="1.5 1.5" />
      </svg>
      <span className="text-text-primary">
        {attrs.identifier} · {truncate(attrs.title)}
      </span>
      <span
        className="inline-flex items-center text-text-tertiary"
        aria-hidden="true"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 9 L9 3" />
          <path d="M4 3 L9 3 L9 8" />
        </svg>
      </span>
    </Link>
  );
}
