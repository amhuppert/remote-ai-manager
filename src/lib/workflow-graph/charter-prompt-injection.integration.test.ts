import { describe, expect, it } from "vitest";

import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";
import type { ValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowCascadeContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { renderCharterDigest } from "@/lib/workflow-graph/charter/render";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import {
  buildFollowUpPrompt,
  buildIterationPrompt,
} from "@/lib/workflow-graph/iteration-prompt";
import {
  buildContextValidationPrompt,
  buildValidatorOutputSchema,
  issueCriterionCitationFor,
} from "@/lib/workflow-graph/validator-runner";
import { criterionRecordsOf } from "@/lib/workflow-graph/criteria/criterion-records";
import type { ValidationPromptSelections } from "@/lib/workflow-graph/validation-prompt-section";

/**
 * Cross-builder integration test for charter prompt injection (task 5.2).
 *
 * Unlike the per-builder unit tests in iteration-prompt / validator-runner,
 * this exercises the REAL passthrough chain end-to-end: one charter-bearing
 * WorkflowSemanticDefinition is resolved through `resolveWorkflowDefinition`
 * (task 4.1), and the SAME resolved context's `charter` snapshot is fed to
 * BOTH prompt builders. The load-bearing guarantee here — invisible to the
 * per-builder unit tests — is that the implementer and validator of one
 * context embed byte-identical charter content (4.5).
 *
 * Pure, deterministic, no LLM, no mocks: the production builders are pure
 * functions and the resolver is pure config plumbing.
 */

const GLOBAL_DEFAULTS: WorkflowDefaults = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  },
  contextValidator: {
    enabled: true,
    assignments: [
      {
        id: "general",
        profile: { tier: "builtin", id: "general-reviewer" },
        strategy: "conversation",
        authority: "blocking",
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        continuity: { enabled: true },
      },
    ],
  },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
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
  agentValidation: {
    implementer: { mode: "all", except: [] },
    contextValidator: { mode: "only", commands: [] },
  },
  laneMergeValidation: {
    strategy: "final-only",
    commands: { mode: "project" },
  },
};

const EMPTY_VALIDATION_SELECTIONS = {
  registry: "none",
  enabled: { kind: "commands", commands: [] },
  disabled: [],
  scriptGate: { kind: "off" },
} satisfies ValidationPromptSelections;

const GLOBAL_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  agentBackends: {
    claude: {
      model: "opus",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    },
    codex: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: false,
      timeoutMs: null,
    },
    cursor: { model: "composer-2.5", timeoutMs: null },
  },
  defaultAgentBackend: "claude",
  workflowDefaults: GLOBAL_DEFAULTS,
};

const VALIDATOR: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin", id: "general-reviewer" },
  strategy: "conversation",
  authority: "blocking",
  agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
  continuity: { enabled: true },
};

const TASKS: GraphWorkflowTaskDefinition[] = [
  {
    id: "task-1",
    contextId: "ctx-1",
    order: 1,
    title: "Implement the thing",
    instructions: "Do the work and call complete_task.",
    source: "user",
  },
];

function makeTaskState(
  overrides: Partial<GraphWorkflowTaskState> = {},
): GraphWorkflowTaskState {
  return {
    taskId: "task-1",
    contextId: "ctx-1",
    order: 1,
    status: "completed",
    summary: "Did the work.",
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

const TASK_STATES: Record<string, GraphWorkflowTaskState> = {
  "task-1": makeTaskState(),
};

const CHARTER_DOC_ENTRY: GraphWorkflowSharedDocumentEntry = {
  id: "charter-doc",
  relativePath: ".cc/graph-workflow-docs/charter.md",
  description: "The workflow charter",
  readWhen: "On demand for the full charter",
  kind: "charter",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  lastUpdatedByConversationId: null,
};

const GENERIC_DOC_ENTRY: GraphWorkflowSharedDocumentEntry = {
  id: "api-notes",
  relativePath: "docs/api-notes.md",
  description: "Notes on the API surface",
  readWhen: "Before touching the API layer",
  kind: "shared",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  lastUpdatedByConversationId: null,
};

function makeDefinition(): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter({
      mission: "Resolve every source conflict identically across all agents",
    }),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Build the feature",
        description: "Implement the core behavior",
        acceptanceCriteria: "The feature works and is covered by tests.",
        placement: { lane: "ctx-1", mode: "full" },
      },
    ],
    tasks: TASKS,
    edges: [],
  };
}

/**
 * Resolve a real charter-bearing definition and return the single resolved
 * context — it carries `context.charter` via the task 4.1 passthrough, the
 * same snapshot both roles consume.
 */
function resolveSharedContext(): GraphWorkflowCascadeContext {
  const resolved = resolveWorkflowDefinition(GLOBAL_CONFIG, makeDefinition());
  const context = resolved.executionContexts[0];
  if (!context) {
    throw new Error("expected one resolved execution context");
  }
  return context;
}

// The role-specific instruction block that `renderCharterPromptSection`
// appends after the digest opens with this fixed pointer line. The digest is
// the shared charter content; everything from this line on is role-specific
// (the implementer adds a citation requirement, the validator adds nothing),
// so the charter region to compare for 4.5 is the slice that precedes this
// pointer.
const CHARTER_POINTER_LINE = "Full charter: read";

/**
 * Extract the rendered charter digest from a prompt: the `# Workflow Charter`
 * region up to (but excluding) the role-specific pointer/instruction block.
 * This is the genuine "charter content" boundary for 4.5 — role-specific
 * guidance that legitimately differs between implementer and validator is
 * deliberately excluded.
 */
function extractCharterDigestRegion(prompt: string): string {
  const start = prompt.indexOf("# Workflow Charter");
  expect(start).toBeGreaterThanOrEqual(0);
  const region = prompt.slice(start);
  const pointerAt = region.indexOf(CHARTER_POINTER_LINE);
  expect(pointerAt).toBeGreaterThanOrEqual(0);
  return region.slice(0, pointerAt).trimEnd();
}

describe("charter prompt injection (cross-builder integration)", () => {
  it("places the charter digest at the top of the implementer prompt and omits the charter from the generic document list (4.1, 4.3, 4.2)", () => {
    const context = resolveSharedContext();
    expect(context.charter).toBeDefined();

    const prompt = buildIterationPrompt({
      context,
      charter: context.charter,
      sharedDocuments: [CHARTER_DOC_ENTRY, GENERIC_DOC_ENTRY],
      tasks: TASKS,
      taskStates: TASK_STATES,
      allowAgentTaskAdd: false,
      contextValidationAcceptanceCriteria: context.acceptanceCriteria,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });

    // Digest opens the prompt (4.1, 4.3).
    expect(prompt.startsWith("# Workflow Charter")).toBe(true);

    // The generic "## Shared Documents" list carries the kind:"shared" doc but
    // NOT the kind:"charter" entry — the charter has its own top section (4.2).
    const sharedDocsIndex = prompt.indexOf("## Shared Documents");
    expect(sharedDocsIndex).toBeGreaterThanOrEqual(0);
    const sharedDocsSection = prompt.slice(sharedDocsIndex);
    expect(sharedDocsSection).toContain(GENERIC_DOC_ENTRY.relativePath);
    expect(sharedDocsSection).not.toContain(CHARTER_DOC_ENTRY.relativePath);
  });

  it("places the charter digest at the top of the validator prompt (4.2)", () => {
    const context = resolveSharedContext();

    const prompt = buildContextValidationPrompt({
      context,
      charter: context.charter,
      tasks: TASKS,
      taskStates: TASK_STATES,
      validator: VALIDATOR,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });

    expect(prompt.startsWith("# Workflow Charter")).toBe(true);
  });

  it("carries a compact charter reference on the follow-up prompt (4.4)", () => {
    const context = resolveSharedContext();

    const prompt = buildFollowUpPrompt({
      charter: context.charter,
      remainingTasks: TASKS,
      taskStates: { "task-1": makeTaskState({ status: "running" }) },
      attemptNumber: 2,
      maxAttempts: 5,
    });

    // The follow-up carries a pointer to the full charter and the precedence
    // reminder, not the full digest (it is re-seeded via buildIterationPrompt
    // on a fresh session).
    expect(prompt).toContain(".cc/graph-workflow-docs/charter.md");
    expect(prompt).toContain("charter");
    expect(prompt.startsWith("# Workflow Charter")).toBe(false);
  });

  it("embeds byte-identical charter content in the implementer and validator prompts of the same context (4.5)", () => {
    const context = resolveSharedContext();
    if (!context.charter) {
      throw new Error("resolved context must carry a charter");
    }

    const implementerPrompt = buildIterationPrompt({
      context,
      charter: context.charter,
      sharedDocuments: [CHARTER_DOC_ENTRY, GENERIC_DOC_ENTRY],
      tasks: TASKS,
      taskStates: TASK_STATES,
      allowAgentTaskAdd: false,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });
    const validatorPrompt = buildContextValidationPrompt({
      context,
      charter: context.charter,
      tasks: TASKS,
      taskStates: TASK_STATES,
      validator: VALIDATOR,
      validationSelections: EMPTY_VALIDATION_SELECTIONS,
    });

    // The shared digest both roles embed, computed from the SAME snapshot for
    // the SAME rendering context.
    const digest = renderCharterDigest(context.charter, context.id);
    expect(digest).toContain("# Workflow Charter");
    expect(digest).toContain("Resolve every source conflict identically");
    expect(implementerPrompt).toContain(digest);
    expect(validatorPrompt).toContain(digest);

    // The extracted digest region is byte-identical across roles — same
    // context.charter → identical charter content (4.5). Role-specific guidance
    // that legitimately differs (implementer citation requirement, external-
    // source note) lives after the pointer line and is excluded.
    const implementerDigestRegion =
      extractCharterDigestRegion(implementerPrompt);
    const validatorDigestRegion = extractCharterDigestRegion(validatorPrompt);
    expect(implementerDigestRegion).toBe(validatorDigestRegion);
    // Guard: the compared region is the real digest, not an empty/stub slice.
    expect(implementerDigestRegion).toBe(digest);
  });

  it("renders a scoped source only in the prompts of its own context, for both roles", () => {
    // Two-context definition with one source scoped to ctx-1: the resolver
    // passes the charter through to both contexts, and each role's production
    // builder renders the charter section for ITS context id — so ctx-2's
    // implementer and validator prompts must omit the scoped source.
    const definition: WorkflowSemanticDefinition = {
      ...makeDefinition(),
      charter: makeTestCharter({
        sourcesOfTruth: [
          {
            rank: 1,
            id: "design-doc",
            label: "Approved design document",
            type: "document",
            locator: ".kiro/specs/workflow-charter/design.md",
            description: "The authoritative architecture for this workflow",
          },
          {
            rank: 2,
            id: "feature-notes",
            label: "Feature-context notes",
            type: "document",
            locator: "docs/feature-notes.md",
            description: "References that only concern the feature context",
            appliesTo: { contextIds: ["ctx-1"] },
          },
        ],
      }),
      executionContexts: [
        {
          id: "ctx-1",
          title: "Build the feature",
          description: "Implement the core behavior",
          acceptanceCriteria: "The feature works and is covered by tests.",
          placement: { lane: "ctx-1", mode: "full" },
        },
        {
          id: "ctx-2",
          title: "Integrate the feature",
          description: "Wire the feature into the app",
          acceptanceCriteria: "The feature is reachable in production code.",
          placement: { lane: "ctx-2", mode: "full" },
        },
      ],
      edges: [
        {
          id: "edge-1",
          sourceContextId: "ctx-1",
          targetContextId: "ctx-2",
        },
      ],
    };

    const resolved = resolveWorkflowDefinition(GLOBAL_CONFIG, definition);
    const byId = new Map(
      resolved.executionContexts.map((ctx) => [ctx.id, ctx]),
    );
    const prompts = ["ctx-1", "ctx-2"].map((id) => {
      const ctx = byId.get(id);
      if (!ctx?.charter) {
        throw new Error(`resolved context ${id} must carry a charter`);
      }
      return {
        implementer: buildIterationPrompt({
          context: ctx,
          charter: ctx.charter,
          sharedDocuments: [],
          tasks: TASKS,
          taskStates: TASK_STATES,
          allowAgentTaskAdd: false,
          validationSelections: EMPTY_VALIDATION_SELECTIONS,
        }),
        validator: buildContextValidationPrompt({
          context: ctx,
          charter: ctx.charter,
          tasks: TASKS,
          taskStates: TASK_STATES,
          validator: VALIDATOR,
          validationSelections: EMPTY_VALIDATION_SELECTIONS,
        }),
      };
    });
    const [inScope, outOfScope] = prompts as [
      (typeof prompts)[number],
      (typeof prompts)[number],
    ];

    for (const role of ["implementer", "validator"] as const) {
      expect(inScope[role]).toContain("Feature-context notes");
      expect(outOfScope[role]).not.toContain("Feature-context notes");
      // The global source renders for every context.
      expect(inScope[role]).toContain("Approved design document");
      expect(outOfScope[role]).toContain("Approved design document");
    }
  });

  // The claims above are each pinned by a per-builder unit test, but only in
  // isolation and only over prose criteria. This proves them TOGETHER on the
  // prompt pair one resolved context actually dispatches: the same records-
  // shaped criteria and the same scoped charter reach an implementer and a
  // validator, and what each one may cite back is bound to that context.
  describe("the prompt pair a records-criteria, scoped-source context dispatches", () => {
    const SCOPED_SOURCE_LABEL = "Migration runbook";
    const GLOBAL_SOURCE_LABEL = "Repository engineering contract";
    const IN_SCOPE_ID = "ctx-migrate";
    const OUT_OF_SCOPE_ID = "ctx-publish";
    const CRITERIA = [
      {
        id: "backfill-idempotent",
        statement: "Re-running the backfill is a no-op.",
      },
      {
        id: "rollback-documented",
        statement: "Reverting the migration is documented.",
      },
    ];

    // The shared TASKS live in ctx-1, which this definition replaces; re-home
    // them so no task points at a context the graph does not declare.
    const SCOPED_TASKS: GraphWorkflowTaskDefinition[] = TASKS.map((task) => ({
      ...task,
      contextId: IN_SCOPE_ID,
    }));

    function makeScopedDefinition(): WorkflowSemanticDefinition {
      return {
        ...makeDefinition(),
        tasks: SCOPED_TASKS,
        charter: makeTestCharter({
          sourcesOfTruth: [
            {
              rank: 1,
              id: "agents-md",
              label: GLOBAL_SOURCE_LABEL,
              type: "document",
              locator: "AGENTS.md",
              description: "Repository-wide testing and typing rules.",
            },
            {
              rank: 2,
              id: "migration-runbook",
              label: SCOPED_SOURCE_LABEL,
              type: "document",
              locator: "docs/migration-runbook.md",
              description: "Backfill and rollback procedure for the migration.",
              appliesTo: { contextIds: [IN_SCOPE_ID] },
            },
          ],
        }),
        executionContexts: [
          {
            id: IN_SCOPE_ID,
            title: "Migrate the ledger",
            description: "Backfill the new columns",
            acceptanceCriteria: CRITERIA,
            placement: { lane: IN_SCOPE_ID, mode: "full" },
          },
          {
            id: OUT_OF_SCOPE_ID,
            title: "Publish the result",
            description: "Announce the migrated schema",
            acceptanceCriteria: [
              {
                id: "notice-sent",
                statement: "The change notice is published.",
              },
            ],
            placement: { lane: OUT_OF_SCOPE_ID, mode: "full" },
          },
        ],
        edges: [
          {
            id: "edge-1",
            sourceContextId: IN_SCOPE_ID,
            targetContextId: OUT_OF_SCOPE_ID,
          },
        ],
      };
    }

    function promptPairFor(contextId: string): {
      implementer: string;
      validator: string;
    } {
      const resolved = resolveWorkflowDefinition(
        GLOBAL_CONFIG,
        makeScopedDefinition(),
      );
      const context = resolved.executionContexts.find(
        (candidate) => candidate.id === contextId,
      );
      if (!context?.charter) {
        throw new Error(`resolved context ${contextId} must carry a charter`);
      }
      return {
        implementer: buildIterationPrompt({
          context,
          charter: context.charter,
          sharedDocuments: [CHARTER_DOC_ENTRY],
          tasks: SCOPED_TASKS,
          taskStates: TASK_STATES,
          allowAgentTaskAdd: false,
          validationSelections: EMPTY_VALIDATION_SELECTIONS,
          // The orchestrator's own wiring (iteration-orchestrator.ts): the
          // implementer is shown the criteria it will be judged against only
          // when a context validator will judge them, in their stored shape.
          contextValidationAcceptanceCriteria: context.contextValidator.enabled
            ? context.acceptanceCriteria
            : undefined,
        }),
        validator: buildContextValidationPrompt({
          context,
          charter: context.charter,
          tasks: SCOPED_TASKS,
          taskStates: TASK_STATES,
          validator: VALIDATOR,
          validationSelections: EMPTY_VALIDATION_SELECTIONS,
        }),
      };
    }

    it.each(["implementer", "validator"] as const)(
      "gives the %s only its own sources, numbered criterion records, and none of the retired governance text",
      (role) => {
        const prompt = promptPairFor(IN_SCOPE_ID)[role];

        expect(prompt).toContain(GLOBAL_SOURCE_LABEL);
        expect(prompt).toContain(SCOPED_SOURCE_LABEL);

        // Ordinal, id, statement — the one list shape a validator can cite an
        // id out of, in authored order.
        expect(prompt).toContain(
          "1. [backfill-idempotent] Re-running the backfill is a no-op.",
        );
        expect(prompt).toContain(
          "2. [rollback-documented] Reverting the migration is documented.",
        );

        // The prompt diet: history, access bookkeeping, and the retired
        // runtime precedence/deferral rule stay in charter.md.
        expect(prompt).not.toContain("Amendment log");
        expect(prompt).not.toContain("Access:");
        expect(prompt).not.toContain("Applying the source-of-truth hierarchy");
        expect(prompt.toLowerCase()).not.toContain("higher-ranked source");
      },
    );

    it.each(["implementer", "validator"] as const)(
      "withholds another context's scoped source from the %s while keeping the global one",
      (role) => {
        const prompt = promptPairFor(OUT_OF_SCOPE_ID)[role];

        expect(prompt).not.toContain(SCOPED_SOURCE_LABEL);
        expect(prompt).toContain(GLOBAL_SOURCE_LABEL);
        expect(prompt).toContain(
          "1. [notice-sent] The change notice is published.",
        );
      },
    );

    it("requires the acceptance seat to cite one of exactly this context's criterion ids", () => {
      const resolved = resolveWorkflowDefinition(
        GLOBAL_CONFIG,
        makeScopedDefinition(),
      );
      const context = resolved.executionContexts.find(
        (candidate) => candidate.id === IN_SCOPE_ID,
      );
      if (!context) throw new Error("expected the in-scope context");

      // The default blocking general-reviewer IS the acceptance seat, so the
      // requirement is derived the way a dispatch derives it, not asserted.
      expect(issueCriterionCitationFor(VALIDATOR)).toBe("required");

      const schema = buildValidatorOutputSchema({
        authority: VALIDATOR.authority,
        taskIds: SCOPED_TASKS.map((task) => task.id),
        criterionIds: criterionRecordsOf(context.acceptanceCriteria).map(
          (record) => record.id,
        ),
        issueCriterionCitation: issueCriterionCitationFor(VALIDATOR),
      });

      expect(schema).toMatchObject({
        properties: {
          issues: {
            items: {
              properties: {
                criterionId: {
                  type: "string",
                  enum: ["backfill-idempotent", "rollback-documented"],
                },
              },
              required: ["taskId", "criterionId", "title", "description"],
            },
          },
        },
      });
    });
  });
});
