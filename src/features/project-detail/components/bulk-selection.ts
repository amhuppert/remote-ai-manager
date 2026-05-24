import type { SessionListItem } from "@/lib/sessions/schemas";
type SelectableSession = Pick<SessionListItem, "sessionName" | "archived">;

export function selectedBulkActionKind(
  selected: ReadonlySet<string>,
  sessions: readonly SelectableSession[],
): "archive" | "unarchive" {
  if (selected.size === 0) return "archive";
  const byName = new Map(sessions.map((s) => [s.sessionName, s] as const));
  let sawArchived = false;
  for (const name of selected) {
    const session = byName.get(name);
    if (!session) continue;
    if (!session.archived) return "archive";
    sawArchived = true;
  }
  return sawArchived ? "unarchive" : "archive";
}

export function pruneMissingSelections(
  selected: ReadonlySet<string>,
  sessions: readonly SelectableSession[],
): Set<string> {
  const present = new Set(sessions.map((s) => s.sessionName));
  let allPresent = true;
  for (const name of selected) {
    if (!present.has(name)) {
      allPresent = false;
      break;
    }
  }
  if (allPresent) return selected as Set<string>;
  const next = new Set<string>();
  for (const name of selected) if (present.has(name)) next.add(name);
  return next;
}
