/**
 * Pure selection/render-state decisions for the /conversations page
 * (contracts §1.2, §6). Extracted from JSX so every page state and URL
 * rewrite is unit-testable without mocking.
 */

import type { ConversationListItem } from "@/lib/conversations/schemas";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";

/**
 * Single page-level layout key for /conversations. The page is a
 * cross-conversation, cross-session surface, so the selected layout (incl.
 * "panes") must persist for the page itself — not per active conversation.
 * Keying it page-level lets the layout survive activating a pane from a
 * different session, which would otherwise re-hydrate that session's saved
 * layout and drop out of panes.
 */
export const CONVERSATIONS_LAYOUT_STORAGE_KEY = "cc-conversations-layout";

export interface ConversationLookupSnapshot {
  isPending: boolean;
  isError: boolean;
  /** `null` is the lookup's distinguishable not-found (404) state. */
  data: ConversationListItem | null | undefined;
}

export interface AutoOpenSnapshot {
  /** Whether the active-conversations query has resolved. */
  isResolved: boolean;
  /** The row auto-open is about to apply via replaceState, if any. */
  candidateId: string | null;
}

export type ConversationsRenderState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error" }
  | { kind: "workspace"; conversation: ConversationListItem }
  | { kind: "empty" };

export function resolveConversationsRenderState(args: {
  conversationId: string | null;
  lookup: ConversationLookupSnapshot;
  autoOpen: AutoOpenSnapshot;
}): ConversationsRenderState {
  const { conversationId, lookup, autoOpen } = args;
  if (conversationId === null) {
    if (!autoOpen.isResolved || autoOpen.candidateId !== null) {
      return { kind: "loading" };
    }
    return { kind: "empty" };
  }
  if (lookup.data !== undefined && lookup.data !== null) {
    return { kind: "workspace", conversation: lookup.data };
  }
  if (lookup.data === null) return { kind: "not-found" };
  if (lookup.isError) return { kind: "error" };
  return { kind: "loading" };
}

export interface SessionFilter {
  projectName: string;
  sessionName: string;
}

/**
 * Most recent session-scoped row, restricted to the rail's session filter
 * when one is active (contracts §6.4). The active-conversations feed only
 * carries non-archived rows, so archived exclusion is inherent.
 */
export function selectAutoOpenCandidate(
  conversations: ActiveConversation[],
  sessionFilter: SessionFilter | null,
): string | null {
  let best: { id: string; at: number } | null = null;
  for (const row of conversations) {
    if (row.scope !== "session") continue;
    if (
      sessionFilter !== null &&
      (row.projectName !== sessionFilter.projectName ||
        row.sessionName !== sessionFilter.sessionName)
    ) {
      continue;
    }
    const at = Date.parse(row.lastActivityAt);
    if (best === null || at > best.at) best = { id: row.id, at };
  }
  return best?.id ?? null;
}

export type InitialSelection =
  | { kind: "url" }
  | { kind: "auto"; id: string }
  | { kind: "none" };

/**
 * Which conversation to select on page entry (§1.2, §1.8). First match wins:
 * an explicit `?c=` is user-initiated and left as-is; a session-filter entry
 * picks its session-scoped candidate; otherwise the live LRU tail (last-active)
 * is restored — deliberately ahead of the generic most-recent auto-open, but
 * never over an explicit URL or session filter. `auto` results are history-
 * replacing; `url` is left untouched.
 */
export function selectInitialConversation(input: {
  urlConversationId: string | null;
  sessionFilter: SessionFilter | null;
  persistedLruLive: string[];
  conversations: ActiveConversation[];
}): InitialSelection {
  const { urlConversationId, sessionFilter, persistedLruLive, conversations } =
    input;

  if (urlConversationId !== null) return { kind: "url" };

  if (sessionFilter !== null) {
    const id = selectAutoOpenCandidate(conversations, sessionFilter);
    return id !== null ? { kind: "auto", id } : { kind: "none" };
  }

  const lastId = persistedLruLive.at(-1);
  if (lastId !== undefined) return { kind: "auto", id: lastId };

  const id = selectAutoOpenCandidate(conversations, null);
  return id !== null ? { kind: "auto", id } : { kind: "none" };
}

export function isConversationPresent(
  conversations: ActiveConversation[],
  conversationId: string,
): boolean {
  return conversations.some((row) => row.id === conversationId);
}

function toHref(params: URLSearchParams): string {
  const query = params.toString();
  return query === "" ? "/conversations" : `/conversations?${query}`;
}

/**
 * Same-page switch (§1.2 pushState): select the new conversation and strip
 * autoFocus, which applies to the initially opened conversation only (§6.7).
 */
export function conversationSwitchUrl(
  current: URLSearchParams,
  conversationId: string,
): string {
  const next = new URLSearchParams(current);
  next.set("c", conversationId);
  next.delete("autoFocus");
  return toHref(next);
}

/** Auto-open (§6.4 replaceState): select without touching autoFocus. */
export function autoOpenUrl(
  current: URLSearchParams,
  conversationId: string,
): string {
  const next = new URLSearchParams(current);
  next.set("c", conversationId);
  return toHref(next);
}

/**
 * Disappearance fallback (§6.5 replaceState): the open conversation vanished,
 * so drop the selection (and the autoFocus that targeted it) and re-enter
 * auto-open.
 */
export function clearSelectionUrl(current: URLSearchParams): string {
  const next = new URLSearchParams(current);
  next.delete("c");
  next.delete("autoFocus");
  return toHref(next);
}

/**
 * Session-filter seeding strip (§6.6 replaceState): once the project+session
 * pair is copied into the rail's store filter, it leaves the URL.
 */
export function stripSessionFilterUrl(current: URLSearchParams): string {
  const next = new URLSearchParams(current);
  next.delete("project");
  next.delete("session");
  return toHref(next);
}
