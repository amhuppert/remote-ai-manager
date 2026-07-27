"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalStorageValue } from "@react-hookz/web";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { closeTabSelection } from "@/lib/shared/close-tab-selection";
import {
  MAX_OPEN_TABS,
  emptyModel,
  openInSet,
  reconcile,
  // The model export is also named `closeTab`; alias it so the hook's own
  // `closeTab` method below does not shadow the pure reducer.
  closeTab as closeTabInModel,
  type OpenTabsModel,
} from "./open-tabs-model";

export const OPEN_TABS_STORAGE_KEY = "cc-open-tabs";

export interface OpenTabsApi {
  workingSet: SessionActiveConversation[];
  addableConversations: SessionActiveConversation[];
  activeId: string;
  isAtCap: boolean;
  /**
   * The persisted recency order (least → most recent) intersected with the live
   * session-scoped ids — the lru tail is the last-active conversation. `[]`
   * before hydration. The page-level selection hook reads this to restore the
   * last-active tab on entry (Requirement 1.8).
   */
  persistedLruLive: string[];
  /** True once the persisted model has loaded from localStorage. */
  hydrated: boolean;
  activate(id: string): void;
  closeTab(id: string): void;
  addTab(id: string): void;
}

interface UseOpenTabsInput {
  activeConversationId: string;
  activeConversations: SessionActiveConversation[];
  /**
   * Whether the active-conversations query has resolved. `activeConversations`
   * alone cannot distinguish "empty because the query is still loading" from
   * "genuinely empty", and the reconcile effect must NOT run against a
   * not-yet-loaded (transiently empty) list — doing so on first render would
   * drop every persisted tab and overwrite the persisted set with an empty one
   * (Requirement 1.8). The add-or-bump effect is unaffected by this flag.
   */
  activeConversationsLoaded: boolean;
  onOpenConversation: (t: { conversationId: string }) => void;
}

/**
 * Local guard for the persisted value: localStorage may hold JSON that does not
 * match `OpenTabsModel` (hand-edited, stale schema, corrupted). Anything that is
 * not `{ tabs: string[], lru: string[] }` is treated as `emptyModel()` (Error
 * Handling: malformed localStorage → emptyModel). Kept local so
 * `open-tabs-model.ts` stays schema-free.
 */
function isOpenTabsModel(v: unknown): v is OpenTabsModel {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as { tabs?: unknown; lru?: unknown };
  return (
    Array.isArray(candidate.tabs) &&
    candidate.tabs.every((t) => typeof t === "string") &&
    Array.isArray(candidate.lru) &&
    candidate.lru.every((t) => typeof t === "string")
  );
}

/**
 * Structural equality of the two ordered id lists. Returning the SAME object
 * reference from a `set` updater when nothing changed lets React/Object.is bail
 * out — no re-render, no localStorage write — which is what prevents the
 * reconcile/add effects from looping on every query refetch (the model
 * functions always return fresh objects).
 */
function sameModel(a: OpenTabsModel, b: OpenTabsModel): boolean {
  if (a === b) return true;
  if (a.tabs.length !== b.tabs.length || a.lru.length !== b.lru.length) {
    return false;
  }
  return (
    a.tabs.every((t, i) => t === b.tabs[i]) &&
    a.lru.every((t, i) => t === b.lru[i])
  );
}

function asModel(v: unknown): OpenTabsModel {
  return isOpenTabsModel(v) ? v : emptyModel();
}

export function useOpenTabs(input: UseOpenTabsInput): OpenTabsApi {
  const {
    activeConversationId,
    activeConversations,
    activeConversationsLoaded,
    onOpenConversation,
  } = input;

  // localStorage persistence (Requirement 1.8). Using localStorage (no server)
  // structurally satisfies Requirement 1.9: the working set never syncs across
  // browsers or devices.
  const { value, set } = useLocalStorageValue<OpenTabsModel>(
    OPEN_TABS_STORAGE_KEY,
    { defaultValue: emptyModel(), initializeWithValue: false },
  );

  // With `initializeWithValue: false`, `value` is `undefined` on the first
  // render and only becomes defined (the persisted model OR `defaultValue`)
  // once the mount-effect fetch lands — it is never `undefined` again. So
  // `value !== undefined` is a reliable "the persisted value has hydrated"
  // signal, and we use it to gate every commit below. Committing before
  // hydration would compute against `emptyModel()` and overwrite the persisted
  // multi-tab set with just the active id on reload (Requirement 1.8).
  const hydrated = value !== undefined;
  const model = asModel(value);

  // Authoritative model mirror. `@react-hookz`'s `set` resolves its functional
  // updater against its own internal state ref, which does NOT update between
  // two `set` calls in the same synchronous effect-flush — so a naive
  // updater-form `set` in the add effect followed by one in the reconcile
  // effect would have the second clobber the first with a stale base. Driving
  // every mutation through this ref makes back-to-back mutations in one pass
  // chain correctly, and keeps the persisted value as the source of truth on
  // re-render. Set during render so that once `value` hydrates the ref holds
  // the PERSISTED model before the gated effects re-run and chain off it.
  const modelRef = useRef<OpenTabsModel>(model);
  modelRef.current = model;

  // Apply a pure model transform: chain off the latest authoritative model,
  // skip when unchanged (same id lists) so React/Object.is bails out — no
  // re-render, no localStorage write — which keeps the reconcile effect from
  // looping on every query refetch (the model functions always return fresh
  // objects).
  const commit = useCallback(
    (transform: (base: OpenTabsModel) => OpenTabsModel) => {
      const base = modelRef.current;
      const next = transform(base);
      if (sameModel(base, next)) return;
      modelRef.current = next;
      set(next);
    },
    [set],
  );

  // Add-or-bump the active conversation. Gated on `hydrated` so it never
  // commits against `emptyModel()` before the persisted set has loaded;
  // `hydrated` is a dep so the effect re-runs (chaining off the restored model)
  // the moment hydration flips false → true. Otherwise deps are ONLY the active
  // id and the stable `commit` — never `model` — so this cannot loop.
  useEffect(() => {
    if (!hydrated || !activeConversationId) return;
    commit((base) => openInSet(base, activeConversationId));
  }, [hydrated, activeConversationId, commit]);

  const liveIdsKey = useMemo(
    () =>
      activeConversations
        .map((c) => c.id)
        .sort()
        .join(" "),
    [activeConversations],
  );
  const liveIds = useMemo(
    () => new Set(activeConversations.map((c) => c.id)),
    [activeConversations],
  );

  // Reconcile against the live session-scoped list (Requirement 1.7). Keyed on
  // the live id SET (`liveIdsKey`) rather than the array identity so it only
  // runs when the membership actually changes, not on every refetch. `liveIds`
  // is referenced via closure and is consistent with `liveIdsKey`. Gated on
  // `hydrated` so reconcile never runs against `emptyModel()` before the
  // persisted set has loaded, AND on `activeConversationsLoaded` so it never
  // runs against a not-yet-resolved (transiently empty) live list — on first
  // render the query is still loading, the list is `[]`, and reconciling
  // against it would drop every tab and persist an empty set (Requirement 1.8).
  // `activeConversationsLoaded` is a dep so reconcile re-runs once the live list
  // resolves, still dropping genuinely-stale tabs (Requirement 1.7).
  useEffect(() => {
    if (!hydrated || !activeConversationsLoaded) return;
    // Never reconcile away the conversation the user is actively viewing. The
    // live feed is eventually-consistent: a just-created conversation (e.g. a
    // new session's initial conversation) can be the active id before it has
    // propagated into the feed. Dropping it here would strand it out of the
    // working set until the user re-navigates — the add-or-bump effect only
    // re-runs when the active id changes, so a dropped active tab would never
    // return on its own. Preserving it lets the tab/pane render the moment the
    // feed catches up. A genuinely-gone active id is cleared upstream (the page
    // strips ?c= on disappearance), after which reconcile drops it normally.
    const preserved =
      activeConversationId === ""
        ? liveIds
        : new Set(liveIds).add(activeConversationId);
    commit((base) => reconcile(base, preserved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hydrated,
    activeConversationsLoaded,
    liveIdsKey,
    activeConversationId,
    commit,
  ]);

  const byId = useMemo(
    () => new Map(activeConversations.map((c) => [c.id, c])),
    [activeConversations],
  );

  const workingSet = useMemo(
    () =>
      model.tabs
        .map((id) => byId.get(id))
        .filter((c): c is SessionActiveConversation => c !== undefined),
    [model.tabs, byId],
  );

  const addableConversations = useMemo(
    () => activeConversations.filter((c) => !model.tabs.includes(c.id)),
    [activeConversations, model.tabs],
  );

  // Recency order restricted to the live session-scoped ids, preserving the
  // persisted least→most-recent ordering (stale ids are dropped). `[]` before
  // hydration because `model` is `emptyModel()` until `value` lands.
  const persistedLruLive = useMemo(
    () => model.lru.filter((id) => byId.has(id)),
    [model.lru, byId],
  );

  const isAtCap = workingSet.length >= MAX_OPEN_TABS;

  const activate = useCallback(
    (id: string) => {
      onOpenConversation({ conversationId: id });
    },
    [onOpenConversation],
  );

  const addTab = useCallback(
    (id: string) => {
      if (isAtCap) return;
      commit((base) => openInSet(base, id));
      onOpenConversation({ conversationId: id });
    },
    [commit, isAtCap, onOpenConversation],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (id === activeConversationId) {
        // Closing the active tab: activate a neighbor FIRST (the entry before
        // it in display order, else the entry after it), then remove it. Closing
        // the only tab has no neighbor and leaves the working set empty.
        const nextSelection = closeTabSelection(model.tabs, id);
        if (nextSelection !== null) {
          onOpenConversation({ conversationId: nextSelection });
        }
      }
      commit((base) => closeTabInModel(base, id));
    },
    [activeConversationId, model.tabs, onOpenConversation, commit],
  );

  return {
    workingSet,
    addableConversations,
    activeId: activeConversationId,
    isAtCap,
    persistedLruLive,
    hydrated,
    activate,
    closeTab,
    addTab,
  };
}
