import type { SessionListItem, DerivedSessionStatus } from "@/types";
import type { FilterToken } from "./filter-tokens";

type SortableColumn =
  | "sessionName"
  | "branchName"
  | "targetBranch"
  | "status"
  | "promptCount"
  | "lastActivityAt";

export interface SortState {
  id: SortableColumn;
  desc: boolean;
}

const STATUS_ORDER: DerivedSessionStatus[] = [
  "new",
  "running",
  "awaiting",
  "waiting_for_input",
  "idle",
];

function statusSortKey(s: SessionListItem): number {
  if (s.finished) return STATUS_ORDER.length;
  const idx = STATUS_ORDER.indexOf(s.derivedStatus);
  return idx === -1 ? STATUS_ORDER.length - 1 : idx;
}

function tokenOf(
  tokens: FilterToken[],
  cat: FilterToken["cat"],
): FilterToken | undefined {
  return tokens.find((t) => t.cat === cat);
}

export function applyFilters(
  sessions: SessionListItem[],
  tokens: FilterToken[],
  draft: string,
): SessionListItem[] {
  const archivedTok = tokenOf(tokens, "archived");
  const statusTok = tokenOf(tokens, "status");
  const targetTok = tokenOf(tokens, "target");
  const branchTok = tokenOf(tokens, "branch");

  const trimmed = draft.trim();
  const freeText =
    trimmed.length > 0 && !trimmed.startsWith("/") ? trimmed.toLowerCase() : "";

  return sessions.filter((s) => {
    if (archivedTok) {
      if (archivedTok.exclusive && !s.archived) return false;
    } else if (s.archived) {
      return false;
    }

    if (statusTok) {
      if (statusTok.value === "merged") {
        if (!s.finished) return false;
      } else if (s.derivedStatus !== statusTok.value) {
        return false;
      }
    }

    if (targetTok && s.targetBranch !== targetTok.value) return false;

    if (
      branchTok &&
      !s.branchName.toLowerCase().includes(branchTok.value.toLowerCase())
    ) {
      return false;
    }

    if (freeText.length > 0) {
      const name = s.sessionName.toLowerCase();
      const branch = s.branchName.toLowerCase();
      if (!name.includes(freeText) && !branch.includes(freeText)) return false;
    }

    return true;
  });
}

function compare(
  a: SessionListItem,
  b: SessionListItem,
  sort: SortState,
): number {
  const dir = sort.desc ? -1 : 1;
  switch (sort.id) {
    case "status":
      return (statusSortKey(a) - statusSortKey(b)) * dir;
    case "promptCount":
      return (a.promptCount - b.promptCount) * dir;
    case "lastActivityAt":
      return (
        (Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt)) * dir
      );
    case "sessionName":
      return a.sessionName.localeCompare(b.sessionName) * dir;
    case "branchName":
      return a.branchName.localeCompare(b.branchName) * dir;
    case "targetBranch":
      return a.targetBranch.localeCompare(b.targetBranch) * dir;
  }
}

export function applySort(
  sessions: SessionListItem[],
  sort: SortState,
): SessionListItem[] {
  const arr = [...sessions];
  arr.sort((a, b) => compare(a, b, sort));
  return arr;
}
