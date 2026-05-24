export const configKeys = {
  all: ["config"] as const,
  full: () => [...configKeys.all, "full"] as const,
};
