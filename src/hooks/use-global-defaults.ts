"use client";

import { useMemo } from "react";
import { useFullConfigQuery } from "@/lib/config/queries";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { coerceGlobalDefaults } from "@/lib/workflow-graph/resolve-config";

export interface UseGlobalDefaultsResult {
  workflowDefaults: WorkflowDefaults;
  isLoading: boolean;
  isError: boolean;
}

export function useGlobalDefaults(): UseGlobalDefaultsResult {
  const query = useFullConfigQuery();

  // The SAME per-block coercion the server-side cascade applies, so the UI's
  // notion of the effective global layer can never drift from the resolver's.
  const workflowDefaults = useMemo<WorkflowDefaults>(
    () => coerceGlobalDefaults(query.data?.config.workflowDefaults),
    [query.data],
  );

  return {
    workflowDefaults,
    isLoading: query.isPending,
    isError: query.isError,
  };
}
