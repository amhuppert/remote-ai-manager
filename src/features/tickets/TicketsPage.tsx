"use client";

import { Suspense, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import Topbar from "@/components/Topbar";
import { Button } from "@/components/ui/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { TicketListFilters } from "@/lib/tickets/list-filters";
import { useTicketListQuery } from "@/lib/tickets/queries";
import type { TicketListItem } from "@/lib/tickets/schemas";
import {
  parseTicketsPageState,
  ticketsPageHref,
  type TicketListSortState,
  type TicketsPageState,
  type TicketsView,
} from "@/lib/tickets/ticket-url-state";
import { useQuickTicketStore } from "@/stores/quick-ticket.store";
import { cn } from "@/lib/ui/cn";
import { ticketIdentifier } from "./ticket-reference";
import TicketBoard from "./components/TicketBoard";
import TicketFilters, {
  defaultTicketFilters,
  ticketFiltersActive,
} from "./components/TicketFilters";
import TicketList from "./components/TicketList";
import TicketSplitPane from "./components/TicketSplitPane";

export interface TicketsPageProps {
  defaultAgentBackend: AgentBackendId;
  backendDefaults: BackendSelectionDefaultsById;
}

export default function TicketsPage(
  props: TicketsPageProps,
): React.JSX.Element {
  // useSearchParams() forces a CSR bailout during prerender; Next.js requires
  // a Suspense boundary above it for the /tickets shell to build.
  return (
    <Suspense>
      <TicketsPageInner {...props} />
    </Suspense>
  );
}

function TicketsPageInner({
  defaultAgentBackend,
  backendDefaults,
}: TicketsPageProps): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const state = useMemo(
    () =>
      parseTicketsPageState(
        new URLSearchParams(searchParams?.toString() ?? ""),
      ),
    [searchParams],
  );
  const { view, filters, listSort, selected } = state;
  const filtersAreActive = ticketFiltersActive(filters);
  const openQuickTicket = useQuickTicketStore((store) => store.openQuickTicket);

  const listQuery = useTicketListQuery({
    projectName: filters.projectName ?? undefined,
    statuses: filters.statuses ?? undefined,
    workType: filters.workType ?? undefined,
    sort: filters.sort,
  });
  // The unfiltered list backs the "n of m shown" count, the header stats, and
  // the project filter options; with no filters active it shares the filtered
  // query's cache entry.
  const totalsQuery = useTicketListQuery({});

  const items = listQuery.data ?? [];
  const allItems = useMemo(() => totalsQuery.data ?? [], [totalsQuery.data]);
  const inProgressCount = allItems.filter(
    (item) => item.status === "in_progress",
  ).length;
  const projectOptions = useMemo(
    () => deriveProjectOptions(allItems, filters.projectName),
    [allItems, filters.projectName],
  );

  const navigate = useCallback(
    (next: TicketsPageState, mode: "push" | "replace") => {
      router[mode](ticketsPageHref(next), { scroll: false });
    },
    [router],
  );

  const handleFiltersChange = useCallback(
    (next: TicketListFilters) => {
      navigate({ ...state, filters: next }, "replace");
    },
    [navigate, state],
  );

  const handleViewChange = useCallback(
    (nextView: TicketsView) => {
      navigate({ ...state, view: nextView }, "push");
    },
    [navigate, state],
  );

  const handleSortChange = useCallback(
    (next: TicketListSortState) => {
      navigate({ ...state, listSort: next }, "replace");
    },
    [navigate, state],
  );

  const handleSelect = useCallback(
    (item: TicketListItem) => {
      navigate(
        {
          ...state,
          selected: { projectName: item.projectName, number: item.number },
        },
        "push",
      );
    },
    [navigate, state],
  );

  const handleCloseDetail = useCallback(() => {
    navigate({ ...state, selected: null }, "push");
  }, [navigate, state]);

  const selectHrefFor = useCallback(
    (item: TicketListItem) =>
      ticketsPageHref({
        ...state,
        selected: { projectName: item.projectName, number: item.number },
      }),
    [state],
  );

  const clearFilters = useCallback(() => {
    handleFiltersChange(defaultTicketFilters(filters));
  }, [handleFiltersChange, filters]);

  const handleNewTicket = useCallback(() => {
    openQuickTicket({
      pathname: "/tickets",
      searchParams: new URLSearchParams(searchParams.toString()),
    });
  }, [openQuickTicket, searchParams]);

  const splitOpen = view === "list" && selected !== null;

  return (
    <div className="app" data-page="tickets">
      <Topbar page="tickets" breadcrumbs={[{ label: "tickets" }]} />
      <main className="main">
        <div className="flex min-h-[44px] items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-xl py-sm max-768:flex-wrap max-768:px-md">
          <div className="flex min-w-0 flex-1 items-center gap-sm">
            <h1
              data-ticket-page-heading
              tabIndex={-1}
              className="m-0 font-display text-[1.05rem] leading-[1.05] font-extrabold whitespace-nowrap text-text-primary"
            >
              tickets{" "}
              <span className="text-cyan [text-shadow:0_0_24px_var(--cyan-glow-text)]">
                ·
              </span>
            </h1>
            {totalsQuery.isSuccess && (
              <span
                data-ticket-header-stats
                className="flex items-center gap-sm max-768:hidden"
              >
                <span className="font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary">
                  {allItems.length} ticket{allItems.length === 1 ? "" : "s"}
                </span>
                {inProgressCount > 0 && (
                  <>
                    <span className="font-mono text-[0.72rem] text-text-tertiary">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-[5px] rounded-full border border-solid border-border-subtle bg-bg-raised px-[7px] py-px text-[0.7rem] whitespace-nowrap text-text-secondary">
                      <span
                        aria-hidden="true"
                        className="h-[6px] w-[6px] [animation:pulse-dot_2.5s_ease_infinite] rounded-full bg-cyan shadow-[0_0_6px_var(--color-cyan-glow)] motion-reduce:[animation:none]"
                      />
                      {inProgressCount} in progress
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
          <div
            data-ticket-page-actions
            className="flex shrink-0 items-center gap-sm max-768:w-full max-768:justify-between"
          >
            <Button variant="primary" size="sm" onClick={handleNewTicket}>
              <PlusIcon />
              New ticket
            </Button>
            <SegmentedControl
              aria-label="View"
              value={view}
              onValueChange={(value) => handleViewChange(value as TicketsView)}
            >
              <SegmentedControlItem value="board">Board</SegmentedControlItem>
              <SegmentedControlItem value="list">List</SegmentedControlItem>
            </SegmentedControl>
          </div>
        </div>

        <TicketFilters
          filters={filters}
          projectOptions={projectOptions}
          shownCount={items.length}
          totalCount={allItems.length}
          countsReady={listQuery.isSuccess && totalsQuery.isSuccess}
          onFiltersChange={handleFiltersChange}
        />

        {listQuery.isSuccess && totalsQuery.isError && (
          <div
            role="alert"
            className="mx-xl mt-sm flex items-center gap-sm rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm font-mono text-[0.72rem] text-amber max-768:mx-md"
          >
            <span>
              Couldn&apos;t load ticket totals. Filtered results are still
              available.
            </span>
            <Button
              variant="ghost"
              size="sm"
              layoutClassName="ml-auto shrink-0"
              disabled={totalsQuery.isFetching}
              onClick={() => void totalsQuery.refetch()}
            >
              {totalsQuery.isFetching ? "Retrying…" : "Retry totals"}
            </Button>
          </div>
        )}

        {listQuery.isPending ? (
          <div className="px-xl py-lg font-mono text-[0.72rem] text-text-tertiary">
            Loading tickets…
          </div>
        ) : listQuery.isError ? (
          <div role="alert" className="py-3xl">
            <EmptyState>
              <EmptyStateTitle>Couldn&apos;t load tickets</EmptyStateTitle>
              <EmptyStateDesc>
                {listQuery.error instanceof Error
                  ? listQuery.error.message
                  : "Something went wrong fetching the ticket list."}
              </EmptyStateDesc>
              <Button
                variant="ghost"
                size="sm"
                disabled={listQuery.isFetching}
                onClick={() => void listQuery.refetch()}
              >
                {listQuery.isFetching ? "Retrying…" : "Retry tickets"}
              </Button>
            </EmptyState>
          </div>
        ) : view === "board" ? (
          <TicketBoard items={items} statuses={filters.statuses} />
        ) : (
          <div
            className={cn(
              splitOpen &&
                "grid grid-cols-[minmax(300px,400px)_minmax(0,1fr)] items-start max-768:block",
            )}
          >
            <div
              className={cn(
                splitOpen &&
                  "min-w-0 border-0 border-r border-solid border-border-dim max-768:hidden",
              )}
            >
              <TicketList
                items={items}
                hasAnyTickets={
                  totalsQuery.isSuccess ? allItems.length > 0 : filtersAreActive
                }
                statusesNarrowed={filters.statuses !== null}
                sort={listSort}
                onSortChange={handleSortChange}
                selected={splitOpen ? selected : null}
                selectHrefFor={selectHrefFor}
                onSelect={handleSelect}
                condensed={splitOpen}
                onClearFilters={clearFilters}
              />
              <div className="px-xl py-[10px] font-mono text-[0.68rem] text-text-tertiary">
                Live via SSE — rows appear, move and vanish without refresh
              </div>
            </div>
            {splitOpen && (
              <TicketSplitPane
                key={ticketIdentifier(selected)}
                selection={selected}
                onClose={handleCloseDetail}
                defaultAgentBackend={defaultAgentBackend}
                backendDefaults={backendDefaults}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 3 V13 M3 8 H13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function deriveProjectOptions(
  allItems: readonly TicketListItem[],
  activeProject: string | null,
): string[] {
  const names = new Set<string>(allItems.map((item) => item.projectName));
  // A pre-filtered entry may target a project with no tickets yet — the
  // select must still be able to display it.
  if (activeProject !== null) names.add(activeProject);
  return [...names].sort((a, b) => a.localeCompare(b));
}
