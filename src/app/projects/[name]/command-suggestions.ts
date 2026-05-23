import type { SessionListItem } from "@/types";
import type { FilterToken } from "./filter-tokens";

export type SuggestionKind = "action" | "filter";

export interface ActionSuggestion {
  kind: "action";
  id: "new" | "install-preset" | "capabilities" | "workflow-builder";
  label: string;
  grp: "Actions";
}

export interface FilterSuggestion {
  kind: "filter";
  cat: "archived" | "status" | "target";
  key: string;
  value: string;
  label: string;
  exclusive?: boolean;
  grp: "Filter";
}

export type Suggestion = ActionSuggestion | FilterSuggestion;

export interface ComputeSuggestionsInput {
  draft: string;
  tokens: FilterToken[];
  sessions: SessionListItem[];
  archivedCount: number;
}

const ACTIONS: ActionSuggestion[] = [
  {
    kind: "action",
    id: "new",
    label: "/new — Create new session",
    grp: "Actions",
  },
  {
    kind: "action",
    id: "install-preset",
    label: "/install-preset — Install a preset…",
    grp: "Actions",
  },
  {
    kind: "action",
    id: "capabilities",
    label: "/capabilities — Configure capabilities",
    grp: "Actions",
  },
  {
    kind: "action",
    id: "workflow-builder",
    label: "/workflow-builder — Open builder (new page)",
    grp: "Actions",
  },
];

const STATUS_VALUES = ["running", "awaiting", "new", "merged", "idle"] as const;

function countSessionsForStatus(
  sessions: SessionListItem[],
  status: string,
): number {
  if (status === "merged") {
    return sessions.filter((s) => s.finished).length;
  }
  return sessions.filter((s) => !s.finished && s.derivedStatus === status)
    .length;
}

export function computeSuggestions(
  input: ComputeSuggestionsInput,
): Suggestion[] {
  const { draft, tokens, sessions, archivedCount } = input;
  const trimmed = draft.trim();

  if (trimmed.startsWith("/")) {
    const q = trimmed.slice(1).toLowerCase();
    return ACTIONS.filter(
      (a) =>
        q.length === 0 || a.id.includes(q) || a.label.toLowerCase().includes(q),
    );
  }

  const lower = trimmed.toLowerCase();
  const out: Suggestion[] = [];

  const hasArchived = tokens.some((t) => t.cat === "archived");
  if (!hasArchived) {
    if (
      lower === "" ||
      "archived".includes(lower) ||
      "include".includes(lower)
    ) {
      out.push({
        kind: "filter",
        cat: "archived",
        key: "include",
        value: "include",
        label: "Include archived",
        grp: "Filter",
      });
      out.push({
        kind: "filter",
        cat: "archived",
        key: "only",
        value: "only",
        exclusive: true,
        label: `Show only archived (${archivedCount})`,
        grp: "Filter",
      });
    }
  }

  const hasStatus = tokens.some((t) => t.cat === "status");
  if (!hasStatus) {
    for (const st of STATUS_VALUES) {
      if (
        lower === "" ||
        st.includes(lower) ||
        "status".includes(lower) ||
        "is".includes(lower)
      ) {
        const c = countSessionsForStatus(sessions, st);
        out.push({
          kind: "filter",
          cat: "status",
          key: "is",
          value: st,
          label: `is:${st} · ${c}`,
          grp: "Filter",
        });
      }
    }
  }

  const hasTarget = tokens.some((t) => t.cat === "target");
  if (!hasTarget) {
    const targets = [...new Set(sessions.map((s) => s.targetBranch))];
    for (const t of targets) {
      if (
        lower === "" ||
        t.toLowerCase().includes(lower) ||
        "target".includes(lower)
      ) {
        out.push({
          kind: "filter",
          cat: "target",
          key: "target",
          value: t,
          label: `target:${t}`,
          grp: "Filter",
        });
      }
    }
  }

  return out.slice(0, 12);
}
