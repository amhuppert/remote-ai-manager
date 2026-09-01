"use client";

import { ConfigPanel } from "@/components/workflow-config-panel/ConfigPanel";
import type { ConfigCascadeEditor } from "@/components/workflow-config-panel/cascade-editor";
import { cascadeScreens } from "@/components/workflow-config-panel/cascade-screens";
import {
  applyConfigEditToContext,
  applyConfigEditToWorkflowConfig,
  createConfigCascade,
  overrideCountLabel,
} from "@/components/workflow-config-panel/config-cascade";
import {
  buildContextRootCards,
  buildWorkflowRootCards,
  type ConfigParameterSummary,
} from "@/components/workflow-config-panel/root-cards";
import { createConfigScreenRegistry } from "@/components/workflow-config-panel/screen-registry";
import type {
  ContextStructuralEditor,
  WorkflowStructuralEditor,
} from "@/components/workflow-config-panel/structural-editor";
import {
  contextStructuralScreens,
  workflowStructuralScreens,
} from "@/components/workflow-config-panel/structural-screens";
import type { ConfigScope } from "@/components/workflow-config-panel/types";
import { lintOutputSchemaText } from "@/components/workflow-config/OutputSchemaField";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { useValidationCommandOptions } from "@/lib/validation/queries";
import { setContextOutputSchema } from "@/lib/workflow-graph/builder-draft";
import { resolveDefinitionUpstreamInputs } from "@/lib/workflow-graph/context-outputs";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import {
  resolveOutputSchemaText,
  serializeOutputSchemaText,
} from "./output-schema-drafts";

/**
 * The builder's mount of the shared configuration panel.
 *
 * The panel owns the screens; this host owns the DRAFT. Every screen hands back
 * a whole value (a context, a task list, a charter) or a cascade intent, and
 * this component writes it into the builder store — which is why fields no
 * screen exposes round-trip verbatim, and why promoting one collaboration field
 * or one validation role cannot carry its siblings.
 */

/** A request to open the panel at one screen path, from a validation row. */
export interface BuilderConfigPanelFocus {
  /**
   * Changes on every request, including a repeat of the same path. The panel's
   * navigation stack is internal state, so a deep link remounts it — a second
   * click on the same error has to re-open it, not do nothing.
   */
  requestId: number;
  screenPath: readonly string[];
}

interface BuilderConfigPanelProps {
  workflowName: string;
  scope: ConfigScope;
  onScopeChange: (scope: ConfigScope) => void;
  globalDefaults?: WorkflowDefaults;
  /** Builder scope: registry source for command multi-selects (null = global). */
  projectName?: string | null;
  /** Scopes the agent-profile listing the assignment pickers offer. */
  libraryProjectName?: string | null;
  onDeleteContext: (contextId: string) => void;
  focus?: BuilderConfigPanelFocus | null;
  readOnly?: boolean;
}

function replaceContext(
  definition: WorkflowSemanticDefinition,
  next: GraphWorkflowExecutionContextDefinition,
): WorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      context.id === next.id ? next : context,
    ),
  };
}

function orderedTasks(
  tasks: readonly GraphWorkflowTaskDefinition[],
): GraphWorkflowTaskDefinition[] {
  return [...tasks].sort((left, right) => left.order - right.order);
}

function contextMeta(context: GraphWorkflowExecutionContextDefinition): string {
  const grade =
    context.placement.mode === "owned"
      ? `owning · ${context.placement.ownedPaths.join(", ")}`
      : context.placement.mode === "full"
        ? "full"
        : "read-only";
  return [context.id, `lane ${context.placement.lane}`, grade].join(" · ");
}

function parameterSummaries(
  definition: WorkflowSemanticDefinition,
): ConfigParameterSummary[] {
  return definition.parameters.map((parameter) => ({
    id: parameter.name,
    type: parameter.type,
    required: parameter.required,
    defaultValue: parameter.default ?? null,
  }));
}

export default function BuilderConfigPanel({
  workflowName,
  scope,
  onScopeChange,
  globalDefaults,
  projectName,
  libraryProjectName,
  onDeleteContext,
  focus,
  readOnly = false,
}: BuilderConfigPanelProps): React.JSX.Element {
  const draftDefinition = _useGraphWorkflowBuilderStore(
    (state) => state.draftDefinition,
  );
  const selectedContextId = _useGraphWorkflowBuilderStore(
    (state) => state.selectedContextId,
  );
  const updateDefinition = _useGraphWorkflowBuilderStore(
    (state) => state.updateDefinition,
  );
  const pendingOutputSchemaText = _useGraphWorkflowBuilderStore(
    (state) => state.pendingOutputSchemaText,
  );
  const setPendingOutputSchemaText = _useGraphWorkflowBuilderStore(
    (state) => state.setPendingOutputSchemaText,
  );
  const validationCommands = useValidationCommandOptions(projectName ?? null);

  const context =
    draftDefinition?.executionContexts.find(
      (entry) => entry.id === selectedContextId,
    ) ?? null;
  // Nothing selected has no context tier to edit, so the panel stays on the
  // workflow scope until a node is picked (README §5).
  const effectiveScope: ConfigScope = context === null ? "workflow" : scope;

  const persistedSchemaText = serializeOutputSchemaText(context?.outputSchema);
  // The author's own text is draft state, not screen state: this panel is
  // remounted by every deep link and unmounted by a rail collapse, and neither
  // is an instruction to throw away what they typed.
  const schemaText = resolveOutputSchemaText(
    persistedSchemaText,
    selectedContextId === null
      ? undefined
      : pendingOutputSchemaText[selectedContextId],
  );

  const cascade = createConfigCascade({
    scope: effectiveScope,
    globalDefaults: globalDefaults ?? SEEDED_WORKFLOW_DEFAULTS,
    workflowConfig: draftDefinition?.workflowConfig ?? {},
    ...(effectiveScope === "context" && context !== null ? { context } : {}),
  });

  function handleSchemaTextChange(next: string): void {
    const contextId = selectedContextId;
    if (!draftDefinition || contextId === null) return;
    const lint = lintOutputSchemaText(next);
    if (lint.schema !== null) {
      setPendingOutputSchemaText(contextId, {
        text: next,
        committed: serializeOutputSchemaText(lint.schema),
      });
      updateDefinition(
        setContextOutputSchema(draftDefinition, contextId, lint.schema),
      );
      return;
    }
    if (lint.stage === "empty") {
      setPendingOutputSchemaText(contextId, { text: next, committed: "" });
      updateDefinition(
        setContextOutputSchema(draftDefinition, contextId, null),
      );
      return;
    }
    // Neither parseable nor empty: it stays text. The draft keeps the last
    // acceptable document — which is exactly why the toolbar refuses the save
    // rather than persisting it under fresh red text — and the entry records
    // that document, so a later change to it retires this text as stale.
    setPendingOutputSchemaText(contextId, {
      text: next,
      committed: persistedSchemaText,
    });
  }

  const cascadeEditor: ConfigCascadeEditor = {
    host: "builder",
    affordance: readOnly ? "read-only" : "editable",
    cascade,
    onEdit: (intent) => {
      if (!draftDefinition) return;
      if (effectiveScope === "context" && context !== null) {
        updateDefinition(
          replaceContext(
            draftDefinition,
            applyConfigEditToContext(intent, context),
          ),
        );
        return;
      }
      updateDefinition({
        ...draftDefinition,
        workflowConfig: applyConfigEditToWorkflowConfig(
          intent,
          draftDefinition.workflowConfig ?? {},
        ),
      });
    },
    validationCommands,
    libraryProjectName: libraryProjectName ?? null,
  };

  if (!draftDefinition) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-bg-surface font-mono text-[0.72rem] text-text-tertiary">
        No draft loaded
      </div>
    );
  }

  const contextTasks =
    context === null
      ? []
      : orderedTasks(
          draftDefinition.tasks.filter((task) => task.contextId === context.id),
        );

  const contextEditor: ContextStructuralEditor | null =
    context === null
      ? null
      : {
          host: "builder",
          affordance: readOnly ? "read-only" : "editable",
          context,
          onContextChange: (next) =>
            updateDefinition(replaceContext(draftDefinition, next)),
          outputSchemaText: schemaText,
          onOutputSchemaTextChange: handleSchemaTextChange,
          upstreamInputs: resolveDefinitionUpstreamInputs(
            draftDefinition,
            context.id,
          ),
          tasks: contextTasks,
          workflowTaskIds: draftDefinition.tasks.map((task) => task.id),
          onTasksChange: (next) =>
            updateDefinition({
              ...draftDefinition,
              tasks: [
                ...draftDefinition.tasks.filter(
                  (task) => task.contextId !== context.id,
                ),
                ...next,
              ],
            }),
          onDeleteContext: () => onDeleteContext(context.id),
        };

  const workflowEditor: WorkflowStructuralEditor = {
    affordance: readOnly ? "read-only" : "editable",
    charter: draftDefinition.charter,
    onCharterChange: (next) =>
      updateDefinition({ ...draftDefinition, charter: next }),
    parameters: draftDefinition.parameters,
    onParametersChange: (next) =>
      updateDefinition({ ...draftDefinition, parameters: next }),
    contexts: draftDefinition.executionContexts.map((entry) => ({
      id: entry.id,
      title: entry.title,
    })),
  };

  const screens = createConfigScreenRegistry([
    ...(contextEditor !== null && effectiveScope === "context"
      ? contextStructuralScreens(contextEditor)
      : workflowStructuralScreens(workflowEditor)),
    ...cascadeScreens(cascadeEditor),
  ]);

  const rootCards =
    context !== null && effectiveScope === "context"
      ? buildContextRootCards({
          cascade,
          context,
          outputSchemaText: schemaText,
          upstreamInputCount: resolveDefinitionUpstreamInputs(
            draftDefinition,
            context.id,
          ).length,
          taskCount: contextTasks.length,
          nextTaskTitle: contextTasks[0]?.title ?? null,
        })
      : buildWorkflowRootCards({
          cascade,
          invariantCount: draftDefinition.charter.invariants?.length ?? 0,
          sourceCount: draftDefinition.charter.sourcesOfTruth.length,
          parameters: parameterSummaries(draftDefinition),
        });

  const contextCount = draftDefinition.executionContexts.length;

  return (
    <ConfigPanel
      // A deep link re-enters the panel at a screen; the navigation stack is
      // internal, so the request id remounts it rather than mutating it.
      key={focus?.requestId ?? "root"}
      host="builder"
      scope={effectiveScope}
      onScopeChange={onScopeChange}
      entityTitle={
        context !== null && effectiveScope === "context"
          ? context.title
          : workflowName
      }
      entityMeta={
        context !== null && effectiveScope === "context"
          ? contextMeta(context)
          : `${contextCount} ${contextCount === 1 ? "context" : "contexts"} · defaults every context inherits unless it overrides them`
      }
      overrideSummary={overrideCountLabel(cascade.counts())}
      hasOverrides={cascade.paths.some((path) => cascade.own(path))}
      rootCards={rootCards}
      screens={screens}
      {...(!readOnly
        ? { onResetAll: () => cascadeEditor.onEdit(cascade.resetAll()) }
        : {})}
      {...(focus ? { initialScreenPath: focus.screenPath } : {})}
    />
  );
}
