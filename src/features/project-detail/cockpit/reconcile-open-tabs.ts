/**
 * Pure reconciliation of the cockpit's tab view-state against the foundation's
 * authoritative open-conversation list. The server decides *which* conversations
 * are open; this function layers the client's *ordering* and *active selection*
 * on top, and signals when the page should fall back to first-run.
 *
 * Rules:
 * - Existing tabs that are still open keep their current order.
 * - Newly-open conversations are appended (in server order) after existing ones.
 * - Tabs that are no longer open are dropped.
 * - The active tab is preserved if still open; otherwise the first remaining
 *   open tab becomes active.
 * - When no open conversations remain, `firstRun` is `true` and `activeTabId`
 *   is `null` — the page returns to the first-run layout.
 */
export interface OpenTabsState {
  openTabIds: string[];
  activeTabId: string | null;
}

export interface ReconcileResult {
  openTabIds: string[];
  activeTabId: string | null;
  firstRun: boolean;
}

export function reconcileOpenTabs(
  serverOpenIds: readonly string[],
  current: OpenTabsState,
): ReconcileResult {
  const serverSet = new Set(serverOpenIds);

  // Preserve existing order for tabs that remain open.
  const kept = current.openTabIds.filter((id) => serverSet.has(id));
  const keptSet = new Set(kept);

  // Append newly-open ids (in server order) that we are not already tracking.
  const appended = serverOpenIds.filter((id) => !keptSet.has(id));

  const openTabIds = [...kept, ...appended];

  if (openTabIds.length === 0) {
    return { openTabIds, activeTabId: null, firstRun: true };
  }

  const activeStillOpen =
    current.activeTabId !== null && serverSet.has(current.activeTabId);
  const activeTabId = activeStillOpen ? current.activeTabId : openTabIds[0]!;

  return { openTabIds, activeTabId, firstRun: false };
}
