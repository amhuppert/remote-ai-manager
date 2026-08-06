export const validationKeys = {
  all: ["validation"] as const,
  commands: () => [...validationKeys.all, "commands"] as const,
};
