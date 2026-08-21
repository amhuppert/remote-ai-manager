import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { validationBudgetResponseSchema } from "@/lib/validation/api-schemas";
import {
  buildValidationBudgetView,
  type ValidationBudgetView,
} from "@/lib/validation/budget-view";
import { validationKeys } from "@/lib/validation/query-keys";
import {
  validationCommandsResponseSchema,
  type ValidationCommandsResponse,
  type ValidationCommandSummary,
} from "@/lib/validation/schemas";

export function useValidationCommandsQuery() {
  return useQuery({
    queryKey: validationKeys.commands(),
    queryFn: () =>
      apiFetch("/api/validation-commands", validationCommandsResponseSchema),
    // Registries change on the timescale of editing CommandCenter.json by
    // hand; a short window keeps panel switches from refetching constantly.
    staleTime: 60_000,
  });
}

/**
 * Global validation budget for the topbar indicator.
 *
 * No `refetchInterval`: the validation service already publishes a
 * `validation-run` event at every lifecycle phase, and
 * `registerValidationSseReactions` invalidates this key from them. The
 * `staleTime` only governs remounts (navigating between pages) — SSE
 * invalidation refetches an observed query regardless of it.
 */
export function useValidationBudgetQuery() {
  return useQuery({
    queryKey: validationKeys.budget(),
    queryFn: () =>
      apiFetch("/api/validation-budget", validationBudgetResponseSchema),
    staleTime: 30_000,
  });
}

/** The rendered budget, or null when there is nothing worth showing. */
export function useValidationBudgetView(): ValidationBudgetView | null {
  const { data } = useValidationBudgetQuery();
  return useMemo(
    () => (data === undefined ? null : buildValidationBudgetView(data)),
    [data],
  );
}

/**
 * Project the registry response into multi-select options for one scope.
 *
 * - `undefined` data (loading/error) → `undefined`: the registry is
 *   unavailable and editors fall back to free-form name entry.
 * - A named project missing from the response → `undefined` for the same
 *   reason (its config was unreadable, not empty).
 * - `projectName: null` (global scope) → the union across projects, deduped
 *   by name (first project's cost/description wins) and sorted, because a
 *   global default may legitimately reference any project's command.
 */
export function selectValidationCommandOptions(
  data: ValidationCommandsResponse | undefined,
  projectName: string | null,
): readonly ValidationCommandSummary[] | undefined {
  if (!data) return undefined;
  if (projectName !== null) {
    const project = data.projects.find(
      (entry) => entry.projectName === projectName,
    );
    return project ? project.commands : undefined;
  }
  const byName = new Map<string, ValidationCommandSummary>();
  for (const project of data.projects) {
    for (const command of project.commands) {
      if (!byName.has(command.name)) byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Registry options for one scope; `undefined` while unavailable. */
export function useValidationCommandOptions(
  projectName: string | null,
): readonly ValidationCommandSummary[] | undefined {
  const { data } = useValidationCommandsQuery();
  return useMemo(
    () => selectValidationCommandOptions(data, projectName),
    [data, projectName],
  );
}
