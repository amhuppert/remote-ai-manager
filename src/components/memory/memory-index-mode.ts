import type { MemoryIndexMode } from "@/lib/memory/schemas";

/**
 * How each stored index mode reads on screen. "Always" is a priority within
 * the budget, not a guarantee: scope, freshness, and the conversation's
 * delivery policy still decide, so the copy never promises more than that.
 */
export const MEMORY_INDEX_MODES: Record<
  MemoryIndexMode,
  { label: string; description: string }
> = {
  always: {
    label: "Always",
    description: "Prioritized for inclusion within the available index budget.",
  },
  auto: {
    label: "Auto",
    description: "Included automatically when space is available.",
  },
  "search-only": {
    label: "Search only",
    description:
      "Kept out of the index; available through search and direct lookup.",
  },
};

export const MEMORY_INDEX_MODE_ORDER: readonly MemoryIndexMode[] = [
  "always",
  "auto",
  "search-only",
];

export function isMemoryIndexMode(value: string): value is MemoryIndexMode {
  return Object.hasOwn(MEMORY_INDEX_MODES, value);
}
