"use client";

import { useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import type {
  GraphWorkflowExecution,
  GraphWorkflowVisualLayout,
} from "@/types";
import ExecutionStatusBar from "./ExecutionStatusBar";
import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";

interface GraphWorkflowPanelProps {
  execution: GraphWorkflowExecution | null;
  archivedExecutions: GraphWorkflowExecution[];
  layout: GraphWorkflowVisualLayout | null;
  onPause(): void;
  onResume(): void;
  onAbort(): void;
  onClear(): void;
  onAddTask(contextId: string, title: string, instructions: string): void;
  onUpdateTask(
    taskId: string,
    updates: { title?: string; instructions?: string },
  ): void;
  onRemoveTask(taskId: string): void;
  onMoveTask(
    taskId: string,
    targetContextId: string,
    targetOrder: number,
  ): void;
  onReorderTask(contextId: string, orderedTaskIds: string[]): void;
  isMutating: boolean;
}

export default function GraphWorkflowPanel({
  execution,
  layout,
  onPause,
  onResume,
  onAbort,
  onClear,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  isMutating,
}: GraphWorkflowPanelProps) {
  const [selectedContextId, setSelectedContextId] = useState<string | null>(
    null,
  );

  const mergedLayout = useMemo(() => {
    if (!execution) return null;
    return generateWorkflowLayout(execution.workingDefinition, layout ?? null);
  }, [execution, layout]);

  if (!execution) {
    return (
      <div className="wb-empty-state">
        <span className="wb-empty-state-text">
          No graph workflow execution has started for this session.
        </span>
      </div>
    );
  }

  if (!mergedLayout) {
    return (
      <div className="wb-empty-state">
        <span className="wb-empty-state-text">Loading layout...</span>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="wb-execution-viewer">
        <ExecutionStatusBar
          execution={execution}
          onPause={onPause}
          onResume={onResume}
          onAbort={onAbort}
          onClear={onClear}
          isMutating={isMutating}
        />
        <div className="wb-execution-body">
          <WorkflowExecutionCanvas
            execution={execution}
            layout={mergedLayout}
            onSelectContext={setSelectedContextId}
          />
          <ExecutionInspectorPanel
            execution={execution}
            selectedContextId={selectedContextId}
            onDeselectContext={() => setSelectedContextId(null)}
            onAddTask={onAddTask}
            onUpdateTask={onUpdateTask}
            onRemoveTask={onRemoveTask}
            onReorderTask={onReorderTask}
            isMutating={isMutating}
          />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
