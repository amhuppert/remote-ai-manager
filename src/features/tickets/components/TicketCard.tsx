"use client";

import { forwardRef } from "react";
import { TicketChildSummary } from "./TicketChildSummary";
import Link from "next/link";

import { Badge } from "@/components/ui/Badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { ticketDetailHref as ticketDetailHrefFor } from "@/lib/tickets/hrefs";
import type { TicketListItem, TicketStatus } from "@/lib/tickets/schemas";
import { cn } from "@/lib/ui/cn";
import { ticketIdentifier } from "../ticket-reference";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
} from "@/lib/tickets/ticket-visuals";

export interface TicketCardProps extends React.HTMLAttributes<HTMLDivElement> {
  item: TicketListItem;
  /** Source slot while its DragOverlay twin is in flight — dashed ghost. */
  isDragSource?: boolean;
  /** Rendered inside the DragOverlay — lifted treatment per handoff §3. */
  isOverlay?: boolean;
  /** One-shot cyan wash after a committed move. */
  landed?: boolean;
  /** One-shot cyan wash when the card arrives through a live delta. */
  entered?: boolean;
  /** Collapse-out treatment while a removed card remains mounted for 150ms. */
  exiting?: boolean;
  /** 1.5s red ring after a rolled-back move. */
  failed?: boolean;
  /**
   * The keyboard drag activator, rendered in the header row. The card root
   * must stay non-interactive (its links and kebab are focusable children,
   * so role=button on the root is invalid ARIA); pointer dragging still
   * works from the whole card body.
   */
  dragHandle?: React.ReactNode;
  onMoveTo?: (status: TicketStatus) => void;
  onCopyReference?: () => void;
  onDelete?: () => void;
}

function ticketDetailHref(item: TicketListItem): string {
  return ticketDetailHrefFor(item.projectName, item.number);
}

const TicketCard = forwardRef<HTMLDivElement, TicketCardProps>(
  function TicketCard(
    {
      item,
      isDragSource = false,
      isOverlay = false,
      landed = false,
      entered = false,
      exiting = false,
      failed = false,
      dragHandle,
      onMoveTo,
      onCopyReference,
      onDelete,
      className,
      ...rest
    },
    ref,
  ) {
    const identifier = ticketIdentifier(item);

    return (
      <div
        ref={ref}
        data-ticket-card={identifier}
        className={cn(
          "flex flex-col gap-[8px] rounded-md border border-solid p-[10px] pb-[9px] transition-[border-color] duration-[120ms] ease-[ease] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none",
          isDragSource
            ? "border-dashed border-cyan-dim bg-[var(--cc-cyan-a04)] opacity-70"
            : "border-border-subtle bg-bg-surface hover:border-border-strong",
          isOverlay &&
            "scale-[1.03] rotate-[2.5deg] cursor-grabbing border-solid border-cyan-dim bg-bg-raised shadow-[0_18px_48px_var(--cc-black-a50),0_0_0_1px_var(--cc-cyan-a04),0_0_24px_var(--color-cyan-glow)] motion-reduce:scale-100 motion-reduce:rotate-0",
          !isOverlay && !isDragSource && "cursor-grab",
          landed && "animate-tk-card-land motion-reduce:animate-none",
          entered && "animate-tk-sse-in motion-reduce:animate-none",
          exiting &&
            "pointer-events-none max-h-[240px] animate-tk-sse-out overflow-hidden motion-reduce:animate-none",
          failed &&
            "border-red-dim shadow-[0_0_0_1px_var(--color-red-glow),0_0_16px_var(--color-red-glow)]",
          className,
        )}
        {...rest}
      >
        <div className={cn(isDragSource && "invisible", "contents")}>
          <div className="flex items-center gap-[6px]">
            <Link
              href={ticketDetailHref(item)}
              className="overflow-hidden font-mono text-[0.72rem] font-semibold text-ellipsis whitespace-nowrap text-text-secondary! no-underline transition-colors duration-150 ease-[ease] hover:text-cyan!"
            >
              {identifier}
            </Link>
            <span className="ml-auto flex shrink-0 items-center gap-[2px]">
              {dragHandle}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`Ticket actions for ${identifier}`}
                  className="inline-flex size-[24px] cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="8" cy="3" r="1.4" />
                    <circle cx="8" cy="8" r="1.4" />
                    <circle cx="8" cy="13" r="1.4" />
                  </svg>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={ticketDetailHref(item)}>Open ticket</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onCopyReference?.()}>
                    Copy ticket reference
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Move to</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={item.status}
                    onValueChange={(value) => onMoveTo?.(value as TicketStatus)}
                  >
                    {TICKET_STATUS_ORDER.map((status) => (
                      <DropdownMenuRadioItem key={status} value={status}>
                        {TICKET_STATUS_VISUALS[status].label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem danger onSelect={() => onDelete?.()}>
                    Delete ticket…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
          <Link
            href={ticketDetailHref(item)}
            className="line-clamp-2 font-mono text-[0.82rem] leading-[1.35] font-semibold text-text-primary! no-underline transition-colors duration-150 ease-[ease] hover:text-cyan!"
          >
            {item.title}
          </Link>
          <div className="flex items-center gap-[8px]">
            <Badge tier="type" kind={item.workType}>
              {TICKET_WORK_TYPE_LABELS[item.workType]}
            </Badge>
            <span
              className={cn(
                "inline-flex items-center gap-[3px] font-mono text-[0.7rem] font-medium",
                item.attachmentCount === 0
                  ? "text-text-tertiary"
                  : "text-text-secondary",
              )}
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="opacity-80"
              >
                <path
                  d="M13 7.5 L8.2 12.3 A3.2 3.2 0 0 1 3.7 7.8 L8.8 2.7 A2.1 2.1 0 0 1 11.8 5.7 L6.9 10.6 A1 1 0 0 1 5.5 9.2 L10 4.7"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
              {item.attachmentCount}
            </span>
            {item.activeSessionName !== null && (
              <span
                title={item.activeSessionName}
                className="ml-auto inline-flex min-w-0 items-center gap-[5px] font-mono text-[0.66rem] font-medium text-text-secondary"
              >
                <span
                  aria-hidden="true"
                  className="h-[6px] w-[6px] shrink-0 [animation:pulse-dot_2.5s_ease_infinite] rounded-full bg-green shadow-[0_0_6px_var(--color-green-glow)] motion-reduce:[animation:none]"
                />
                <span className="max-w-[110px] overflow-hidden text-ellipsis whitespace-nowrap">
                  {item.activeSessionName}
                </span>
              </span>
            )}
          </div>
          <TicketChildSummary counts={item.childStatusCounts} />
          {onMoveTo !== undefined && !isOverlay && (
            <div className="mt-[2px] hidden items-center gap-[8px] border-x-0 border-t border-b-0 border-solid border-border-subtle pt-[9px] max-768:flex">
              <span className="font-mono text-[0.64rem] font-medium tracking-[0.06em] text-text-tertiary uppercase">
                Move to
              </span>
              <Select
                value={item.status}
                onValueChange={(value) => onMoveTo(value as TicketStatus)}
              >
                <SelectTrigger
                  aria-label={`Move ${identifier} to`}
                  layoutClassName="w-[150px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TICKET_STATUS_ORDER.map((status) => (
                    <SelectItem key={status} value={status}>
                      {TICKET_STATUS_VISUALS[status].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>
    );
  },
);

export default TicketCard;
