"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ColumnFiltersState,
  type SortingFn,
} from "@tanstack/react-table";
import type { SessionState, DerivedSessionStatus } from "@/types";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";
import {
  useTddToggleMutation,
  useArchiveSessionMutation,
} from "@/lib/mutations";
import { useConfirmDeleteSession } from "@/stores/sessions.store";
import TddToggle from "@/components/TddToggle";

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusBadge({ session }: { session: SessionState }) {
  if (session.finished) {
    return (
      <span className="session-status merged">
        <span className="dot" />
        merged
      </span>
    );
  }
  const status = deriveSessionStatus(session);
  return (
    <span className={`session-status ${status}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

function SessionTddToggle({
  projectName,
  session,
}: {
  projectName: string;
  session: SessionState;
}) {
  const tddMutation = useTddToggleMutation(projectName, session.sessionName);

  return (
    <TddToggle
      enabled={session.tddEnabled}
      onChange={(val) => tddMutation.mutate(val)}
      disabled={tddMutation.isPending}
      compact
    />
  );
}

function ArchiveButton({
  projectName,
  session,
}: {
  projectName: string;
  session: SessionState;
}) {
  const archiveMutation = useArchiveSessionMutation(
    projectName,
    session.sessionName,
  );

  return (
    <button
      className="btn btn-sm"
      onClick={(e) => {
        e.stopPropagation();
        archiveMutation.mutate(!session.archived);
      }}
      disabled={archiveMutation.isPending}
    >
      {session.archived ? "Unarchive" : "Archive"}
    </button>
  );
}

const STATUS_ORDER: DerivedSessionStatus[] = [
  "running",
  "waiting_for_input",
  "awaiting",
  "new",
  "idle",
];

const statusSortingFn: SortingFn<SessionState> = (rowA, rowB, columnId) => {
  const a = STATUS_ORDER.indexOf(rowA.getValue(columnId));
  const b = STATUS_ORDER.indexOf(rowB.getValue(columnId));
  return a - b;
};

const columnHelper = createColumnHelper<SessionState>();

function SortIndicator({ direction }: { direction: false | "asc" | "desc" }) {
  if (!direction) {
    return <span className="sort-indicator">{"\u21C5"}</span>;
  }
  return (
    <span className="sort-indicator active">
      {direction === "asc" ? "\u2191" : "\u2193"}
    </span>
  );
}

interface SessionsTableProps {
  sessions: SessionState[];
  projectName: string;
  nameFilter: string;
  onNameFilterChange: (value: string) => void;
}

export default function SessionsTable({
  sessions,
  projectName,
  nameFilter,
  onNameFilterChange,
}: SessionsTableProps): React.JSX.Element {
  const confirmDelete = useConfirmDeleteSession();

  const columns = useMemo(
    () => [
      columnHelper.accessor("sessionName", {
        header: "Session",
        sortingFn: "alphanumeric",
        filterFn: "includesString",
        cell: ({ row }) => {
          const session = row.original;
          return (
            <Link
              href={`/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`}
              className="session-name-cell"
            >
              <span className="session-name">{session.sessionName}</span>
              {session.finished && (
                <span
                  className="cc-badge cc-badge--status cc-badge--subtle"
                  data-status="merged"
                >
                  merged
                </span>
              )}
              {session.creationMode === "focus" && (
                <span
                  className="cc-badge cc-badge--status"
                  data-status="active"
                >
                  focus
                </span>
              )}
              {session.creationMode === "optimistic" && (
                <span
                  className="cc-badge cc-badge--status"
                  data-status="active"
                >
                  optimistic
                </span>
              )}
              {session.creationMode === "fast" && (
                <span
                  className="cc-badge cc-badge--status"
                  data-status="active"
                >
                  fast
                </span>
              )}
            </Link>
          );
        },
      }),
      columnHelper.accessor("branchName", {
        header: "Branch",
        sortingFn: "alphanumeric",
        enableColumnFilter: false,
        cell: ({ getValue }) => (
          <span className="session-branch">{getValue()}</span>
        ),
      }),
      columnHelper.accessor(
        (row) => (row.finished ? "merged" : deriveSessionStatus(row)),
        {
          id: "status",
          header: "Status",
          sortingFn: statusSortingFn,
          enableColumnFilter: false,
          cell: ({ row }) => <StatusBadge session={row.original} />,
        },
      ),
      columnHelper.accessor("lastActivityAt", {
        header: "Last Activity",
        sortingFn: "datetime",
        enableColumnFilter: false,
        cell: ({ getValue }) => (
          <span className="session-time">{formatRelativeTime(getValue())}</span>
        ),
      }),
      columnHelper.accessor((row) => deriveSessionPromptCount(row), {
        id: "prompts",
        header: "Prompts",
        sortingFn: "basic",
        enableColumnFilter: false,
        cell: ({ getValue }) => (
          <span className="session-time">{getValue()}</span>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const session = row.original;
          return (
            <div
              style={{
                display: "flex",
                gap: "var(--space-xs)",
                alignItems: "center",
              }}
            >
              <SessionTddToggle projectName={projectName} session={session} />
              <ArchiveButton projectName={projectName} session={session} />
              <button
                className="btn btn-danger btn-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  confirmDelete({
                    sessionName: session.sessionName,
                    projectName,
                  });
                }}
              >
                Delete
              </button>
            </div>
          );
        },
      }),
    ],
    [projectName, confirmDelete],
  );

  const [sorting, setSorting] = useState<SortingState>([
    { id: "lastActivityAt", desc: true },
  ]);

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() =>
    nameFilter ? [{ id: "sessionName", value: nameFilter }] : [],
  );

  // Sync nameFilter prop into column filters
  const currentFilterValue =
    (columnFilters.find((f) => f.id === "sessionName")?.value as string) ?? "";
  if (currentFilterValue !== nameFilter) {
    setColumnFilters((prev) => {
      const without = prev.filter((f) => f.id !== "sessionName");
      if (nameFilter) {
        return [...without, { id: "sessionName", value: nameFilter }];
      }
      return without;
    });
  }

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: sessions,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableSortingRemoval: true,
  });

  return (
    <>
      <input
        type="text"
        className="sessions-filter-input"
        placeholder="Filter sessions…"
        value={nameFilter}
        onChange={(e) => onNameFilterChange(e.target.value)}
      />
      <table className="sessions-table">
        <thead>
          <tr>
            {table.getHeaderGroups().map((headerGroup) =>
              headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    className={canSort ? "sortable" : undefined}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                    {canSort && (
                      <SortIndicator direction={header.column.getIsSorted()} />
                    )}
                  </th>
                );
              }),
            )}
          </tr>
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.original.sessionName}
              className={row.original.archived ? "archived" : ""}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
