import { buildLifecycleSnapshot } from "../context-transitions";
import { resolveWorkflowDefinition } from "../resolve-config";
import { seedAssignment, TEST_AGENT_BACKENDS_CONFIG } from "../test-fixtures";
import type {
  GraphWorkflowCascadeContext,
  WorkflowSemanticDefinition,
} from "../definition-schemas";
import type {
  ExecutionMutationDecision as FixtureDecision,
  ExecutionMutationOutcome as FixtureOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
} from "@/lib/workflow-graph/execution-mutation";

import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ResolvedWorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { resolvedWorkflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { migrateRawDefinitionPlacement } from "@/lib/workflow-graph/placement-migration";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";

import type { TemplateTier } from "../template-library-service";
import { type GraphWorkflowExecutionSeed } from "../execution-repository";
import { buildExecutionProvenance } from "../execution-origin";

import { assertLoopFence } from "../loop-fence";

import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";

export interface InMemoryExecutionRepository {
  ensureArtifactsMaterialized(): Promise<GraphWorkflowExecution | null>;
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
    fence?: () => void,
  ): Promise<GraphWorkflowExecution>;
  archiveActive(
    projectPath: string,
    sessionName: string,
    audit?: { reason: string; actor: string | null },
    guard?: (execution: GraphWorkflowExecution) => boolean,
  ): Promise<GraphWorkflowArchiveOutcome>;
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
  mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>>;
}

export type CreateSeedCapture = {
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
  inputs: Record<string, string>;
  launchedTier: TemplateTier;
  ownerConversationId: string | null;
  liveSessionReadOnlyPinned: boolean;
};

export function createRepository(
  initialExecution: GraphWorkflowExecution | null = null,
): InMemoryExecutionRepository & {
  read(): GraphWorkflowExecution | null;

  createCalls: CreateSeedCapture[];
  archiveCalls: number;
} {
  let activeExecution = initialExecution;
  let lock: Promise<void> = Promise.resolve();

  const createCalls: CreateSeedCapture[] = [];
  let archiveCalls = 0;

  // The loop fence is checked before the synchronous reducer, inside the queue.
  const mutateActiveImpl = async <Value, Refusal>(
    _projectPath: string,
    _sessionName: string,
    fn: (execution: GraphWorkflowExecution) => FixtureDecision<Value, Refusal>,
  ): Promise<FixtureOutcome<Value, Refusal>> => {
    const previous = lock;
    let release = () => {};
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (!activeExecution) {
        throw new Error(
          "Session does not have an active graph workflow execution",
        );
      }
      // Mirror the production repository: reject a superseded loop generation's
      // write against the currently-persisted execution before the reducer runs.
      assertLoopFence(_projectPath, _sessionName, activeExecution);
      return applyFixtureMutation(activeExecution, fn, (next) => {
        activeExecution = next;
      });
    } finally {
      release();
    }
  };

  return {
    ensureArtifactsMaterialized: async () => null,

    async getActive() {
      return activeExecution;
    },
    async create(_projectPath, _sessionName, seed, fence) {
      // Where the real repository evaluates it: inside the reserving critical
      // section, before anything is installed. A fenced launch therefore leaves
      // no create call behind here either.
      fence?.();
      // The fake mirrors the real repository's provenance derivation rather
      // than inventing one, so a test that reads back `seedDefinitionId` is
      // reading the same rule production applies.
      const provenance = buildExecutionProvenance(
        seed.source,
        seed.executionId,
      );
      createCalls.push({
        definitionId: provenance.seedDefinitionId,
        definitionRevision: provenance.seedDefinitionRevision,
        executionId: seed.executionId,
        startedAt: seed.startedAt,
        inputs: seed.inputs,
        launchedTier: provenance.launchedTier,
        ownerConversationId: seed.ownerConversationId,
        liveSessionReadOnlyPinned: seed.liveSessionReadOnlyPinned ?? false,
      });
      activeExecution = createWorkflowExecution({
        id: seed.executionId,
        status:
          seed.definition.approvalRequired === true ? "pending" : "running",
        liveSessionReadOnlyPinned: seed.liveSessionReadOnlyPinned ?? false,
        origin: provenance.origin,
        launchDocument: seed.launchDocument,
        seedDefinitionId: provenance.seedDefinitionId,
        seedDefinitionRevision: provenance.seedDefinitionRevision,
        boundInputs: seed.inputs,
        launchedTier: provenance.launchedTier,
        ownerConversationId: seed.ownerConversationId,
        definitionApproval:
          seed.definition.approvalRequired === true
            ? { requestedAt: seed.startedAt, approvedAt: null }
            : null,
        workingDefinition: resolveSeedDefinition(seed.definition),
        startedAt: seed.startedAt,
      });
      activeExecution.machineSnapshot = buildLifecycleSnapshot(
        activeExecution,
        { hasLiveIteration: false },
      );
      return activeExecution;
    },
    async archiveActive(): Promise<GraphWorkflowArchiveOutcome> {
      archiveCalls += 1;
      const archived = activeExecution;
      activeExecution = null;
      return archived === null
        ? { archived: false, reason: "no_active" }
        : { archived: true, execution: archived };
    },
    async update(_projectPath, _sessionName, execution) {
      activeExecution = execution;
    },
    mutateActive: mutateActiveImpl,
    read() {
      return activeExecution;
    },

    createCalls,
    get archiveCalls() {
      return archiveCalls;
    },
  };
}

/**
 * The default three-context chain re-authored onto ONE lane — a lane GROUP.
 * Sequential reuse is declared by that shared lane name: the first member to
 * run provisions the worktree, and the members after it inherit it.
 */
export function sharedLaneDefinition(): ResolvedWorkflowSemanticDefinition {
  const base = createResolvedWorkflowDefinition();
  return {
    ...base,
    executionContexts: base.executionContexts.map((context) => ({
      ...context,
      placement: { lane: "delivery", mode: "full" as const },
    })),
  };
}

/**
 * Place the named contexts onto one lane, leaving every other context as
 * authored. Lane REUSE is what a shared placement buys, so a test that expects a
 * downstream to land in an upstream's worktree has to say so in the definition.
 */
export function withContextsOnLane(
  definition: ResolvedWorkflowSemanticDefinition,
  lane: string,
  contextIds: readonly string[],
): ResolvedWorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      contextIds.includes(context.id)
        ? { ...context, placement: { lane, mode: "full" as const } }
        : context,
    ),
  };
}

/**
 * A pre-placement definition as its stored-load boundary hands it to the parse:
 * the field stripped the way a legacy document has it, repaired by the same
 * transformer every real load runs, then strictly parsed. The lane name under
 * test is therefore chosen by production, not written by the test.
 */
export function inflatePrePlacement(
  definition: ResolvedWorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  const raw = {
    ...structuredClone(definition),
    executionContexts: definition.executionContexts.map(
      ({ placement: _placement, ...context }) => context,
    ),
  };
  migrateRawDefinitionPlacement(raw);
  return resolvedWorkflowSemanticDefinitionSchema.parse(raw);
}

/** Rename a context everywhere a definition addresses it. */
export function renameContext(
  definition: ResolvedWorkflowSemanticDefinition,
  from: string,
  to: string,
): ResolvedWorkflowSemanticDefinition {
  return {
    ...definition,
    executionContexts: definition.executionContexts.map((context) =>
      context.id === from ? { ...context, id: to } : context,
    ),
    tasks: definition.tasks.map((task) =>
      task.contextId === from ? { ...task, contextId: to } : task,
    ),
    edges: definition.edges.map((edge) => ({
      ...edge,
      ...(edge.sourceContextId === from ? { sourceContextId: to } : {}),
      ...(edge.targetContextId === from ? { targetContextId: to } : {}),
    })),
  };
}

/** Rename a context everywhere a definition addresses it. */
export function renameContextState(
  contextStates: GraphWorkflowExecution["contextStates"],
  from: string,
  to: string,
): GraphWorkflowExecution["contextStates"] {
  const { [from]: renamed, ...rest } = contextStates;
  if (renamed === undefined) return contextStates;
  return { ...rest, [to]: { ...renamed, contextId: to } };
}

function resolveSeedDefinition(
  definition: WorkflowSemanticDefinition,
): ResolvedWorkflowSemanticDefinition {
  const cascade = resolveWorkflowDefinition(
    {
      baseDir: "/repo",
      ignorePatterns: [],
      defaultAgentBackend: "claude",
      agentBackends: TEST_AGENT_BACKENDS_CONFIG,
    },
    definition,
  );
  const seedContext = (context: GraphWorkflowCascadeContext) => ({
    ...context,
    implementer: seedAssignment(context.implementer),
    contextValidator: {
      ...context.contextValidator,
      assignments: context.contextValidator.assignments.map((assignment) =>
        seedAssignment(assignment),
      ),
    },
  });
  const { loopGroups, ...withoutLoops } = cascade;
  return {
    ...withoutLoops,
    executionContexts: cascade.executionContexts.map(seedContext),
    ...(loopGroups
      ? {
          loopGroups: loopGroups.map((group) => ({
            ...group,
            template: {
              ...group.template,
              contexts: group.template.contexts.map(seedContext),
            },
          })),
        }
      : {}),
  };
}
