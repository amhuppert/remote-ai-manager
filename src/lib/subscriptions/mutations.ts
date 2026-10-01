"use client";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import {
  subscriptionDetailSchema,
  inboxPreferencesSchema,
  type SubscriptionControlRequest,
  type SubscribeRequest,
} from "./controls-schemas";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "./schemas";
import { subscriptionKeys } from "./query-keys";
export function useSubscriptionControl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      target: ConversationTarget;
      id: string;
      action: SubscriptionControlRequest | { action: "unfollow" };
    }) => {
      const url = `${conversationTargetApiBase(input.target)}/subscriptions/${encodeURIComponent(input.id)}`;
      return input.action.action === "unfollow"
        ? mutationFetch(
            url,
            "subscriptions.unfollow",
            { method: "DELETE" },
            z.object({ subscription: conversationSubscriptionSchema }),
          )
        : mutationFetch(
            url,
            "subscriptions.control",
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input.action),
            },
            subscriptionDetailSchema,
          );
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
export function useCreateSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      target: ConversationTarget;
      subscription: SubscribeRequest;
    }) =>
      mutationFetch(
        `${conversationTargetApiBase(input.target)}/subscriptions`,
        "subscriptions.create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.subscription),
        },
        subscriptionDetailSchema,
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
export function useMarkSubscriptionRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      target: ConversationTarget;
      id: string;
      read: boolean;
    }) =>
      mutationFetch(
        `${conversationTargetApiBase(input.target)}/inbox/${encodeURIComponent(input.id)}/read`,
        "subscriptions.read",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: input.read }),
        },
        z.object({ readAt: z.string().nullable() }),
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
export function useReviewSubscriptionDelivery() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      target: ConversationTarget;
      id: string;
      action: "retry" | "dismiss";
    }) =>
      mutationFetch(
        `${conversationTargetApiBase(input.target)}/inbox/${encodeURIComponent(input.id)}/read`,
        "subscriptions.review",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: input.action }),
        },
        z.object({ delivery: subscriptionDeliverySchema }),
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
export function useSetInboxHints() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      target: ConversationTarget;
      hintsEnabled: boolean;
    }) =>
      mutationFetch(
        `${conversationTargetApiBase(input.target)}/inbox/preferences`,
        "subscriptions.hints",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hintsEnabled: input.hintsEnabled }),
        },
        inboxPreferencesSchema,
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: subscriptionKeys.all }),
  });
}
