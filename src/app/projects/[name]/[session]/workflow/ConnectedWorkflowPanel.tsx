"use client";

import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { workflowKeys } from "@/lib/query-keys";
import { useWorkflowQuery } from "@/lib/queries";
import {
  useStartWorkflowMutation,
  useUpdateWorkflowObjectiveMutation,
  useConfirmWorkflowMutation,
  usePauseWorkflowMutation,
  useResumeWorkflowMutation,
  useAbortWorkflowMutation,
  useUpdateFixPlanMutation,
  useGeneratePlanMutation,
  useUpdateWorkflowConfigMutation,
} from "@/lib/mutations";
import WorkflowPanel from "./WorkflowPanel";
import type { FixPlanTask } from "@/types";

interface ConnectedWorkflowPanelProps {
  projectName: string;
  sessionName: string;
}

export default function ConnectedWorkflowPanel({
  projectName,
  sessionName,
}: ConnectedWorkflowPanelProps) {
  const queryClient = useQueryClient();
  const workflowQuery = useWorkflowQuery(projectName, sessionName);
  const workflow = workflowQuery.data ?? null;

  // Mutations
  const startMutation = useStartWorkflowMutation(projectName, sessionName);
  const confirmMutation = useConfirmWorkflowMutation(projectName, sessionName);
  const pauseMutation = usePauseWorkflowMutation(projectName, sessionName);
  const resumeMutation = useResumeWorkflowMutation(projectName, sessionName);
  const abortMutation = useAbortWorkflowMutation(projectName, sessionName);
  const updateFixPlanMutation = useUpdateFixPlanMutation(
    projectName,
    sessionName,
  );
  const generatePlanMutation = useGeneratePlanMutation(
    projectName,
    sessionName,
  );
  const updateObjectiveMutation = useUpdateWorkflowObjectiveMutation(
    projectName,
    sessionName,
  );
  const updateConfigMutation = useUpdateWorkflowConfigMutation(
    projectName,
    sessionName,
  );

  // Local objective state for debounced editing
  const [localObjective, setLocalObjective] = useState<string | null>(null);
  const displayedObjective = localObjective ?? workflow?.objective ?? "";

  const handleActivate = useCallback(() => {
    startMutation.mutate(undefined);
  }, [startMutation]);

  const handleObjectiveChange = useCallback((value: string) => {
    setLocalObjective(value);
    // Persist objective by updating the workflow config
    // The objective is stored on the workflow entity, updated via the main workflow route
    // For now, we'll persist it when confirming start. The local state handles editing.
  }, []);

  const handleConfirmStart = useCallback(() => {
    const objectiveToSave =
      localObjective !== null ? localObjective : workflow?.objective;
    if (objectiveToSave && objectiveToSave !== workflow?.objective) {
      // Persist the edited objective, then confirm
      updateObjectiveMutation.mutate(objectiveToSave, {
        onSuccess: () => {
          confirmMutation.mutate();
          setLocalObjective(null);
        },
      });
    } else {
      confirmMutation.mutate();
      setLocalObjective(null);
    }
  }, [confirmMutation, updateObjectiveMutation, workflow, localObjective]);

  const handlePause = useCallback(() => {
    pauseMutation.mutate();
  }, [pauseMutation]);

  const handleResume = useCallback(() => {
    resumeMutation.mutate();
  }, [resumeMutation]);

  const handleAbort = useCallback(() => {
    abortMutation.mutate();
  }, [abortMutation]);

  const handleTaskAdd = useCallback(
    (description: string) => {
      if (!workflow) return;
      const maxGroup =
        workflow.fixPlan.length > 0
          ? Math.max(...workflow.fixPlan.map((t) => t.group))
          : 1;
      const newTask: FixPlanTask = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description,
        group: maxGroup,
        status: "pending",
        createdAt: new Date().toISOString(),
        completedAt: null,
        skipReason: null,
        addedByIteration: null,
      };
      const updatedPlan = [...workflow.fixPlan, newTask];
      updateFixPlanMutation.mutate(updatedPlan);
    },
    [workflow, updateFixPlanMutation],
  );

  const handleTaskRemove = useCallback(
    (taskId: string) => {
      if (!workflow) return;
      const updatedPlan = workflow.fixPlan.filter((t) => t.id !== taskId);
      updateFixPlanMutation.mutate(updatedPlan);
    },
    [workflow, updateFixPlanMutation],
  );

  const handleTaskEdit = useCallback(
    (taskId: string, description: string) => {
      if (!workflow) return;
      const updatedPlan = workflow.fixPlan.map((t) =>
        t.id === taskId ? { ...t, description } : t,
      );
      updateFixPlanMutation.mutate(updatedPlan);
    },
    [workflow, updateFixPlanMutation],
  );

  const handleTaskReorder = useCallback(
    (taskIds: string[]) => {
      if (!workflow) return;
      const taskMap = new Map(workflow.fixPlan.map((t) => [t.id, t]));
      const reordered = taskIds
        .map((id) => taskMap.get(id))
        .filter((t): t is FixPlanTask => t != null);
      updateFixPlanMutation.mutate(reordered);
    },
    [workflow, updateFixPlanMutation],
  );

  const handleGeneratePlan = useCallback(() => {
    const startGeneration = () => {
      generatePlanMutation.mutate();
      // Poll for updates since plan generation is async
      const pollInterval = setInterval(() => {
        void queryClient.invalidateQueries({
          queryKey: workflowKeys.status(projectName, sessionName),
        });
      }, 2000);
      // Stop polling after 10.5 minutes (generation has 10 min timeout)
      setTimeout(() => clearInterval(pollInterval), 630_000);
    };

    // Persist the objective before generating so the backend has it
    const objectiveToSave =
      localObjective !== null ? localObjective : workflow?.objective;
    if (objectiveToSave && objectiveToSave !== workflow?.objective) {
      updateObjectiveMutation.mutate(objectiveToSave, {
        onSuccess: () => {
          setLocalObjective(null);
          startGeneration();
        },
      });
    } else {
      startGeneration();
    }
  }, [
    generatePlanMutation,
    updateObjectiveMutation,
    queryClient,
    projectName,
    sessionName,
    localObjective,
    workflow,
  ]);

  const handleConfigChange = useCallback(
    (config: import("@/types").RalphLoopConfig) => {
      updateConfigMutation.mutate(config);
    },
    [updateConfigMutation],
  );

  const handleResetCircuitBreaker = useCallback(() => {
    if (!workflow) return;
    // Reset circuit breaker and resume by calling resume (which handles halted state)
    updateConfigMutation.mutate({
      ...workflow.config,
    });
    resumeMutation.mutate();
  }, [workflow, updateConfigMutation, resumeMutation]);

  // Build a workflow object with local edits for the presentational component
  const displayWorkflow = workflow
    ? { ...workflow, objective: displayedObjective }
    : null;

  return (
    <WorkflowPanel
      projectName={projectName}
      sessionName={sessionName}
      workflow={displayWorkflow}
      onActivate={handleActivate}
      onObjectiveChange={handleObjectiveChange}
      onConfirmStart={handleConfirmStart}
      onPause={handlePause}
      onResume={handleResume}
      onAbort={handleAbort}
      onTaskAdd={handleTaskAdd}
      onTaskRemove={handleTaskRemove}
      onTaskEdit={handleTaskEdit}
      onTaskReorder={handleTaskReorder}
      onGeneratePlan={handleGeneratePlan}
      onConfigChange={handleConfigChange}
      onResetCircuitBreaker={handleResetCircuitBreaker}
      isGenerating={
        generatePlanMutation.isPending || workflow?.generatingPlan === true
      }
      isConfirming={
        confirmMutation.isPending || updateObjectiveMutation.isPending
      }
    />
  );
}
