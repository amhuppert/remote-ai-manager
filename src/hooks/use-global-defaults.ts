"use client";

import { useMemo } from "react";
import { useFullConfigQuery } from "@/lib/queries";
import type { WorkflowDefaults } from "@/types";

const SEEDED_DEFAULTS: WorkflowDefaults = {
  implementer: {
    backend: "claude",
    model: "opus",
    reasoningEffort: "medium",
  },
  contextValidator: {
    type: "claude",
    enabled: true,
    continuity: { enabled: true },
    agent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
  },
  scriptValidator: {
    enabled: false,
  },
  iterationPolicy: {
    maxIterations: 20,
    continuity: { enabled: true },
  },
  circuitBreaker: {
    consecutiveFailureThreshold: 3,
  },
  mutability: {
    allowAgentTaskAdd: false,
  },
};

export interface UseGlobalDefaultsResult {
  workflowDefaults: WorkflowDefaults;
  isLoading: boolean;
  isError: boolean;
}

export function useGlobalDefaults(): UseGlobalDefaultsResult {
  const query = useFullConfigQuery();

  const workflowDefaults = useMemo<WorkflowDefaults>(() => {
    const defaults = query.data?.config.workflowDefaults;
    if (!defaults) return SEEDED_DEFAULTS;
    return {
      implementer: defaults.implementer ?? SEEDED_DEFAULTS.implementer,
      contextValidator:
        defaults.contextValidator ?? SEEDED_DEFAULTS.contextValidator,
      scriptValidator:
        defaults.scriptValidator ?? SEEDED_DEFAULTS.scriptValidator,
      iterationPolicy:
        defaults.iterationPolicy ?? SEEDED_DEFAULTS.iterationPolicy,
      circuitBreaker: defaults.circuitBreaker ?? SEEDED_DEFAULTS.circuitBreaker,
      mutability: defaults.mutability ?? SEEDED_DEFAULTS.mutability,
    };
  }, [query.data]);

  return {
    workflowDefaults,
    isLoading: query.isPending,
    isError: query.isError,
  };
}
