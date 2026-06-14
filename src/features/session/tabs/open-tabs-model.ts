/**
 * Pure working-set reducer for the /conversations open-conversations model
 * (requirements §1.5–1.7, §2.7). Two coupled orders describe one set of
 * conversation ids: `tabs` is the stable display order; `lru` is the recency
 * order (least → most recently active). Both always hold the same id set.
 *
 * Sequence-driven and side-effect-free (no Date/random, no input mutation) so
 * the working-set behavior is deterministically unit-testable.
 */

export const MAX_OPEN_TABS = 6;

export interface OpenTabsModel {
  /** Stable display order; insertion order, never reordered by bump/evict. */
  readonly tabs: string[];
  /** Recency order, least → most recently active. */
  readonly lru: string[];
}

export function emptyModel(): OpenTabsModel {
  return { tabs: [], lru: [] };
}

/**
 * Open `id`: append it (display) and mark it most-recently-active (recency) if
 * absent; if already present, leave display order untouched and only bump it to
 * the most-recent end of `lru`. When adding would grow the set past
 * MAX_OPEN_TABS, evict the least-recently-active id (`lru[0]`) from both orders
 * first. The just-opened id is added after eviction, so it can never be the
 * victim.
 */
export function openInSet(model: OpenTabsModel, id: string): OpenTabsModel {
  if (model.tabs.includes(id)) {
    return { tabs: [...model.tabs], lru: bump(model.lru, id) };
  }

  if (model.tabs.length < MAX_OPEN_TABS) {
    return { tabs: [...model.tabs, id], lru: [...model.lru, id] };
  }

  const victim = model.lru[0];
  if (victim === undefined) {
    return { tabs: [id], lru: [id] };
  }
  return {
    tabs: [...model.tabs.filter((t) => t !== victim), id],
    lru: [...model.lru.filter((t) => t !== victim), id],
  };
}

/** Remove `id` from both orders; a no-op when `id` is absent. */
export function closeTab(model: OpenTabsModel, id: string): OpenTabsModel {
  return {
    tabs: model.tabs.filter((t) => t !== id),
    lru: model.lru.filter((t) => t !== id),
  };
}

/**
 * Drop from both orders any id not in `liveIds`, preserving the relative order
 * of survivors (requirements §1.7).
 */
export function reconcile(
  model: OpenTabsModel,
  liveIds: ReadonlySet<string>,
): OpenTabsModel {
  return {
    tabs: model.tabs.filter((t) => liveIds.has(t)),
    lru: model.lru.filter((t) => liveIds.has(t)),
  };
}

function bump(lru: readonly string[], id: string): string[] {
  return [...lru.filter((t) => t !== id), id];
}
