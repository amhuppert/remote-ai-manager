"use client";

import { Badge } from "@/components/ui/Badge";
import {
  AutocompleteListbox,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "@/components/ui/Autocomplete";
import {
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
} from "@/lib/tickets/ticket-visuals";
import type { TicketStatus, TicketWorkType } from "@/lib/tickets/schemas";
import { cn } from "@/lib/ui/cn";

export interface TicketAutocompleteListItem {
  id: string;
  identifier: string;
  title: string;
  titleMatchIndices: number[];
  projectName: string;
  workType: TicketWorkType;
  status: TicketStatus;
  attachmentCount: number;
  activeSessionName: string | null;
  isCurrentProject: boolean;
}

export interface TicketAutocompleteListProps {
  items: TicketAutocompleteListItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: TicketAutocompleteListItem) => void;
  totalCount: number;
  loading: boolean;
  error: string | null;
}

export function TicketAutocompleteList({
  items,
  selectedIndex,
  onHover,
  onSelect,
  totalCount,
  loading,
  error,
}: TicketAutocompleteListProps): React.JSX.Element {
  const countLabel =
    totalCount > items.length
      ? `${items.length} of ${totalCount}`
      : `${items.length} ${items.length === 1 ? "ticket" : "tickets"}`;

  return (
    <AutocompleteListbox
      label="Tickets"
      activeIndex={selectedIndex}
      maxHeightClassName="max-h-[380px]"
      loading={loading}
      loadingLabel="Loading tickets..."
      error={error}
      isEmpty={items.length === 0}
      empty="No matching tickets"
      header={
        <div className={autocompleteHeaderClass}>
          <span>Tickets — current project first</span>
          <span className={autocompleteHeaderCountClass}>{countLabel}</span>
        </div>
      }
      footer={<AutocompleteNavFooter layoutClassName="max-768:hidden" />}
    >
      {items.map((item, index) => (
        <TicketRow
          key={item.id}
          id={`ticket-autocomplete-option-${index}`}
          item={item}
          active={index === selectedIndex}
          onHover={() => onHover(index)}
          onSelect={() => onSelect(item)}
        />
      ))}
    </AutocompleteListbox>
  );
}

function TicketRow({
  id,
  item,
  active,
  onHover,
  onSelect,
}: {
  id: string;
  item: TicketAutocompleteListItem;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}): React.JSX.Element {
  const status = TICKET_STATUS_VISUALS[item.status];
  return (
    <AutocompleteOption
      id={id}
      variant="conversation"
      active={active}
      onHover={onHover}
      onSelect={onSelect}
    >
      <div className="relative z-raised flex min-w-0 items-center gap-sm">
        <span className="shrink-0 font-mono text-[0.72rem] font-semibold text-cyan">
          {item.identifier}
        </span>
        <AutocompleteMatchText
          text={item.title}
          indices={item.titleMatchIndices}
          className="min-w-0 flex-1 overflow-hidden font-mono text-[0.82rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary"
        />
      </div>
      <div className="relative z-raised flex min-w-0 items-center gap-sm font-mono text-[0.7rem]">
        <Badge tier="type" kind={item.workType} subtle>
          {TICKET_WORK_TYPE_LABELS[item.workType]}
        </Badge>
        <span className={cn("inline-flex items-center gap-xs", status.text)}>
          <span
            className={cn("size-[6px] shrink-0 rounded-full", status.dot)}
          />
          {status.label.toLowerCase()}
        </span>
        <span className="text-text-tertiary">
          {item.attachmentCount} context
        </span>
        {item.activeSessionName !== null && (
          <span className="text-cyan">active session</span>
        )}
        <span className="ml-auto truncate text-text-tertiary">
          {item.isCurrentProject ? "current" : item.projectName}
        </span>
      </div>
    </AutocompleteOption>
  );
}
