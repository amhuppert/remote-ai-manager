export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  preferences: () => [...projectKeys.all, "preferences"] as const,
};
