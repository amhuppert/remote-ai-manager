export const validationKeys = {
  all: ["validation"] as const,
  commands: () => [...validationKeys.all, "commands"] as const,
  /** Global capacity + active runs; the budget is not scoped to a project. */
  budget: () => [...validationKeys.all, "budget"] as const,
};
