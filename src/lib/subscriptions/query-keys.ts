export const subscriptionKeys = {
  all: ["subscriptions"] as const,
  overview: (query: object) =>
    [...subscriptionKeys.all, "overview", query] as const,
  inbox: (query: object) => [...subscriptionKeys.all, "inbox", query] as const,
  recipients: (query: object) =>
    [...subscriptionKeys.all, "recipients", query] as const,
  catalog: ["subscription-catalog"] as const,
  preferences: (conversationId: string) =>
    [...subscriptionKeys.all, "preferences", conversationId] as const,
};
