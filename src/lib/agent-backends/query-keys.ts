export const backendCatalogKeys = {
  all: ["agent-backends"] as const,
  catalog: () => [...backendCatalogKeys.all, "catalog"] as const,
  /** Project-scoped model options; varies with the project's configuration. */
  projectModelOptions: (projectName: string) =>
    [...backendCatalogKeys.all, "model-options", projectName] as const,
};
