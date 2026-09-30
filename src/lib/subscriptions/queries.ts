"use client";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { subscriptionKeys } from "./query-keys";
import {
  subscriptionOverviewSchema,
  inboxOverviewSchema,
  subscriptionRecipientsSchema,
  subscriptionCatalogSchema,
  inboxPreferencesSchema,
  type SubscriptionScope,
  type SubscriptionOverviewQuery,
  type InboxOverviewQuery,
} from "./controls-schemas";
export function subscriptionQueryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  return params.toString();
}
export function useSubscriptionOverview(
  query: SubscriptionOverviewQuery,
  enabled = true,
) {
  return useQuery({
    queryKey: subscriptionKeys.overview(query),
    queryFn: () =>
      apiFetch(
        `/api/subscriptions/overview?${subscriptionQueryString(query)}`,
        subscriptionOverviewSchema,
      ),
    enabled,
  });
}
export function useSubscriptionInbox(
  query: InboxOverviewQuery,
  enabled = true,
) {
  return useQuery({
    queryKey: subscriptionKeys.inbox(query),
    queryFn: () =>
      apiFetch(
        `/api/subscriptions/inbox?${subscriptionQueryString(query)}`,
        inboxOverviewSchema,
      ),
    enabled,
  });
}
export function useSubscriptionRecipients(
  query: SubscriptionScope & { q?: string; offset?: number; limit?: number },
  enabled = true,
) {
  return useQuery({
    queryKey: subscriptionKeys.recipients(query),
    queryFn: () =>
      apiFetch(
        `/api/subscriptions/recipients?${subscriptionQueryString(query)}`,
        subscriptionRecipientsSchema,
      ),
    enabled,
  });
}
export function useSubscriptionCatalog(enabled = true) {
  return useQuery({
    queryKey: subscriptionKeys.catalog,
    queryFn: () =>
      apiFetch("/api/subscriptions/catalog", subscriptionCatalogSchema),
    staleTime: Infinity,
    enabled,
  });
}
export function useInboxPreferences(target: ConversationTarget | undefined) {
  return useQuery({
    queryKey: subscriptionKeys.preferences(target?.conversationId ?? ""),
    queryFn: () => {
      if (!target) throw new Error("Conversation required");
      return apiFetch(
        `${conversationTargetApiBase(target)}/inbox/preferences`,
        inboxPreferencesSchema,
      );
    },
    enabled: target !== undefined,
  });
}
