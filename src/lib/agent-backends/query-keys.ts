export const backendCatalogKeys = {
  all: ["agent-backends"] as const,
  catalog: () => [...backendCatalogKeys.all, "catalog"] as const,
};
