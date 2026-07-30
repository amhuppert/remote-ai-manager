"use client";

import { useMemo } from "react";
import { useFullConfigQuery } from "@/lib/config/queries";
import type { WorkflowDefaults } from "@/lib/config/schemas";
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
  humanApprovalGate: {
    enabled: false,
  },
  askUserQuestions: {
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
  planRepair: {
    enabled: true,
    maxAttemptsPerContext: 2,
  },
  collaboration: {
    enabled: false,
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
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
      humanApprovalGate:
        defaults.humanApprovalGate ?? SEEDED_DEFAULTS.humanApprovalGate,
      askUserQuestions:
        defaults.askUserQuestions ?? SEEDED_DEFAULTS.askUserQuestions,
      iterationPolicy:
        defaults.iterationPolicy ?? SEEDED_DEFAULTS.iterationPolicy,
      circuitBreaker: defaults.circuitBreaker ?? SEEDED_DEFAULTS.circuitBreaker,
      mutability: defaults.mutability ?? SEEDED_DEFAULTS.mutability,
      planRepair: defaults.planRepair ?? SEEDED_DEFAULTS.planRepair,
      collaboration: defaults.collaboration ?? SEEDED_DEFAULTS.collaboration,
    };
  }, [query.data]);

  return {
    workflowDefaults,
    isLoading: query.isPending,
    isError: query.isError,
  };
}
